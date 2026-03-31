import { neon } from '@neondatabase/serverless';

export const config = { runtime: 'edge' };

function buildSystemPrompt(recentRows, prRows, bwRows, overview) {
  // Group recent sets by date → day → exercise
  const sessions = {};
  recentRows.forEach(r => {
    if (!sessions[r.workout_date]) sessions[r.workout_date] = {};
    if (!sessions[r.workout_date][r.day_key]) sessions[r.workout_date][r.day_key] = {};
    if (!sessions[r.workout_date][r.day_key][r.exercise_name]) sessions[r.workout_date][r.day_key][r.exercise_name] = [];
    sessions[r.workout_date][r.day_key][r.exercise_name].push({ weight: r.weight, reps: r.reps });
  });

  let sessionsText = '';
  Object.entries(sessions)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .forEach(([date, days]) => {
      Object.entries(days).forEach(([day, exercises]) => {
        sessionsText += `\n${date} (${day}):\n`;
        Object.entries(exercises).forEach(([ex, sets]) => {
          const setStr = sets.map(s => `${s.weight || '?'}×${s.reps || '?'}`).join(', ');
          sessionsText += `  ${ex}: ${setStr}\n`;
        });
      });
    });

  const prsText = prRows.map(r => `  ${r.exercise_name}: ${r.weight} lbs × ${r.reps} (${r.date})`).join('\n');
  const bwText  = bwRows.map(r => `  ${r.date}: ${r.weight} lbs`).join('\n');
  const latestBW = bwRows[0]?.weight;

  return `You are Cole's personal fitness coach AI, built into his Iron Protocol workout tracker.

COLE'S PROFILE:
- Current bodyweight: ${latestBW ? latestBW + ' lbs' : 'not yet logged'}
- Goal: Lean bulk — 3,200–3,600 kcal/day, 235–250g protein daily
- Program: 5-Day PPL/Hybrid (Push / Pull / Legs / Upper Power / Athletic)
- Total sessions logged: ${overview?.total_days || 0}, total sets: ${overview?.total_sets || 0}, total tonnage: ${overview?.total_tonnage || 0} lbs
- TRT: 100–150mg/week testosterone (upper physiological range — recovery and protein synthesis are enhanced)
- Achilles tendinopathy — avoid box jumps, sprint accelerations, heavy calf raises; safe: bike, rower, controlled squats, leg press, hip thrust
- Progression model: double progression — hit top of rep range → add weight next session; can't hit bottom of range → reduce 5–10%
- Deload every 6th week: drop volume 40%, keep intensity

PERSONAL RECORDS (heaviest single set per exercise, all-time):
${prsText || '  (none logged yet)'}

BODYWEIGHT LOG (recent):
${bwText || '  (nothing logged yet)'}

RECENT TRAINING (last 3 weeks — format: date (day) → exercise: sets as weight×reps):
${sessionsText || '  (no recent sessions)'}

PROGRAM STRUCTURE:
- Day 1 Push: Flat Bench Press, Incline DB Press, Cable Fly, OHP, Lateral Raise, Tricep Pushdown, Overhead Tricep Extension, Face Pull
- Day 2 Pull: Barbell Row, Weighted Pull-Ups, Seated Cable Row, Lat Pulldown, Chest-Supported Row, DB Curl, Hammer Curl, Reverse Curl
- Day 3 Legs: Back Squat, Romanian Deadlift, Leg Press, Leg Curl, Leg Extension, Hip Thrust, Calf Raise (Achilles-modified)
- Day 4 Upper Power: Weighted Dips, Close-Grip Bench, EZ-Bar Curl, DB Preacher Curl, Lateral Raise, Face Pull, Wrist Roller
- Day 5 Athletic: Sled, bike intervals, mobility, conditioning (all Achilles-safe)

YOUR JOB:
- Answer questions about Cole's training, recovery, nutrition, and progress
- Suggest specific weight/rep targets based on his logs and progression model
- Spot trends, stalls, weaknesses, or volume issues
- Keep responses direct and practical — Cole is an experienced lifter, skip the basics
- Always factor in the Achilles injury for lower body and conditioning advice
- Be concise — bullet points are fine, long essays are not

Today: ${new Date().toISOString().slice(0, 10)}`;
}

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  let body;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const { message, history } = body;
  if (!message) return new Response(JSON.stringify({ error: 'No message' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  const sql = neon(process.env.DATABASE_URL);

  const [recentRows, prRows, bwRows, overviewRows] = await Promise.all([
    sql`
      SELECT workout_date::text, day_key, exercise_name, set_index, weight::text, reps
      FROM workout_sets
      WHERE done = true AND workout_date >= CURRENT_DATE - INTERVAL '3 weeks'
      ORDER BY workout_date DESC, day_key, exercise_name, set_index
    `,
    sql`
      SELECT DISTINCT ON (exercise_name)
        exercise_name, weight::float AS weight, reps, workout_date::text AS date
      FROM workout_sets
      WHERE done = true AND weight IS NOT NULL AND weight > 0
      ORDER BY exercise_name, weight DESC, workout_date DESC
    `,
    sql`SELECT log_date::text AS date, weight::float AS weight FROM bodyweight_logs ORDER BY log_date DESC LIMIT 7`,
    sql`
      SELECT
        COUNT(DISTINCT workout_date) AS total_days,
        COUNT(*) FILTER (WHERE done = true) AS total_sets,
        COALESCE(SUM(
          CASE WHEN done = true AND weight IS NOT NULL AND weight > 0
                AND reps ~ '^[0-9]+(\.[0-9]+)?$'
               THEN weight * reps::numeric ELSE 0 END
        ), 0)::bigint AS total_tonnage
      FROM workout_sets
    `,
  ]);

  const systemPrompt = buildSystemPrompt(recentRows, prRows, bwRows, overviewRows[0]);

  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [
        ...(history || []).slice(-10),
        { role: 'user', content: message },
      ],
    }),
  });

  if (!anthropicRes.ok) {
    const err = await anthropicRes.text();
    return new Response(JSON.stringify({ error: 'Claude API error: ' + err }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  const data = await anthropicRes.json();
  return new Response(
    JSON.stringify({ reply: data.content[0].text }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}
