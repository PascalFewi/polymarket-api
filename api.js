// api.js
// Express API to expose Polymarket DB data + DB size stats.
// Assumes orderbooks.ts is BIGINT (UNIX ms) and no event_type/last_trade_price columns.
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import pg from 'pg';
import cors from 'cors';

const { Pool } = pg;

const app = express();
const PORT = process.env.PORT || 3000;

// --- DB POOL ---

const pool = new Pool({
  host: process.env.DB_HOST ,
  port: process.env.DB_PORT ,
  database: process.env.DB_NAME , // match your polymarket-books.js
  user: process.env.DB_USER ,
  password: process.env.DB_PASSWORD ,
  max: 20, // connection pool size
  idleTimeoutMillis: 30000,
  ssl: {
    rejectUnauthorized: false, // sslmode=require
  },
});

// --- MIDDLEWARE ---

app.use(cors());
app.use(express.json());

// --- HELPERS ---

function parseIntOr(defaultValue, value, min = -Infinity, max = Infinity) {
  if (value === undefined || value === null) return defaultValue;
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return defaultValue;
  return Math.min(Math.max(n, min), max);
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const v = bytes / Math.pow(k, i);
  return `${v.toFixed(2)} ${sizes[i]}`;
}

// --- BASIC HEALTH CHECK ---

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// --- EVENTS ---

// GET /events?limit=50&offset=0
app.get('/events', async (req, res) => {
  const limit = parseIntOr(50, req.query.limit, 1, 500);
  const offset = parseIntOr(0, req.query.offset, 0);

  try {
    const { rows } = await pool.query(
      `
      SELECT id, title, slug, description, categories,
             created_at, start_date, end_date,
             active, closed, archived,
             volume, liquidity, open_interest, comment_count
      FROM events
      ORDER BY end_date NULLS LAST, id
      LIMIT $1 OFFSET $2
      `,
      [limit, offset]
    );
    res.json({ limit, offset, data: rows });
  } catch (err) {
    console.error('GET /events error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /events/:id
app.get('/events/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `
      SELECT *
      FROM events
      WHERE id = $1
      `,
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /events/:id error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /events/:id/markets
app.get('/events/:id/markets', async (req, res) => {
  const { id } = req.params;
  const limit = parseIntOr(100, req.query.limit, 1, 1000);
  const offset = parseIntOr(0, req.query.offset, 0);

  try {
    const { rows } = await pool.query(
      `
      SELECT id, event_id, question, slug, description,
             created_at, start_date, end_date, deploying_timestamp,
             active, closed, archived, ready, funded, accepting_orders, neg_risk,
             volume_24h, volume_total, liquidity,
             order_min_size, order_price_min_tick_size
      FROM markets
      WHERE event_id = $1
      ORDER BY id
      LIMIT $2 OFFSET $3
      `,
      [id, limit, offset]
    );
    res.json({ event_id: id, limit, offset, data: rows });
  } catch (err) {
    console.error('GET /events/:id/markets error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- MARKETS ---

// GET /markets?min24hVolume=1000&limit=50&offset=0
app.get('/markets', async (req, res) => {
  const limit = parseIntOr(50, req.query.limit, 1, 500);
  const offset = parseIntOr(0, req.query.offset, 0);
  const min24hVolume = parseFloat(req.query.min24hVolume ?? '0') || 0;

  try {
    const { rows } = await pool.query(
      `
      SELECT id, event_id, question, slug, description,
             created_at, start_date, end_date, deploying_timestamp,
             active, closed, archived, ready, funded, accepting_orders, neg_risk,
             volume_24h, volume_total, liquidity,
             order_min_size, order_price_min_tick_size
      FROM markets
      WHERE (volume_24h IS NULL OR volume_24h >= $1)
      ORDER BY volume_24h DESC NULLS LAST, id
      LIMIT $2 OFFSET $3
      `,
      [min24hVolume, limit, offset]
    );
    res.json({ limit, offset, min24hVolume, data: rows });
  } catch (err) {
    console.error('GET /markets error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /markets/:id
app.get('/markets/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `
      SELECT *
      FROM markets
      WHERE id = $1
      `,
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Market not found' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /markets/:id error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /markets/:id/outcomes
app.get('/markets/:id/outcomes', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `
      SELECT id, market_id, outcome_index, outcome, token_id
      FROM outcomes
      WHERE market_id = $1
      ORDER BY outcome_index
      `,
      [id]
    );
    res.json({ market_id: id, data: rows });
  } catch (err) {
    console.error('GET /markets/:id/outcomes error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- ORDERBOOKS ---

// GET /orderbooks?market_id=516706&outcome=Yes&limit=100
//   or /orderbooks?asset_id=6048...
//   optional: &from=1700000000000&to=1700000100000  (UNIX ms)
app.get('/orderbooks', async (req, res) => {
  const { market_id, asset_id, outcome } = req.query;
  const limit = parseIntOr(100, req.query.limit, 1, 1000);

  // ts is BIGINT UNIX ms in DB, so from/to should also be UNIX ms
  const fromTs = req.query.from ? parseInt(req.query.from, 10) : undefined;
  const toTs = req.query.to ? parseInt(req.query.to, 10) : undefined;

  const conditions = [];
  const values = [];
  let idx = 1;

  if (market_id) {
    conditions.push(`market_id = $${idx++}`);
    values.push(String(market_id));
  }
  if (asset_id) {
    conditions.push(`asset_id = $${idx++}`);
    values.push(String(asset_id));
  }
  if (outcome) {
    conditions.push(`outcome = $${idx++}`);
    values.push(String(outcome));
  }
  if (!Number.isNaN(fromTs) && fromTs !== undefined) {
    conditions.push(`ts >= $${idx++}`);
    values.push(fromTs);
  }
  if (!Number.isNaN(toTs) && toTs !== undefined) {
    conditions.push(`ts <= $${idx++}`);
    values.push(toTs);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const { rows } = await pool.query(
      `
      SELECT ts, asset_id, market_id,
             outcome_index, bids, asks
      FROM orderbooks
      ${whereClause}
      ORDER BY ts DESC
      LIMIT $${idx}
      `,
      [...values, limit]
    );
    res.json({
      filters: { market_id, asset_id, outcome, from: fromTs, to: toTs },
      limit,
      count: rows.length,
      data: rows,
    });
  } catch (err) {
    console.error('GET /orderbooks error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /orderbooks/latest?market_id=516706&outcome=Yes
// or /orderbooks/latest?asset_id=6048...
app.get('/orderbooks/latest', async (req, res) => {
  const { market_id, asset_id, outcome } = req.query;

  const conditions = [];
  const values = [];
  let idx = 1;

  if (market_id) {
    conditions.push(`market_id = $${idx++}`);
    values.push(String(market_id));
  }
  if (asset_id) {
    conditions.push(`asset_id = $${idx++}`);
    values.push(String(asset_id));
  }
  if (outcome) {
    conditions.push(`outcome = $${idx++}`);
    values.push(String(outcome));
  }

  if (!conditions.length) {
    return res
      .status(400)
      .json({ error: 'Provide at least one filter: market_id, asset_id, or outcome' });
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  try {
    const { rows } = await pool.query(
      `
      SELECT ts, asset_id, market_id,
             outcome_index, bids, asks
      FROM orderbooks
      ${whereClause}
      ORDER BY ts DESC
      LIMIT 1
      `,
      values
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'No orderbook snapshots found' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /orderbooks/latest error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- DB SIZE STATS ---

// GET /stats/db-size
// Returns total DB size and per-table sizes for the four main tables.
app.get('/stats/db-size', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const dbSizeResult = await client.query(
        `SELECT current_database() AS db_name,
                pg_database_size(current_database()) AS size_bytes`
      );

      const dbRow = dbSizeResult.rows[0];
      const dbSizeBytes = Number(dbRow.size_bytes);

      const tablesResult = await client.query(
        `
        SELECT
          relname AS table_name,
          pg_total_relation_size(relid) AS size_bytes
        FROM pg_catalog.pg_statio_user_tables
        WHERE relname IN ('events', 'markets', 'outcomes', 'orderbooks')
        ORDER BY size_bytes DESC;
        `
      );

      const tables = tablesResult.rows.map((r) => ({
        table: r.table_name,
        size_bytes: Number(r.size_bytes),
        size_pretty: formatBytes(Number(r.size_bytes)),
      }));

      res.json({
        database: dbRow.db_name,
        size_bytes: dbSizeBytes,
        size_pretty: formatBytes(dbSizeBytes),
        tables,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('GET /stats/db-size error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /orderbooks/:market_id
// Fetch orderbook snapshots for a given market, with optional filters.
// ts is stored as BIGINT (UNIX ms) in the DB.

app.get('/orderbooks/:market_id', async (req, res) => {
  const { market_id } = req.params;
  const { outcome } = req.query;
  const limit = parseIntOr(100, req.query.limit, 1, 1000);

  // ts is BIGINT UNIX ms, so from/to are also expected as UNIX ms
  const fromTs = req.query.from ? parseInt(req.query.from, 10) : undefined;
  const toTs = req.query.to ? parseInt(req.query.to, 10) : undefined;

  const conditions = [`market_id = $1`];
  const values = [String(market_id)];
  let idx = 2;

  if (outcome) {
    conditions.push(`outcome = $${idx++}`);
    values.push(String(outcome));
  }
  if (!Number.isNaN(fromTs) && fromTs !== undefined) {
    conditions.push(`ts >= $${idx++}`);
    values.push(fromTs);
  }
  if (!Number.isNaN(toTs) && toTs !== undefined) {
    conditions.push(`ts <= $${idx++}`);
    values.push(toTs);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  values.push(limit);
  const limitPos = values.length;

  try {
    const { rows } = await pool.query(
      `
      SELECT
        ts,          -- BIGINT UNIX ms
        asset_id,
        market_id,
        outcome_index,
        bids,
        asks
      FROM orderbooks
      ${whereClause}
      ORDER BY ts DESC
      LIMIT $${limitPos}
      `,
      values
    );

    res.json({
      market_id: String(market_id),
      filters: {
        outcome: outcome ?? null,
        from: fromTs ?? null,
        to: toTs ?? null,
      },
      limit,
      count: rows.length,
      data: rows,
    });
  } catch (err) {
    console.error('Error fetching orderbook history:', err);
    res.status(500).json({ error: 'Failed to fetch orderbooks' });
  }
});

// --- START SERVER ---

app.listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`);
});

// Optional: graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down server...');
  await pool.end();
  process.exit(0);
});
