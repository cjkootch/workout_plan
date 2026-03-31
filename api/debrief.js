import { neon } from '@neondatabase/serverless';

export const config = { runtime: 'edge' };

const DAY_NAMES = { day1: 'Push', day2: 'Pull', day3: 'Legs', day4: 'Upper Power', day5: 'Athletic' };

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  let body;
  try { body = await req.json(); } catch {
    return new Response('Bad request', { status: 400 });
  }
  const { dayId } = body;
  if (!dayId) return new Response('Bad request', { status: 400 });

  const sql = neon(process.env.DATABASE_URL);

  const [todayRows, prevRows, bwRows, rpeRows] = await Promise.all([
    sql`
      SELECT exercise_name, weight::float, reps, set_index, done
      FROM workout_sets
      WHERE workout_date = CURRENT_DATE AND day_key = ${dayId}
      ORDER BY exercise_name, set_index
    `,
    sql`
      WITH prev_date AS (
        SELECT MAX(workout_date) AS d
        FROM workout_sets
        WHERE day_key = ${dayId} AND done = true AND workout_date < CURRENT_DATE
      )
      SELECT ws.exercise_name, ws.weight::float, ws.reps, ws.set_index, ws.workout_date::text
      FROM workout_sets ws
      JOIN prev_date pd ON ws.workout_date = pd.d
      WHERE ws.day_key = ${dayId} AND ws.done = true
      ORDER BY ws.exercise_name, ws.set_index
    `,
    sql`SELECT weight::float AS weight FROM bodyweight_logs ORDER BY log_date DESC LIMIT 1`,
    sql`SELECT value FROM user_settings WHERE key = ${'rpe:' + new Date().toISOString().slice(0,10) + ':' + dayId} LIMIT 1`,
  ]);

  function groupByExercise(rows) {
    const out = {};
    rows.forEach(r => {
      if (!out[r.exercise_name]) out[r.exercise_name] = [];
      out[r.exercise_name].push(r);
    });
    return out;
  }

  const today    = groupByExercise(todayRows.filter(r => r.done));
  const prev     = groupByExercise(prevRows);
  const prevDate = prevRows[0]?.workout_date;
  const rpe      = rpeRows[0]?.value;

  const todaySummary = Object.entries(today).map(([ex, sets]) =>
    `- ${ex}: ${sets.map(s => `${s.weight}×${s.reps}`).join(', ')}`
  ).join('\n');

  const prevSummary = Object.entries(prev).map(([ex, sets]) =>
    `- ${ex}: ${sets.map(s => `${s.weight}×${s.reps}`).join(', ')}`
  ).join('\n');

  const prompt = `Cole just finished his ${DAY_NAMES[dayId] || dayId} session.

TODAY'S COMPLETED SETS:
${todaySummary || '(none logged)'}
${rpe ? `Session RPE: ${rpe}/10` : ''}

PREVIOUS SESSION ${prevDate ? '(' + prevDate + ')' : ''}:
${prevSummary || '(no previous data)'}

Bodyweight: ${bwRows[0]?.weight ? bwRows[0].weight + ' lbs' : 'unknown'}

Write a concise debrief in this exact format:

**Session grade:** [A/B/C/D] — [one-line reason]

**Hits & misses:**
- [2–3 bullets comparing today vs last session — note PRs, volume changes, reps missed]

**Next session targets:**
- [one bullet per main compound lift with exact weight × rep target using double progression]

**Focus for next time:** [one tactical or technical cue]`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 450,
      system: "You are Cole's direct, data-driven strength coach. No disclaimers. Specific numbers only.",
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    return new Response(JSON.stringify({ debrief: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const data = await res.json();
  return new Response(
    JSON.stringify({ debrief: data.content[0].text }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}
