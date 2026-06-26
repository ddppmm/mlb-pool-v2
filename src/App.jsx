import { useState, useEffect, useRef, useCallback, useMemo } from "react";

const POOL_TEAMS = [
  { team: "Angels",       owner: "EVAN"      },
  { team: "Astros",       owner: "MURPHY"    },
  { team: "Blue Jays",    owner: "FRANK WED" },
  { team: "Braves",       owner: "MIKE C."   },
  { team: "Brewers",      owner: "PETER"     },
  { team: "Cardinals",    owner: "DAN ARIAS" },
  { team: "Cubs",         owner: "EVAN"      },
  { team: "Diamondbacks", owner: "BORG"      },
  { team: "Dodgers",      owner: "ROB WED"   },
  { team: "Giants",       owner: "APRIL"     },
  { team: "Guardians",    owner: "BORG"      },
  { team: "Mariners",     owner: "MIKE C."   },
  { team: "Marlins",      owner: "JIMMY M."  },
  { team: "Mets",         owner: "DANNY T."  },
  { team: "Nationals",    owner: "CHRIS WED" },
  { team: "Athletics",    owner: "EVAN"      },
  { team: "Orioles",      owner: "DAVID WED" },
  { team: "Padres",       owner: "EVAN"      },
  { team: "Phillies",     owner: "TJ"        },
  { team: "Pirates",      owner: "BORG"      },
  { team: "Rangers",      owner: "EVAN"      },
  { team: "Red Sox",      owner: "SCOTT L."  },
  { team: "Reds",         owner: "MURPHY"    },
  { team: "Rockies",      owner: "DAVID WED" },
  { team: "Royals",       owner: "K.YOUNG"   },
  { team: "Rays",         owner: "FRANKIE"   },
  { team: "Tigers",       owner: "TOMMY"     },
  { team: "Twins",        owner: "JARED WED" },
  { team: "White Sox",    owner: "MATT WED"  },
  { team: "Yankees",      owner: "MARC"      },
];

const INITIAL_SCORES = {};

const ALL_RUNS  = Array.from({ length: 14 }, (_, i) => i);
const POLL_MS   = 60_000;

const TEAM_COLORS = {
  Angels: "#BA0021", Astros: "#EB6E1F", "Blue Jays": "#134A8E",
  Braves: "#CE1141", Brewers: "#FFC52F", Cardinals: "#C41E3A",
  Cubs: "#0E3386", Diamondbacks: "#A71930", Dodgers: "#005A9C",
  Giants: "#FD5A1E", Guardians: "#00385D", Mariners: "#0C2C56",
  Marlins: "#00A3E0", Mets: "#002D72", Nationals: "#AB0003",
  Athletics: "#003831", Orioles: "#DF4601", Padres: "#7B3F00",
  Phillies: "#E81828", Pirates: "#27251F", Rangers: "#003278",
  "Red Sox": "#BD3039", Reds: "#C6011F", Rockies: "#33006F",
  Royals: "#004687", Rays: "#092C5C", Tigers: "#0C2340",
  Twins: "#002B5C", "White Sox": "#555555", Yankees: "#003087",
};

// ── Run frequency: empirical prob of scoring exactly N runs in a game ──
// Source: Fangraphs/Retrosheet historical data, ~4.5 R/G era (2000-2024)
// Most common: 3 runs (13.4%), then 4 (12.9%), then 2 (12.1%)
// Rarest in pool: 13 (~0.4%) → expect ~250 games to hit it
const RUN_FREQ = {
  0: 0.073, 1: 0.103, 2: 0.122, 3: 0.134, 4: 0.129,
  5: 0.108, 6: 0.083, 7: 0.062, 8: 0.044, 9: 0.029,
  10: 0.018, 11: 0.011, 12: 0.006, 13: 0.004,
};

const EXP_GAMES = {}; // expected games to first hit each run value
ALL_RUNS.forEach(r => { EXP_GAMES[r] = Math.round(1 / RUN_FREQ[r]); });

// ── Deterministic win probability ────────────────────────────────────
// For each team, P(complete within G games) = product over missing values of
// (1 - (1-p)^G)  — the CDF of the max of independent geometric RVs.
// Win probability = integral over G of:
//   P(team completes on game G) * P(every other team NOT complete by game G)
// We sum this over G = 1..GAMES_LEFT discretely. Exact, no randomness.
const GAMES_LEFT = 145;

function pCompleteBy(missing, G) {
  // Probability ALL missing values have been hit at least once in G games
  let p = 1;
  for (const r of missing) {
    const pHit = RUN_FREQ[r] ?? 0.004;
    p *= (1 - Math.pow(1 - pHit, G));
  }
  return p;
}


// ── Expected games to complete ────────────────────────────────────────
// E[max of independent geometrics] via the formula:
// E[max] = sum_{G=0}^{inf} P(max > G) = sum_{G=0}^{inf} (1 - P(all done by G))
// We truncate at 500 games (well beyond any realistic season).
function expectedGamesToComplete(missing) {
  if (missing.length === 0) return 0;
  let expected = 0;
  // Sum P(not all done by G) for G = 0, 1, 2, ...
  // = sum (1 - product_r (1-(1-p_r)^G))
  // Truncate when contribution becomes negligible
  for (let G = 0; G < 600; G++) {
    const pDone = pCompleteBy(missing, G);
    expected += (1 - pDone);
    if (G > 50 && (1 - pDone) < 1e-6) break;
  }
  return Math.round(expected);
}


// ── Pool-level: expected games until SOMEONE wins ─────────────────────
// P(pool has a winner by game G) = 1 - P(NO team complete by G)
//   = 1 - product over all teams of (1 - P(team complete by G))
// E[days to winner] = sum_{G=0}^{inf} P(no winner yet by G)
function expectedDaysToWinner(scoresMap) {
  const allMissing = POOL_TEAMS.map(({ team }) => {
    const hit = new Set([...(scoresMap[team] || [])].filter(s => s >= 0 && s <= 13));
    return ALL_RUNS.filter(r => !hit.has(r));
  });

  // Check if already won
  if (allMissing.some(m => m.length === 0)) return 0;

  let expected = 0;
  for (let G = 0; G < 600; G++) {
    // P(no team done by G) = product of (1 - P(team done by G))
    let pNoWinner = 1;
    for (const missing of allMissing) {
      pNoWinner *= (1 - pCompleteBy(missing, G));
    }
    expected += pNoWinner;
    if (G > 30 && pNoWinner < 1e-6) break;
  }
  return Math.round(expected);
}

function calcWinProbs(scoresMap) {
  // Pre-compute missing list per team
  const teamMissing = {};
  for (const { team } of POOL_TEAMS) {
    const hit = new Set([...(scoresMap[team] || [])].filter(s => s >= 0 && s <= 13));
    teamMissing[team] = ALL_RUNS.filter(r => !hit.has(r));
  }

  const winProb = {};
  POOL_TEAMS.forEach(({ team }) => { winProb[team] = 0; });

  // For already-complete teams
  const doneTeams = POOL_TEAMS.filter(({ team }) => teamMissing[team].length === 0);
  if (doneTeams.length > 0) {
    // Split evenly among done teams (tiebreak — first to finish wins, but we don't track order)
    const share = 100 / doneTeams.length;
    doneTeams.forEach(({ team }) => { winProb[team] = Math.round(share * 10) / 10; });
    return winProb;
  }

  // Discrete sum: for each game G, compute P(team i finishes exactly on G AND leads all others)
  // P(finish on exactly G) = P(complete by G) - P(complete by G-1)
  // P(team wins on game G) = P(i finishes on G) * P(all others NOT done by G-1)
  // We accumulate over G = 1..GAMES_LEFT
  const prevComplete = {};
  POOL_TEAMS.forEach(({ team }) => { prevComplete[team] = 0; });

  for (let G = 1; G <= GAMES_LEFT; G++) {
    const curComplete = {};
    for (const { team } of POOL_TEAMS) {
      curComplete[team] = pCompleteBy(teamMissing[team], G);
    }

    for (const { team } of POOL_TEAMS) {
      // P(this team finishes on exactly game G)
      const pFinishOnG = curComplete[team] - prevComplete[team];
      if (pFinishOnG < 1e-10) continue;

      // P(all other teams not yet done by game G-1)
      let pOthersNotDone = 1;
      for (const { team: other } of POOL_TEAMS) {
        if (other === team) continue;
        pOthersNotDone *= (1 - prevComplete[other]);
      }

      winProb[team] += pFinishOnG * pOthersNotDone;
    }

    POOL_TEAMS.forEach(({ team }) => { prevComplete[team] = curComplete[team]; });
  }

  // Normalize to percentages, round to 1 decimal
  const total = Object.values(winProb).reduce((a, b) => a + b, 0);
  const out = {};
  POOL_TEAMS.forEach(({ team }) => {
    out[team] = total > 0 ? Math.round((winProb[team] / total) * 1000) / 10 : 0;
  });
  return out;
}

// ── Helpers ───────────────────────────────────────────────────────────
const allOwners = [...new Set(POOL_TEAMS.map(t => t.owner))].sort();
const ownerHues = {};
allOwners.forEach((o, i) => { ownerHues[o] = Math.round((i / allOwners.length) * 360); });

function buildMap(raw) {
  const m = {};
  POOL_TEAMS.forEach(({ team }) => { m[team] = new Set(raw[team] || []); });
  return m;
}

function resolveTeam(name) {
  if (!name) return null;
  const l = name.toLowerCase();
  return POOL_TEAMS.find(t => l.includes(t.team.toLowerCase()) || t.team.toLowerCase().includes(l))?.team ?? null;
}

function isGameHours() {
  const h = parseInt(new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }), 10);
  return h >= 12 || h <= 1;
}

function etToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

// All dates from pool start (April 17) through today in ET
// Use string arithmetic to avoid timezone shifting issues with Date parsing
function poolDates() {
  const POOL_START = "2026-06-26";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const dates = [];
  // Walk day by day using UTC dates (plain YYYY-MM-DD strings, no timezone shift)
  let cur = new Date(POOL_START + "T12:00:00Z"); // noon UTC = safe from any TZ shift
  const end = new Date(today     + "T12:00:00Z");
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

async function fetchMLB(date) {
  // In artifact: try the MLB API directly (will likely fail due to sandbox restrictions)
  // In Vercel deployment: change this to `/api/scores?date=${date}`
  const res = await fetch(`/api/scores?date=${date}`);
  if (!res.ok) { const b = await res.json().catch(()=>({})); throw new Error(b.error ?? `Proxy ${res.status}`); }
  const data = await res.json();
  // Proxy returns {finals, live, totalGames} with raw MLB team names - resolve to our names
  const finals = {}, live = {};
  Object.entries(data.finals ?? {}).forEach(([name, score]) => {
    const team = resolveTeam(name); if (team) finals[team] = score;
  });
  Object.entries(data.live ?? {}).forEach(([name, info]) => {
    const team = resolveTeam(name); if (team) live[team] = info;
  });
  return { finals, live, totalGames: data.totalGames ?? 0 };
}

// ── Win prob display helpers ──────────────────────────────────────────
function probBg(p)   { return p <= 0 ? "#1e293b" : p < 3 ? "#2d1515" : p < 8 ? "#2d1f0a" : p < 15 ? "#1a2d0a" : "#0d2d12"; }
function probFg(p)   { return p <= 0 ? "#334155" : p < 3 ? "#fca5a5" : p < 8 ? "#fcd34d" : p < 15 ? "#bef264" : "#86efac"; }
function probLabel(p){ return p <= 0 ? "<0.1%" : `${p}%`; }

function WinBadge({ prob, large }) {
  const bg = probBg(prob), fg = probFg(prob);
  return (
    <span style={{
      display: "inline-block", background: bg, color: fg,
      padding: large ? "3px 9px" : "2px 6px",
      borderRadius: 4, fontSize: large ? 12 : 11,
      fontWeight: 700, whiteSpace: "nowrap",
      border: `1px solid ${fg}22`,
      minWidth: large ? 52 : 44, textAlign: "center",
    }}>
      {large ? "🎯 " : ""}{probLabel(prob)}
    </span>
  );
}

// ── App ───────────────────────────────────────────────────────────────
export default function App() {
  const [scores,    setScores]    = useState(() => buildMap(INITIAL_SCORES));
  const [liveNow,   setLiveNow]   = useState({});
  const [tab,       setTab]       = useState("leaderboard");
  const [filter,    setFilter]    = useState("ALL");
  const [mTeam,     setMTeam]     = useState(POOL_TEAMS[0].team);
  const [mRun,      setMRun]      = useState("");
  const [toast,     setToast]     = useState(null);
  const [autoOn,    setAutoOn]    = useState(true);
  const [fetching,  setFetching]  = useState(false);
  const [lastFetch, setLastFetch] = useState(null);
  const [pollErr,   setPollErr]   = useState(null);
  const [countdown, setCountdown] = useState(null);
  const [flash,     setFlash]     = useState(new Set());

  const timerRef = useRef(null);
  const cdRef    = useRef(null);
  const nextAt   = useRef(null);

  const showToast = useCallback((msg, type = "ok") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const doFetch = useCallback(async (silent = false) => {
    setFetching(true); setPollErr(null);
    try {
      const { finals, live, totalGames } = await fetchMLB(etToday());
      setLiveNow(live);
      const newHits = [];
      setScores(prev => {
        const next = {};
        POOL_TEAMS.forEach(({ team }) => { next[team] = new Set([...(prev[team] || [])].filter(s => s >= 0 && s <= 13)); });
        Object.entries(finals).forEach(([team, score]) => {
          if (next[team] && score <= 13 && !next[team].has(score)) { next[team].add(score); newHits.push({ team, score }); }
        });
        return next;
      });
      setLastFetch(new Date());
      if (newHits.length > 0) {
        setFlash(new Set(newHits.map(h => h.team)));
        setTimeout(() => setFlash(new Set()), 5000);
        showToast(`🆕 ${newHits.map(h => `${h.team} → ${h.score}`).join(" · ")}`, "ok");
      } else if (!silent) {
        const lc = Object.keys(live).length, fc = Object.keys(finals).length;
        showToast(totalGames === 0 ? "No games today" : `${fc} finals · ${lc} live · no new scores`, "info");
      }
    } catch (e) {
      setPollErr(e.message);
      if (!silent) showToast(`⚠ ${e.message} — use Manual Entry to add scores`, "err");
    } finally { setFetching(false); }
  }, [showToast]);

  const schedule = useCallback(() => {
    clearTimeout(timerRef.current); clearInterval(cdRef.current);
    nextAt.current = Date.now() + POLL_MS;
    setCountdown(Math.round(POLL_MS / 1000));
    cdRef.current  = setInterval(() => setCountdown(Math.max(0, Math.round((nextAt.current - Date.now()) / 1000))), 1000);
    timerRef.current = setTimeout(async () => {
      clearInterval(cdRef.current);
      if (isGameHours()) await doFetch(true);
      schedule();
    }, POLL_MS);
  }, [doFetch]);

  // On startup: fetch all dates since pool start to catch up on missed days
  useEffect(() => {
    const catchUp = async () => {
      setFetching(true);
      const dates = poolDates();
      // Fetch all dates in parallel
      const results = await Promise.allSettled(dates.map(d => fetchMLB(d)));
      const allFinals = {};
      results.forEach(r => {
        if (r.status === "fulfilled") {
          Object.entries(r.value.finals).forEach(([team, score]) => {
            if (!allFinals[team]) allFinals[team] = new Set();
            if (score <= 13) allFinals[team].add(score);
          });
          // Set live from today's result (last date)
          if (r === results[results.length - 1]) setLiveNow(r.value.live);
        }
      });
      setScores(prev => {
        const next = {};
        POOL_TEAMS.forEach(({ team }) => {
          next[team] = new Set([...(prev[team] || []), ...(allFinals[team] || [])].filter(s => s >= 0 && s <= 13));
        });
        return next;
      });
      setLastFetch(new Date());
      setFetching(false);
    };
    catchUp().catch(() => setFetching(false));
    schedule();
    return () => { clearTimeout(timerRef.current); clearInterval(cdRef.current); };
  }, []); // eslint-disable-line

  const toggleAuto = () => {
    if (autoOn) { clearTimeout(timerRef.current); clearInterval(cdRef.current); setCountdown(null); setAutoOn(false); }
    else { setAutoOn(true); schedule(); }
  };

  const addManual = () => {
    const s = parseInt(mRun);
    if (isNaN(s) || s < 0 || s > 13) { showToast("Must be 0–13", "err"); return; }
    setScores(prev => ({ ...prev, [mTeam]: new Set([...prev[mTeam], s]) }));
    showToast(`✓ ${mTeam} scored ${s}`); setMRun("");
  };

  const removeScore = (team, run) =>
    setScores(prev => { const n = new Set(prev[team]); n.delete(run); return { ...prev, [team]: n }; });

  // ── Derived ───────────────────────────────────────────────────────
  const winProbs = useMemo(() => calcWinProbs(scores), [scores]);

  const teamStats = useMemo(() => {
    return POOL_TEAMS.map(({ team, owner }) => {
      const hit     = new Set([...(scores[team] || [])].filter(s => s >= 0 && s <= 13));
      const missing = ALL_RUNS.filter(r => !hit.has(r));
      return {
        team, owner, hit, missing,
        pct:     Math.round((hit.size / 14) * 100),
        done:    missing.length === 0,
        winProb:  winProbs[team] ?? 0,
        expGames: expectedGamesToComplete(missing),
      };
    }).sort((a, b) => {
      if (a.done !== b.done) return a.done ? -1 : 1;
      return b.winProb - a.winProb || b.hit.size - a.hit.size;
    });
  }, [scores, winProbs]);

  const runCoverage    = ALL_RUNS.map(r => ({ run: r, teams: POOL_TEAMS.filter(({ team }) => scores[team]?.has(r)) }));
  const daysToWinner   = useMemo(() => expectedDaysToWinner(scores), [scores]);
  const winner       = teamStats.find(t => t.done);
  const liveList     = Object.entries(liveNow);
  const displayTeams = filter === "ALL" ? POOL_TEAMS : POOL_TEAMS.filter(t => t.owner === filter);
  const cdPct        = (POLL_MS / 1000 - (countdown ?? 0)) / (POLL_MS / 1000) * 100;
  const fmtTime      = d => d?.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" }) ?? "—";
  const totalWinProb = Object.values(winProbs).reduce((a, b) => a + b, 0);

  return (
    <div style={S.wrap}>

      {/* HEADER */}
      <header style={S.hdr}>
        <div style={S.hdrL}>
          <span style={{ fontSize: 28 }}>⚾</span>
          <div>
            <div style={S.ttl}>13-Run Pool</div>
            <div style={S.sub}>MLB 2026 · Version 2 · Started June 26{daysToWinner > 0 ? ` · ${daysToWinner}g est. to win` : ""}</div>
          </div>
        </div>
        <div style={S.hdrR}>
          {winner && <div style={S.winBanner}>🏆 {winner.owner} · {winner.team}</div>}
          {liveList.length > 0 && <div style={S.livePill}><span style={S.liveDot}/>LIVE {liveList.length}</div>}
        </div>
      </header>

      {/* POLL BAR */}
      <div style={S.pollBar}>
        <div style={S.pollL}>
          <button style={{ ...S.autoBtn, ...(autoOn ? S.autoBtnOn : {}) }} onClick={toggleAuto}>
            {autoOn ? "⏸ Auto" : "▶ Auto"}
          </button>
          <button style={S.syncBtn} onClick={() => { doFetch(false); if (autoOn) schedule(); }} disabled={fetching}>
            <span style={fetching ? S.spin : {}}>{fetching ? "⟳" : "⟳"}</span>{fetching ? " …" : " Sync"}
          </button>
          {autoOn && countdown !== null && (
            <div style={S.cdWrap}>
              <span style={{ color: "#475569", fontSize: 11 }}>Next: <b style={{ color: "#60a5fa" }}>{countdown}s</b></span>
              <div style={S.cdTrack}><div style={{ ...S.cdFill, width: `${cdPct}%` }} /></div>
            </div>
          )}
        </div>
        <div style={S.pollR}>
          {pollErr && <span style={{ color: "#f87171", fontSize: 10 }}>⚠ {pollErr}</span>}
          {lastFetch && <span style={{ color: "#334155", fontSize: 10 }}>↻ {fmtTime(lastFetch)}</span>}
        </div>
      </div>

      {/* LIVE TICKER */}
      {liveList.length > 0 && (
        <div style={S.ticker}>
          <span style={S.tickLbl}>LIVE</span>
          {liveList.map(([team, g]) => (
            <span key={team} style={S.tickItem}>
              <span style={{ ...S.dot, background: TEAM_COLORS[team] || "#888" }} />
              <b>{team}</b> {g.score}
              <span style={{ color: "#64748b", fontSize: 10 }}> {g.half?.slice(0,3)}{g.inning}</span>
            </span>
          ))}
        </div>
      )}

      {/* TABS */}
      <div style={S.tabRow}>
        {[["leaderboard","🏅 Leaderboard"],["grid","📊 Grid"],["manual","✏️ Manual"]].map(([id, lbl]) => (
          <button key={id} style={{ ...S.tabBtn, ...(tab === id ? S.tabOn : {}) }} onClick={() => setTab(id)}>{lbl}</button>
        ))}
      </div>

      {/* ══ LEADERBOARD ══ */}
      {tab === "leaderboard" && (
        <div style={S.body}>
          <div style={S.modelNote}>
            📊 <strong>Win %</strong> uses exact math from historical MLB run frequencies. Scores of 3–5 are most common (~13% each). Scores of 0, 11, 12, 13 are rare. Header shows estimated games until the pool has a winner across all 30 teams.
          </div>
          <div style={S.cardGrid}>
            {teamStats.map((t, idx) => {
              const hue     = ownerHues[t.owner];
              const lg      = liveNow[t.team];
              const isFlash = flash.has(t.team);
              return (
                <div key={t.team} style={{
                  ...S.card,
                  borderLeftColor: t.done ? "#22c55e" : `hsl(${hue},55%,40%)`,
                  background: isFlash ? "#0a2010" : "#0b1828",
                }}>
                  {/* Card header */}
                  <div style={S.cardHdr}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#1e293b", minWidth: 24 }}>#{idx+1}</span>
                    <span style={{ ...S.dot, background: TEAM_COLORS[t.team] || "#555", width: 10, height: 10 }} />
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#f1f5f9", flex: 1 }}>{t.team}</span>
                    <span style={{ ...S.ownerTag, background: `hsl(${hue},45%,22%)`, border: `1px solid hsl(${hue},45%,35%)`, fontSize: 10 }}>{t.owner}</span>
                    {lg && <span style={S.liveScore}>{lg.score}<span style={{ fontSize: 9, color: "#64748b" }}> {lg.half?.slice(0,3)}{lg.inning}</span></span>}
                    {isFlash && <span style={S.newTag}>NEW</span>}
                  </div>

                  {/* Win prob + progress */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <WinBadge prob={t.winProb} large />
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                        <span style={{ fontSize: 10, color: "#475569" }}>{t.hit.size}/14 scores</span>
                        <span style={{ fontSize: 10, color: "#facc15", fontWeight: 700 }}>{t.pct}%</span>
                      </div>
                      <div style={S.prog}>
                        <div style={{ ...S.progFill, width: `${t.pct}%`, background: t.done ? "#22c55e" : `hsl(${hue},60%,44%)` }} />
                      </div>
                      {!t.done && idx === 0 && (
                        <div style={{ marginTop: 4, fontSize: 10 }}>
                          <span style={{ color: "#facc15", fontWeight: 700 }}>🏃 leader</span>
                          <span style={{ color: "#94a3b8" }}> · {daysToWinner}g est. to win</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Run pills */}
                  <div style={{ display: "flex", gap: 3, flexWrap: "wrap", marginBottom: 6 }}>
                    {ALL_RUNS.map(r => {
                      const isHit  = t.hit.has(r);
                      const isLive = lg && lg.score === r && !isHit;
                      return (
                        <span key={r} title={isHit ? `✓ scored ${r}` : `~${EXP_GAMES[r]}g avg`} style={{
                          width: 20, height: 20, borderRadius: 3, fontSize: 9, fontWeight: 700,
                          display: "flex", alignItems: "center", justifyContent: "center",
                          background: isHit ? `hsl(${hue},55%,32%)` : isLive ? "#451a03" : "#131f30",
                          color:      isHit ? "#fff" : isLive ? "#fde68a" : "#2d3f55",
                          border:     isLive ? "1px solid #f59e0b" : "none",
                        }}>{r}</span>
                      );
                    })}
                  </div>

                  {t.done && <div style={{ color: "#22c55e", fontSize: 11, fontWeight: 700 }}>🏆 ALL 14 COMPLETE!</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ══ GRID ══ */}
      {tab === "grid" && (
        <div style={S.body}>
          <div style={S.filterRow}>
            <span style={{ fontSize: 10, color: "#475569" }}>Owner:</span>
            {["ALL", ...allOwners].map(o => (
              <button key={o} style={{ ...S.chip, ...(filter === o ? S.chipOn : {}) }} onClick={() => setFilter(o)}>{o}</button>
            ))}
          </div>
          <div style={S.tblWrap}>
            <table style={S.tbl}>
              <thead>
                <tr>
                  <th style={{ ...S.th, textAlign: "left", minWidth: 105 }}>Team</th>
                  <th style={{ ...S.th, textAlign: "left", minWidth: 95 }}>Owner</th>
                  {ALL_RUNS.map(r => (
                    <th key={r} style={{ ...S.th, fontSize: 10 }} title={`Avg ${EXP_GAMES[r]} games to hit`}>{r}</th>
                  ))}
                  <th style={S.th}>✓</th>
                  <th style={{ ...S.th, minWidth: 52 }}>Win%</th>
                  <th style={{ ...S.th, minWidth: 55 }}>Live</th>
                </tr>
              </thead>
              <tbody>
                {displayTeams.map(({ team, owner }) => {
                  const hit  = new Set([...(scores[team] || [])].filter(s => s >= 0 && s <= 13));
                  const hue  = ownerHues[owner];
                  const lg   = liveNow[team];
                  const wp   = winProbs[team] ?? 0;
                  const isF  = flash.has(team);
                  return (
                    <tr key={team} style={{ ...S.tr, background: isF ? "rgba(34,197,94,0.06)" : "transparent" }}>
                      <td style={{ ...S.td, textAlign: "left" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                          <span style={{ ...S.dot, background: TEAM_COLORS[team] || "#555" }} />
                          <span style={{ fontSize: 11, whiteSpace: "nowrap" }}>{team}</span>
                          {isF && <span style={S.newTag}>NEW</span>}
                        </div>
                      </td>
                      <td style={{ ...S.td, textAlign: "left" }}>
                        <span style={{ ...S.ownerTag, background: `hsl(${hue},45%,22%)`, border: `1px solid hsl(${hue},45%,35%)` }}>{owner}</span>
                      </td>
                      {ALL_RUNS.map(r => (
                        <td key={r} style={S.td}>
                          {hit.has(r)
                            ? <span style={{ color: "#22c55e", fontWeight: 700, fontSize: 12 }}>✓</span>
                            : lg?.score === r
                              ? <span style={{ color: "#f59e0b", fontSize: 10 }}>●</span>
                              : <span style={{ color: "#1a2535" }}>·</span>}
                        </td>
                      ))}
                      <td style={{ ...S.td, fontWeight: 700, color: "#facc15", fontSize: 11 }}>{hit.size}</td>
                      <td style={S.td}><WinBadge prob={wp} /></td>
                      <td style={S.td}>
                        {lg
                          ? <span style={{ color: "#fbbf24", fontSize: 10, fontWeight: 700 }}>{lg.score} <span style={{ color: "#475569" }}>{lg.half?.slice(0,3)}{lg.inning}</span></span>
                          : <span style={{ color: "#1a2535" }}>—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ══ MANUAL ══ */}
      {tab === "manual" && (
        <div style={S.body}>
          <div style={S.modelNote}>
            ℹ️ On Vercel, scores sync automatically from the MLB API. Use this tab to manually correct or add scores.
          </div>
          <h3 style={S.secHd}>Add Score</h3>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 28 }}>
            <select style={S.sel} value={mTeam} onChange={e => setMTeam(e.target.value)}>
              {POOL_TEAMS.map(({ team }) => <option key={team}>{team}</option>)}
            </select>
            <input style={S.inp} type="number" min={0} max={13} placeholder="0–13"
              value={mRun} onChange={e => setMRun(e.target.value)}
              onKeyDown={e => e.key === "Enter" && addManual()} />
            <button style={S.addBtn} onClick={addManual}>Add</button>
          </div>

          <h3 style={S.secHd}>All Recorded Scores</h3>
          <div style={S.tblWrap}>
            <table style={S.tbl}>
              <thead>
                <tr>
                  <th style={{ ...S.th, textAlign: "left" }}>Team</th>
                  <th style={{ ...S.th, textAlign: "left" }}>Owner</th>
                  <th style={{ ...S.th, textAlign: "left" }}>Scores hit</th>
                </tr>
              </thead>
              <tbody>
                {POOL_TEAMS.map(({ team, owner }) => {
                  const hit = [...(scores[team] || [])].filter(s => s >= 0 && s <= 13).sort((a, b) => a - b);
                  return (
                    <tr key={team} style={S.tr}>
                      <td style={{ ...S.td, textAlign: "left", fontSize: 11 }}>
                        <span style={{ ...S.dot, background: TEAM_COLORS[team] || "#555" }} /> {team}
                      </td>
                      <td style={{ ...S.td, textAlign: "left" }}>
                        <span style={{ ...S.ownerTag, background: `hsl(${ownerHues[owner]},45%,22%)`, border: `1px solid hsl(${ownerHues[owner]},45%,35%)` }}>{owner}</span>
                      </td>
                      <td style={{ ...S.td, textAlign: "left" }}>
                        <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                          {hit.map(r => (
                            <span key={r} style={S.ePill}>
                              {r} <button style={S.rmX} onClick={() => removeScore(team, r)}>×</button>
                            </span>
                          ))}
                          {hit.length === 0 && <span style={{ color: "#334155" }}>—</span>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TOAST */}
      {toast && (
        <div style={{ ...S.toast, background: toast.type === "err" ? "#7f1d1d" : toast.type === "info" ? "#1e3a5f" : "#14532d" }}>
          {toast.msg}
        </div>
      )}

      <style>{`
        @keyframes spin  { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
        * { box-sizing: border-box; }
        body { margin: 0; }
        tr:hover { background: rgba(255,255,255,0.02) !important; }
      `}</style>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────
const S = {
  wrap:      { fontFamily: "'IBM Plex Mono','Courier New',monospace", background: "#070e1a", minHeight: "100vh", color: "#e2e8f0", paddingBottom: 60 },
  hdr:       { display:"flex", alignItems:"center", justifyContent:"space-between", padding:"12px 18px", background:"#0a1525", borderBottom:"1px solid #1a2740", flexWrap:"wrap", gap:8 },
  hdrL:      { display:"flex", alignItems:"center", gap:10 },
  hdrR:      { display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" },
  ttl:       { fontSize:18, fontWeight:700, color:"#f1f5f9", letterSpacing:"-0.5px" },
  sub:       { fontSize:10, color:"#334155", marginTop:1 },
  winBanner: { background:"linear-gradient(90deg,#78350f,#92400e)", color:"#fef08a", padding:"4px 10px", borderRadius:5, fontWeight:700, fontSize:11 },
  livePill:  { display:"flex", alignItems:"center", gap:4, background:"#1a0a0a", border:"1px solid #dc2626", color:"#f87171", padding:"3px 8px", borderRadius:5, fontSize:11, fontWeight:700 },
  liveDot:   { width:6, height:6, borderRadius:"50%", background:"#ef4444", animation:"pulse 1.2s infinite" },
  pollBar:   { display:"flex", alignItems:"center", justifyContent:"space-between", padding:"6px 18px", background:"#060d18", borderBottom:"1px solid #0f172a", flexWrap:"wrap", gap:6 },
  pollL:     { display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" },
  pollR:     { display:"flex", alignItems:"center", gap:10 },
  autoBtn:   { color:"#64748b", background:"#1e293b", border:"1px solid #334155", padding:"4px 10px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"inherit", fontWeight:600 },
  autoBtnOn: { color:"#86efac", background:"#0a2015", border:"1px solid #16a34a" },
  syncBtn:   { color:"#93c5fd", background:"#0a1a30", border:"1px solid #2563eb", padding:"4px 10px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"inherit", fontWeight:600 },
  spin:      { display:"inline-block", animation:"spin 0.8s linear infinite" },
  cdWrap:    { display:"flex", alignItems:"center", gap:5 },
  cdTrack:   { width:60, height:3, background:"#1e293b", borderRadius:2, overflow:"hidden" },
  cdFill:    { height:3, background:"#3b82f6", borderRadius:2, transition:"width 1s linear" },
  ticker:    { display:"flex", alignItems:"center", gap:10, padding:"5px 18px", background:"#09121e", borderBottom:"1px solid #1a2740", overflowX:"auto" },
  tickLbl:   { fontSize:9, fontWeight:700, color:"#ef4444", border:"1px solid #ef4444", padding:"1px 4px", borderRadius:3, whiteSpace:"nowrap" },
  tickItem:  { display:"flex", alignItems:"center", gap:4, fontSize:11, whiteSpace:"nowrap", color:"#cbd5e1" },
  covBar:    { display:"flex", alignItems:"center", gap:4, padding:"7px 18px", background:"#060d18", borderBottom:"1px solid #0f172a", flexWrap:"wrap" },
  covPill:   { width:28, height:28, borderRadius:4, display:"flex", alignItems:"center", justifyContent:"center", cursor:"default" },
  tabRow:    { display:"flex", borderBottom:"1px solid #1a2740", padding:"0 18px", background:"#0a1525" },
  tabBtn:    { background:"none", border:"none", color:"#334155", padding:"9px 14px", cursor:"pointer", fontSize:12, fontFamily:"inherit", fontWeight:600, borderBottom:"2px solid transparent" },
  tabOn:     { color:"#60a5fa", borderBottom:"2px solid #3b82f6" },
  body:      { padding:"14px 18px" },
  modelNote: { fontSize:10, color:"#94a3b8", background:"#0a1525", border:"1px solid #1a2740", borderRadius:5, padding:"8px 12px", marginBottom:14, lineHeight:1.6 },
  filterRow: { display:"flex", alignItems:"center", gap:4, flexWrap:"wrap", marginBottom:10 },
  chip:      { background:"#1e293b", border:"1px solid #334155", color:"#475569", padding:"2px 8px", borderRadius:20, cursor:"pointer", fontSize:10, fontFamily:"inherit" },
  chipOn:    { background:"#1d4ed8", color:"#bfdbfe", borderColor:"#3b82f6" },
  tblWrap:   { overflowX:"auto", borderRadius:6, border:"1px solid #1a2740" },
  tbl:       { width:"100%", borderCollapse:"collapse", fontSize:11 },
  th:        { background:"#0a1525", color:"#334155", padding:"5px 7px", textAlign:"center", fontWeight:700, borderBottom:"1px solid #1a2740", whiteSpace:"nowrap", fontSize:10 },
  tr:        { borderBottom:"1px solid #0d1a2a" },
  td:        { padding:"4px 7px", textAlign:"center", verticalAlign:"middle" },
  dot:       { width:8, height:8, borderRadius:"50%", display:"inline-block", flexShrink:0 },
  ownerTag:  { padding:"1px 6px", borderRadius:3, fontSize:10, fontWeight:600, color:"#94a3b8", whiteSpace:"nowrap" },
  liveScore: { color:"#fbbf24", fontWeight:700, fontSize:10 },
  newTag:    { background:"#14532d", color:"#86efac", fontSize:8, padding:"1px 3px", borderRadius:3, fontWeight:700 },
  cardGrid:  { display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(290px,1fr))", gap:10 },
  card:      { background:"#0b1828", border:"1px solid #1a2740", borderLeftWidth:3, borderRadius:7, padding:12 },
  cardHdr:   { display:"flex", alignItems:"center", gap:6, marginBottom:8, flexWrap:"wrap" },
  prog:      { background:"#1a2740", borderRadius:3, height:4 },
  progFill:  { height:4, borderRadius:3, transition:"width 0.5s ease" },
  secHd:     { fontSize:11, fontWeight:700, color:"#334155", marginBottom:8, letterSpacing:1, textTransform:"uppercase" },
  sel:       { background:"#1e293b", border:"1px solid #334155", color:"#e2e8f0", padding:"5px 8px", borderRadius:4, fontSize:11, fontFamily:"inherit" },
  inp:       { background:"#1e293b", border:"1px solid #334155", color:"#e2e8f0", padding:"5px 8px", borderRadius:4, fontSize:11, fontFamily:"inherit", width:90 },
  addBtn:    { background:"#14532d", border:"1px solid #16a34a", color:"#86efac", padding:"5px 12px", borderRadius:4, cursor:"pointer", fontSize:11, fontFamily:"inherit", fontWeight:600 },
  ePill:     { background:"#1e293b", border:"1px solid #334155", padding:"1px 5px", borderRadius:3, fontSize:10, display:"flex", alignItems:"center", gap:2 },
  rmX:       { background:"none", border:"none", color:"#f87171", cursor:"pointer", fontSize:11, padding:0, fontFamily:"inherit" },
  toast:     { position:"fixed", bottom:14, right:14, padding:"9px 14px", borderRadius:6, color:"#fff", fontSize:12, fontWeight:600, zIndex:999, boxShadow:"0 4px 16px rgba(0,0,0,.7)", maxWidth:400 },
};
