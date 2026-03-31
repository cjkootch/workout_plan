import { neon } from '@neondatabase/serverless';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const sql = neon(process.env.DATABASE_URL);

  if (req.method === 'GET') {
    const rows = await sql`SELECT key, value FROM user_settings`;
    const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
    return new Response(JSON.stringify(settings), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  if (req.method === 'POST') {
    const { key, value } = await req.json();
    if (!key || value === undefined) return new Response('Bad request', { status: 400 });
    await sql`
      INSERT INTO user_settings (key, value, updated_at)
      VALUES (${key}, ${value}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response('Method Not Allowed', { status: 405 });
}
