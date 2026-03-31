import { neon } from '@neondatabase/serverless';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
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

  const { date, day, sets, duration } = body;

  if (!date || !day) {
    return new Response(JSON.stringify({ error: 'Missing date or day' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const sql = neon(process.env.DATABASE_URL);

  // Batch-upsert all sets in parallel (each is idempotent via ON CONFLICT)
  const setOps = (sets || []).map(s =>
    sql`
      INSERT INTO workout_sets
        (workout_date, day_key, exercise_name, set_index, weight, reps, done, updated_at)
      VALUES
        (${date}, ${day}, ${s.exercise}, ${s.setIdx},
         ${s.weight || null}, ${s.reps || null}, ${s.done || !!(s.weight || s.reps)}, NOW())
      ON CONFLICT (workout_date, day_key, exercise_name, set_index)
      DO UPDATE SET
        weight     = EXCLUDED.weight,
        reps       = EXCLUDED.reps,
        done       = EXCLUDED.done,
        updated_at = NOW()
    `
  );

  // Record session time only if a meaningful duration was provided
  const sessionOp = duration > 0
    ? sql`
        INSERT INTO session_times (session_date, duration_seconds)
        VALUES (${date}, ${Math.round(duration)})
      `
    : Promise.resolve();

  await Promise.all([...setOps, sessionOp]);

  return new Response(JSON.stringify({ ok: true, sets: (sets || []).length }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
