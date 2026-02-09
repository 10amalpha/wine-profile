// /api/enrich-grapes.js — Grape enrichment via Claude AI (one batch per call)
// POST { offset: 0 } → processes 15 wines, returns { enriched, remaining, next_offset, done }

const SB_URL = 'https://bzpraigsuwgjgpnclcpd.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ6cHJhaWdzdXdnamdwbmNsY3BkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk1Mzk2NDEsImV4cCI6MjA4NTExNTY0MX0.tBtsac6Mq65BiG93MhYtn1KV8iOGpEpVdlD3tqShrzE';
const BATCH_SIZE = 15;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'No API key configured' });

  try {
    // Fetch wines missing grape data
    const winesRes = await fetch(
      `${SB_URL}/rest/v1/wines?select=id,name,region,country,grape,vintage,rating&or=(grape.is.null,grape.eq.,grape.eq.?)&order=id.asc&limit=1000`,
      { headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` } }
    );
    const toEnrich = await winesRes.json();

    if (!Array.isArray(toEnrich) || toEnrich.length === 0) {
      return res.status(200).json({ done: true, message: 'All wines have grape data', enriched: 0, remaining: 0 });
    }

    // Take one batch (always from start since we filter by missing grape)
    const batch = toEnrich.slice(0, BATCH_SIZE);

    const wineList = batch.map((w, i) =>
      `${i + 1}. "${w.name}" — Region: ${w.region || 'unknown'}, Country: ${w.country || 'unknown'}, Vintage: ${w.vintage || 'unknown'}`
    ).join('\n');

    const prompt = `You are a master sommelier. For each wine, identify the PRIMARY grape variety (single name, proper case).

Rules:
- Known appellations use dominant grape: Chianti→Sangiovese, Barolo→Nebbiolo, Chablis→Chardonnay, Rioja→Tempranillo, Champagne→Pinot Noir, Priorat→Garnacha, Brunello→Sangiovese, Amarone→Corvina, Valpolicella→Corvina, Barbaresco→Nebbiolo, Sauternes→Sémillon, Port→Touriga Nacional, Txakoli→Hondarrabi Zuri, Albariño=Albariño, Verdejo=Verdejo, Godello=Godello
- Blends: name the dominant grape
- If truly unknown: "Unknown"

Respond ONLY with valid JSON array: [{"idx":1,"grape":"GrapeName"}, ...]

Wines:
${wineList}`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const aiData = await aiRes.json();
    const text = aiData.content?.[0]?.text || '';
    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    let grapeResults;
    try {
      grapeResults = JSON.parse(jsonStr);
    } catch (e) {
      return res.status(500).json({ error: 'AI parse error', raw: text.slice(0, 300) });
    }

    // Update Supabase
    let updated = 0;
    const results = [];
    for (const r of grapeResults) {
      const wine = batch[r.idx - 1];
      if (!wine || !r.grape) continue;
      // Normalize: if AI says Unknown, still write it so we don't retry forever
      const grape = r.grape.trim();

      const upd = await fetch(
        `${SB_URL}/rest/v1/wines?id=eq.${wine.id}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': SB_KEY,
            'Authorization': `Bearer ${SB_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({ grape })
        }
      );

      if (upd.ok) {
        updated++;
        results.push({ name: wine.name, grape });
      }
    }

    const remaining = toEnrich.length - batch.length;
    return res.status(200).json({
      done: remaining <= 0,
      batch_size: batch.length,
      enriched: updated,
      remaining: Math.max(0, remaining),
      total_missing: toEnrich.length,
      results
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
