import { neon } from '@neondatabase/serverless';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const url = new URL(req.url);
  const date  = url.searchParams.get('date');   // YYYY-MM-DD (today)
  const since = url.searchParams.get('since');  // YYYY-MM-DD (week start)

  if (!date || !since) {
    return new Response(JSON.stringify({ error: 'Missing date or since param' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const sql = neon(process.env.DATABASE_URL);

  // Single query: this-week's sets UNION most-recent historical sets per exercise
  const rows = await sql`
    (
      SELECT workout_date::text, day_key, exercise_name, set_index,
             weight::text, reps, done
      FROM workout_sets
      WHERE workout_date >= ${since}
    )
    UNION ALL
    (
      WITH latest AS (
        SELECT day_key, exercise_name, MAX(workout_date) AS latest_date
        FROM workout_sets
        WHERE workout_date < ${since}
        GROUP BY day_key, exercise_name
      )
      SELECT ws.workout_date::text, ws.day_key, ws.exercise_name, ws.set_index,
             ws.weight::text, ws.reps, ws.done
      FROM workout_sets ws
      JOIN latest l
        ON ws.day_key = l.day_key
       AND ws.exercise_name = l.exercise_name
       AND ws.workout_date = l.latest_date
    )
    ORDER BY workout_date, day_key, exercise_name, set_index
  `;

  // Build sessions map: { [date]: { [day]: { [exercise]: [{weight,reps,done}] } } }
  const sessions = {};
  for (const r of rows) {
    if (!sessions[r.workout_date]) sessions[r.workout_date] = {};
    if (!sessions[r.workout_date][r.day_key]) sessions[r.workout_date][r.day_key] = {};
    if (!sessions[r.workout_date][r.day_key][r.exercise_name])
      sessions[r.workout_date][r.day_key][r.exercise_name] = [];
    sessions[r.workout_date][r.day_key][r.exercise_name][r.set_index] = {
      weight: r.weight ?? '',
      reps:   r.reps   ?? '',
      done:   r.done,
    };
  }

  return new Response(JSON.stringify({ sessions }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
