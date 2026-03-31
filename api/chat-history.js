import { neon } from '@neondatabase/serverless';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const sql = neon(process.env.DATABASE_URL);

  if (req.method === 'GET') {
    const rows = await sql`
      SELECT role, content, created_at
      FROM chat_messages
      ORDER BY created_at ASC
      LIMIT 100
    `;
    return new Response(JSON.stringify({ messages: rows }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  if (req.method === 'POST') {
    const { role, content } = await req.json();
    if (!role || !content) return new Response('Bad request', { status: 400 });
    await sql`INSERT INTO chat_messages (role, content) VALUES (${role}, ${content})`;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response('Method Not Allowed', { status: 405 });
}
