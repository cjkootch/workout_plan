import { neon } from '@neondatabase/serverless';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const sql = neon(process.env.DATABASE_URL);

  if (req.method === 'GET') {
    const rows = await sql`
      SELECT log_date::text AS date, weight::text
      FROM bodyweight_logs
      ORDER BY log_date ASC, created_at ASC
      LIMIT 30
    `;
    const data = rows.map(r => ({ date: r.date, weight: parseFloat(r.weight) }));
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (req.method === 'POST') {
    let body;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const { weight, date } = body;
    if (!weight || isNaN(parseFloat(weight))) {
      return new Response(JSON.stringify({ error: 'Invalid weight' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const logDate = date || new Date().toISOString().slice(0, 10);
    await sql`
      INSERT INTO bodyweight_logs (log_date, weight)
      VALUES (${logDate}, ${parseFloat(weight)})
    `;

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response('Method Not Allowed', { status: 405 });
}
