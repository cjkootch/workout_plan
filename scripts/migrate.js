import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../.env.local') });

const sql = neon(process.env.DATABASE_URL);

await sql`
  CREATE TABLE IF NOT EXISTS chat_messages (
    id         SERIAL PRIMARY KEY,
    role       VARCHAR(20)  NOT NULL,
    content    TEXT         NOT NULL,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  )
`;

await sql`
  CREATE TABLE IF NOT EXISTS user_settings (
    key        VARCHAR(100) PRIMARY KEY,
    value      TEXT         NOT NULL,
    updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  )
`;

// Seed default phase if not set
await sql`
  INSERT INTO user_settings (key, value)
  VALUES ('phase', 'bulk')
  ON CONFLICT (key) DO NOTHING
`;

console.log('Migration complete: chat_messages, user_settings tables ready.');
