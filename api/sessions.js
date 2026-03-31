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

  const { duration, date } = body;
  if (duration == null || isNaN(parseInt(duration))) {
    return new Response(JSON.stringify({ error: 'Invalid duration' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const sql = neon(process.env.DATABASE_URL);
  const sessionDate = date || new Date().toISOString().slice(0, 10);

  await sql`
    INSERT INTO session_times (session_date, duration_seconds)
    VALUES (${sessionDate}, ${parseInt(duration)})
  `;

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
