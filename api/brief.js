import { neon } from '@neondatabase/serverless';

export const config = { runtime: 'edge' };

const DAY_NAMES = { day1: 'Push', day2: 'Pull', day3: 'Legs', day4: 'Upper Power', day5: 'Athletic' };

const DAY_EXERCISES = {
  day1: ['Barbell Flat Bench Press','Incline DB Press','Cable Fly (Low to High)','Seated DB Overhead Press','Lateral Raise (Cable or DB)','Overhead Cable Tricep Extension','Tricep Rope Pushdown'],
  day2: ['Barbell Bent-Over Row','Seated Cable Row (Wide Grip)','Single-Arm DB Row','TRX Row (Feet Elevated)','Lat Pulldown (Wide Overhand)','Straight-Arm Cable Pulldown','Barbell Curl','Incline DB Curl','Hammer Curl'],
  day3: ['Barbell Back Squat','Leg Press (High & Wide Foot)','Bulgarian Split Squat (DB)','Romanian Deadlift (Bar)','Lying Leg Curl','Hip Thrust (Barbell)','Leg Extension'],
  day4: ['Face Pull (Cable)','DB Lateral Raise (Drop Set)','Arnold Press','Preacher Curl (EZ Bar)','Cable Curl (Both Arms)','DB Concentration Curl','Close-Grip Bench Press','Skull Crusher (EZ Bar)','Single-Arm Cable Pushdown','Cable Crunch','Hanging Leg Raise','Ab Wheel Rollout'],
  day5: ['KB Goblet Squat','KB Swing (Two-Hand)','KB Turkish Get-Up','Plank Variations','Pallof Press (Cable)','Dead Bug'],
};

export default async function handler(req) {
  if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });

  const url = new URL(req.url);
  const day = url.searchParams.get('day');
  if (!day || !DAY_EXERCISES[day]) return new Response('Bad request', { status: 400 });

  const sql = neon(process.env.DATABASE_URL);
  const exercises = DAY_EXERCISES[day];

  const [lastRows, targetRows, bwRows, noteRows] = await Promise.all([
    // Last completed session for this day (before today)
    sql`
      WITH last_date AS (
        SELECT MAX(workout_date) AS d
        FROM workout_sets
        WHERE day_key = ${day} AND done = true AND workout_date < CURRENT_DATE
      )
      SELECT ws.exercise_name, ws.weight::float, ws.reps, ws.workout_date::text
      FROM workout_sets ws
      JOIN last_date ld ON ws.workout_date = ld.d
      WHERE ws.day_key = ${day} AND ws.done = true AND ws.weight IS NOT NULL
      ORDER BY ws.exercise_name, ws.set_index
    `,
    sql`SELECT key, value FROM user_settings WHERE key LIKE ${'target:%'}`,
    sql`SELECT weight::float AS weight FROM bodyweight_logs ORDER BY log_date DESC LIMIT 1`,
    sql`SELECT value FROM user_settings WHERE key = ${'note:' + new Date().toISOString().slice(0,10)} LIMIT 1`,
  ]);

  // Group last session by exercise
  const lastSession = {};
  lastRows.forEach(r => {
    if (!lastSession[r.exercise_name]) lastSession[r.exercise_name] = { date: r.workout_date, sets: [] };
    lastSession[r.exercise_name].sets.push({ weight: r.weight, reps: r.reps });
  });

  const targets = {};
  targetRows.forEach(r => { targets[r.key.replace('target:', '')] = r.value; });

  const lastDate = lastRows[0]?.workout_date;
  const daysSince = lastDate
    ? Math.floor((Date.now() - new Date(lastDate + 'T12:00:00').getTime()) / 86400000)
    : null;
  const bw = bwRows[0]?.weight;
  const todayNote = noteRows[0]?.value;

  const exerciseSummary = exercises.map(ex => {
    const last = lastSession[ex];
    const target = targets[ex];
    let line = `- ${ex}`;
    if (last) {
      const maxW = Math.max(...last.sets.map(s => s.weight || 0));
      const allReps = last.sets.map(s => parseInt(s.reps) || 0);
      const avgR = allReps.length ? Math.round(allReps.reduce((a, b) => a + b, 0) / allReps.length) : '?';
      line += `: last ${maxW} lbs × ${avgR} avg reps (${last.sets.length} sets, ${lastDate})`;
    } else {
      line += ': no history';
    }
    if (target) line += ` | stored target: ${target}`;
    return line;
  }).join('\n');

  const prompt = `Pre-workout brief for Cole's ${DAY_NAMES[day]} session.
${daysSince !== null ? `Last ${DAY_NAMES[day]}: ${daysSince} day${daysSince === 1 ? '' : 's'} ago` : 'No previous session found.'}
Bodyweight: ${bw ? bw + ' lbs' : 'unknown'}
${todayNote ? `Today's note: ${todayNote}` : ''}

Exercise history:
${exerciseSummary}

Write 3–4 tightly focused bullets:
- Target weights for the top 2–3 main lifts (apply double progression: hit top of rep range last time → add 5 lbs; missed bottom → hold or drop 5%)
- Recovery/readiness flag if needed (rest days, proximity to last session)
- One focus cue for this session

Be direct. Bold the target weights/reps. No fluff.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 350,
      system: "You are Cole's blunt, data-driven strength coach. Bullets only. Bold key numbers. No disclaimers.",
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    return new Response(JSON.stringify({ brief: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const data = await res.json();
  return new Response(
    JSON.stringify({ brief: data.content[0].text, daysSince, lastDate }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}
