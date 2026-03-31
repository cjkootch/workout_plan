import { neon } from '@neondatabase/serverless';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });

  const sql = neon(process.env.DATABASE_URL);

  const [recentRows, overviewRows, bwRows, streakRows, settingsRows] = await Promise.all([
    sql`
      SELECT workout_date::text, day_key, exercise_name, weight::text, reps, done
      FROM workout_sets
      WHERE workout_date >= CURRENT_DATE - INTERVAL '3 weeks'
      ORDER BY workout_date DESC, day_key, exercise_name, set_index
    `,
    sql`
      SELECT
        COUNT(DISTINCT workout_date) AS total_days,
        COUNT(*) FILTER (WHERE done = true) AS total_sets,
        COALESCE(SUM(
          CASE WHEN done = true AND weight IS NOT NULL AND weight > 0
                AND reps ~ '^[0-9]+(\.[0-9]+)?$'
               THEN weight * reps::numeric ELSE 0 END
        ), 0)::bigint AS total_tonnage,
        MAX(workout_date)::text AS last_session_date
      FROM workout_sets
    `,
    sql`SELECT log_date::text AS date, weight::float AS weight FROM bodyweight_logs ORDER BY log_date DESC LIMIT 5`,
    sql`SELECT DISTINCT workout_date::text AS d FROM workout_sets WHERE done = true ORDER BY d DESC LIMIT 14`,
    sql`SELECT key, value FROM user_settings`,
  ]);

  const settings = Object.fromEntries(settingsRows.map(r => [r.key, r.value]));
  const phase = settings.phase || 'bulk';
  const overview = overviewRows[0];

  // Summarise recent sessions
  const sessions = {};
  recentRows.forEach(r => {
    if (!sessions[r.workout_date]) sessions[r.workout_date] = new Set();
    sessions[r.workout_date].add(r.day_key);
  });

  const sessionLines = Object.entries(sessions)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, days]) => `  ${date}: ${[...days].join(', ')}`)
    .join('\n');

  const latestBW = bwRows[0]?.weight;
  const bwTrend = bwRows.length >= 2
    ? (bwRows[0].weight - bwRows[bwRows.length - 1].weight).toFixed(1)
    : null;

  const daysSinceLastSession = overview.last_session_date
    ? Math.floor((Date.now() - new Date(overview.last_session_date).getTime()) / 86400000)
    : null;

  const prompt = `Cole's current training phase: ${phase.toUpperCase()}
Current bodyweight: ${latestBW ? latestBW + ' lbs' : 'unknown'}${bwTrend !== null ? ` (${bwTrend > 0 ? '+' : ''}${bwTrend} lbs over last ${bwRows.length} weigh-ins)` : ''}
Total sessions logged: ${overview.total_days}, total sets: ${overview.total_sets}
Last session: ${overview.last_session_date || 'unknown'} (${daysSinceLastSession !== null ? daysSinceLastSession + ' days ago' : 'unknown'})

Sessions last 3 weeks:
${sessionLines || '  (none)'}

Based on this data, give Cole 2–3 specific, actionable insights in bullet points. Each bullet should be concrete — reference actual numbers, gaps, or patterns. Keep it tight, no fluff. Start each bullet with a bold keyword like **Volume**, **Recovery**, **Streak**, **Phase**, etc.`;

  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: 'You are a direct, data-driven fitness coach. No disclaimers. Give specific observations based only on what the data shows.',
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!anthropicRes.ok) {
    return new Response(JSON.stringify({ insight: null }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  const data = await anthropicRes.json();
  return new Response(
    JSON.stringify({ insight: data.content[0].text }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}
