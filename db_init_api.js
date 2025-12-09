// db_init_api.js
// Initialize API key management schema
import dotenv from 'dotenv';
dotenv.config();

import pg from 'pg';
import crypto from 'crypto';

const { Pool } = pg;

const pool = new Pool({
  host: process.env.DB_HOST ,
  port: process.env.DB_PORT ,
  database: process.env.DB_NAME ,
  user: process.env.DB_USER ,
  password: process.env.DB_PASSWORD,
  max: 20,
  idleTimeoutMillis: 30000,
});

async function init() {
  console.log('Initializing API key management schema...');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // API KEYS: Store API keys with role-based access
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id              BIGSERIAL PRIMARY KEY,
        api_key         TEXT UNIQUE NOT NULL,
        user_email      TEXT NOT NULL,
        user_name       TEXT,
        role            TEXT NOT NULL CHECK (role IN ('free', 'professional', 'enterprise', 'admin')),
        active          BOOLEAN DEFAULT true,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        last_used_at    TIMESTAMPTZ,
        notes           TEXT
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_api_keys_key
        ON api_keys (api_key) WHERE active = true;
    `);

    // API USAGE: Track daily API call counts per key
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_usage (
        id              BIGSERIAL PRIMARY KEY,
        api_key_id      BIGINT REFERENCES api_keys(id) ON DELETE CASCADE,
        date            DATE NOT NULL,
        call_count      INT DEFAULT 0,
        last_call_at    TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (api_key_id, date)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_api_usage_key_date
        ON api_usage (api_key_id, date DESC);
    `);

    // API REQUEST LOGS: Detailed logging for monitoring (optional, can be disabled for performance)
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_request_logs (
        id              BIGSERIAL PRIMARY KEY,
        api_key_id      BIGINT REFERENCES api_keys(id) ON DELETE SET NULL,
        endpoint        TEXT,
        method          TEXT,
        status_code     INT,
        response_time_ms INT,
        timestamp       TIMESTAMPTZ DEFAULT NOW(),
        ip_address      TEXT,
        user_agent      TEXT
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_api_request_logs_timestamp
        ON api_request_logs (timestamp DESC);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_api_request_logs_api_key_id
        ON api_request_logs (api_key_id, timestamp DESC);
    `);

    // Create default admin key if it doesn't exist
    const adminKey = process.env.ADMIN_API_KEY || 'admin_' + crypto.randomBytes(32).toString('hex');

    await client.query(`
      INSERT INTO api_keys (api_key, user_email, user_name, role, active, notes)
      VALUES ($1, 'admin@deltaodds.io', 'Administrator', 'admin', true, 'Default admin key')
      ON CONFLICT (api_key) DO NOTHING
    `, [adminKey]);

    console.log('✓ API key schema initialized');
    console.log(`✓ Admin API key: ${adminKey}`);
    console.log('  IMPORTANT: Save this key securely and set it as ADMIN_API_KEY environment variable');

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error initializing API key schema:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  init().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export default init;
