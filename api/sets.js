import { neon } from '@neondatabase/serverless';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'PUT') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { date, day, exercise, setIdx, weight, reps, done } = body;

  if (!date || !day || !exercise || setIdx == null) {
    return new Response(JSON.stringify({ error: 'Missing required fields' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const sql = neon(process.env.DATABASE_URL);

  await sql`
    INSERT INTO workout_sets
      (workout_date, day_key, exercise_name, set_index, weight, reps, done, updated_at)
    VALUES
      (${date}, ${day}, ${exercise}, ${setIdx},
       ${weight || null}, ${reps || null}, ${done ?? false}, NOW())
    ON CONFLICT (workout_date, day_key, exercise_name, set_index)
    DO UPDATE SET
      weight     = EXCLUDED.weight,
      reps       = EXCLUDED.reps,
      done       = EXCLUDED.done,
      updated_at = NOW()
  `;

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
