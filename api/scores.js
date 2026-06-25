// api/scores.js
// Vercel serverless function — proxies MLB Stats API to avoid CORS/sandbox issues.
// Deployed at: /api/scores?date=YYYY-MM-DD
// If no date param, defaults to today in ET.

export default async function handler(req, res) {
  // CORS headers — allow any origin so the app can call it from anywhere
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    // Resolve date: use query param or fall back to today in ET
    let date = req.query.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      date = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    }

    const mlbUrl = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=linescore`;
    const mlbRes = await fetch(mlbUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; MLBPoolTracker/1.0)",
        "Accept": "application/json",
      },
    });

    if (!mlbRes.ok) {
      res.status(mlbRes.status).json({ error: `MLB API returned ${mlbRes.status}`, date });
      return;
    }

    const data = await mlbRes.json();
    const finals = {};
    const live   = {};

    for (const game of (data.dates?.[0]?.games ?? [])) {
      const state    = game.status?.abstractGameState;
      const away     = game.teams?.away;
      const home     = game.teams?.home;
      const awayName = away?.team?.teamName ?? away?.team?.name ?? null;
      const homeName = home?.team?.teamName ?? home?.team?.name ?? null;
      const inning   = game.linescore?.currentInning   ?? null;
      const half     = game.linescore?.inningHalf       ?? null;


      if (state === "Final") {
        if (awayName && away?.score != null) finals[awayName] = away.score;
        if (homeName && home?.score != null) finals[homeName] = home.score;
      } else if (state === "Live") {
        if (awayName && away?.score != null)
          live[awayName] = { score: away.score, inning, half, opponent: homeName };
        if (homeName && home?.score != null)
          live[homeName] = { score: home.score, inning, half, opponent: awayName };
      }
    }

    // Past dates are immutable — cache for 24h. Today: 30s.
    const isToday = date === new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const cacheAge = isToday ? 30 : 86400;
    res.setHeader("Cache-Control", `s-maxage=${cacheAge}, stale-while-revalidate=${cacheAge * 2}`);
    res.status(200).json({
      date,
      totalGames: data.dates?.[0]?.totalGames ?? 0,
      finals,
      live,
    });
  } catch (err) {
    console.error("MLB proxy error:", err);
    res.status(500).json({ error: err.message });
  }
}
