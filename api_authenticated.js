// api_authenticated.js
// Express API with API key authentication, rate limiting, and role-based access control
// Roles: free (200 calls/day, 2 weeks lookback), professional (10k calls/day, 3 months), enterprise (unlimited)

import express from 'express';
import pg from 'pg';
import cors from 'cors';
import crypto from 'crypto';

const { Pool } = pg;

const app = express();
const PORT = process.env.PORT || 3000;

// --- DB POOL ---

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'test',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  max: 20,
  idleTimeoutMillis: 30000,
  ssl: process.env.DB_SSL === 'true' ? {
    rejectUnauthorized: false, // sslmode=require
  } : false,
});

// --- MIDDLEWARE ---

app.use(cors());
app.use(express.json());

// --- ROLE CONFIGURATION ---

const ROLE_LIMITS = {
  free: {
    dailyCallLimit: 200,
    lookbackDays: 14,
  },
  professional: {
    dailyCallLimit: 10000,
    lookbackDays: 90,
  },
  enterprise: {
    dailyCallLimit: null, // unlimited
    lookbackDays: null, // unlimited
  },
  admin: {
    dailyCallLimit: null,
    lookbackDays: null,
  },
};

// --- AUTHENTICATION MIDDLEWARE ---

async function authenticateApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');

  if (!apiKey) {
    return res.status(401).json({ error: 'API key required. Provide via X-API-Key or Authorization header' });
  }

  try {
    // Fetch API key from database
    const { rows } = await pool.query(
      `SELECT id, api_key, user_email, user_name, role, active
       FROM api_keys
       WHERE api_key = $1 AND active = true`,
      [apiKey]
    );

    if (rows.length === 0) {
      return res.status(403).json({ error: 'Invalid or inactive API key' });
    }

    const keyData = rows[0];
    req.apiKeyData = keyData;

    // Update last_used_at
    pool.query(
      `UPDATE api_keys SET last_used_at = NOW() WHERE id = $1`,
      [keyData.id]
    ).catch(err => console.error('Failed to update last_used_at:', err));

    next();
  } catch (err) {
    console.error('Authentication error:', err);
    return res.status(500).json({ error: 'Authentication failed' });
  }
}

// --- RATE LIMITING MIDDLEWARE ---

async function rateLimitMiddleware(req, res, next) {
  const { id: apiKeyId, role } = req.apiKeyData;
  const roleConfig = ROLE_LIMITS[role];

  if (roleConfig.dailyCallLimit === null) {
    // Unlimited calls for this role
    return next();
  }

  try {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    // Increment call count
    const { rows } = await pool.query(
      `INSERT INTO api_usage (api_key_id, date, call_count, last_call_at)
       VALUES ($1, $2, 1, NOW())
       ON CONFLICT (api_key_id, date)
       DO UPDATE SET call_count = api_usage.call_count + 1, last_call_at = NOW()
       RETURNING call_count`,
      [apiKeyId, today]
    );

    const callCount = rows[0].call_count;

    // Set rate limit headers
    res.setHeader('X-RateLimit-Limit', roleConfig.dailyCallLimit);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, roleConfig.dailyCallLimit - callCount));
    res.setHeader('X-RateLimit-Reset', new Date(today + 'T00:00:00Z').getTime() + 86400000);

    if (callCount > roleConfig.dailyCallLimit) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
        limit: roleConfig.dailyCallLimit,
        reset_at: new Date(today + 'T00:00:00Z').getTime() + 86400000,
      });
    }

    next();
  } catch (err) {
    console.error('Rate limiting error:', err);
    return res.status(500).json({ error: 'Rate limiting failed' });
  }
}

// --- LOOKBACK TIME VALIDATION ---

function validateLookbackTime(req, res, next) {
  const { role } = req.apiKeyData;
  const roleConfig = ROLE_LIMITS[role];

  if (roleConfig.lookbackDays === null) {
    // Unlimited lookback
    return next();
  }

  const fromTs = req.query.from ? parseInt(req.query.from, 10) : undefined;

  if (!Number.isNaN(fromTs) && fromTs !== undefined) {
    const now = Date.now();
    const maxLookbackMs = roleConfig.lookbackDays * 24 * 60 * 60 * 1000;
    const minAllowedTs = now - maxLookbackMs;

    if (fromTs < minAllowedTs) {
      return res.status(403).json({
        error: `Your plan allows ${roleConfig.lookbackDays} days of historical data`,
        your_from: fromTs,
        earliest_allowed: minAllowedTs,
        upgrade_url: 'https://deltaodds.io/#pricing',
      });
    }
  }

  next();
}

// --- REQUEST LOGGING MIDDLEWARE (OPTIONAL) ---

function logRequest(req, res, next) {
  const startTime = Date.now();

  res.on('finish', () => {
    const responseTime = Date.now() - startTime;
    const { id: apiKeyId } = req.apiKeyData || {};

    if (apiKeyId) {
      pool.query(
        `INSERT INTO api_request_logs (api_key_id, endpoint, method, status_code, response_time_ms, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          apiKeyId,
          req.path,
          req.method,
          res.statusCode,
          responseTime,
          req.ip,
          req.headers['user-agent'],
        ]
      ).catch(err => console.error('Failed to log request:', err));
    }
  });

  next();
}

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

function generateApiKey(role = 'free') {
  const prefix = role === 'admin' ? 'admin' : role === 'enterprise' ? 'ent' : role === 'professional' ? 'pro' : 'free';
  return `${prefix}_${crypto.randomBytes(32).toString('hex')}`;
}

// --- PUBLIC ENDPOINTS ---

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// --- ADMIN ENDPOINTS (require admin role) ---

// Create new API key (admin only)
app.post('/admin/keys', authenticateApiKey, async (req, res) => {
  if (req.apiKeyData.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { user_email, user_name, role, notes } = req.body;

  if (!user_email || !role) {
    return res.status(400).json({ error: 'user_email and role are required' });
  }

  if (!['free', 'professional', 'enterprise', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role. Must be: free, professional, enterprise, or admin' });
  }

  try {
    const apiKey = generateApiKey(role);

    const { rows } = await pool.query(
      `INSERT INTO api_keys (api_key, user_email, user_name, role, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, api_key, user_email, user_name, role, created_at`,
      [apiKey, user_email, user_name || null, role, notes || null]
    );

    res.status(201).json({
      message: 'API key created successfully',
      data: rows[0],
    });
  } catch (err) {
    console.error('Error creating API key:', err);
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

// List all API keys (admin only)
app.get('/admin/keys', authenticateApiKey, async (req, res) => {
  if (req.apiKeyData.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const limit = parseIntOr(100, req.query.limit, 1, 1000);
  const offset = parseIntOr(0, req.query.offset, 0);

  try {
    const { rows } = await pool.query(
      `SELECT id, api_key, user_email, user_name, role, active, created_at, last_used_at, notes
       FROM api_keys
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    res.json({ limit, offset, count: rows.length, data: rows });
  } catch (err) {
    console.error('Error listing API keys:', err);
    res.status(500).json({ error: 'Failed to list API keys' });
  }
});

// Get API key details (admin only)
app.get('/admin/keys/:keyId', authenticateApiKey, async (req, res) => {
  if (req.apiKeyData.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { keyId } = req.params;

  try {
    const { rows } = await pool.query(
      `SELECT id, api_key, user_email, user_name, role, active, created_at, last_used_at, notes
       FROM api_keys
       WHERE id = $1`,
      [keyId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'API key not found' });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('Error fetching API key:', err);
    res.status(500).json({ error: 'Failed to fetch API key' });
  }
});

// Update API key (admin only)
app.patch('/admin/keys/:keyId', authenticateApiKey, async (req, res) => {
  if (req.apiKeyData.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { keyId } = req.params;
  const { user_email, user_name, role, active, notes } = req.body;

  const updates = [];
  const values = [];
  let idx = 1;

  if (user_email !== undefined) {
    updates.push(`user_email = $${idx++}`);
    values.push(user_email);
  }
  if (user_name !== undefined) {
    updates.push(`user_name = $${idx++}`);
    values.push(user_name);
  }
  if (role !== undefined) {
    if (!['free', 'professional', 'enterprise', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    updates.push(`role = $${idx++}`);
    values.push(role);
  }
  if (active !== undefined) {
    updates.push(`active = $${idx++}`);
    values.push(active);
  }
  if (notes !== undefined) {
    updates.push(`notes = $${idx++}`);
    values.push(notes);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No updates provided' });
  }

  values.push(keyId);

  try {
    const { rows } = await pool.query(
      `UPDATE api_keys
       SET ${updates.join(', ')}
       WHERE id = $${idx}
       RETURNING id, api_key, user_email, user_name, role, active, created_at, last_used_at, notes`,
      values
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'API key not found' });
    }

    res.json({ message: 'API key updated successfully', data: rows[0] });
  } catch (err) {
    console.error('Error updating API key:', err);
    res.status(500).json({ error: 'Failed to update API key' });
  }
});

// Delete API key (admin only)
app.delete('/admin/keys/:keyId', authenticateApiKey, async (req, res) => {
  if (req.apiKeyData.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { keyId } = req.params;

  try {
    const { rowCount } = await pool.query(
      `DELETE FROM api_keys WHERE id = $1`,
      [keyId]
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: 'API key not found' });
    }

    res.json({ message: 'API key deleted successfully' });
  } catch (err) {
    console.error('Error deleting API key:', err);
    res.status(500).json({ error: 'Failed to delete API key' });
  }
});

// Get usage statistics for an API key (admin only)
app.get('/admin/keys/:keyId/usage', authenticateApiKey, async (req, res) => {
  if (req.apiKeyData.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { keyId } = req.params;
  const days = parseIntOr(30, req.query.days, 1, 365);

  try {
    const { rows } = await pool.query(
      `SELECT date, call_count, last_call_at
       FROM api_usage
       WHERE api_key_id = $1
       ORDER BY date DESC
       LIMIT $2`,
      [keyId, days]
    );

    res.json({ api_key_id: keyId, days, data: rows });
  } catch (err) {
    console.error('Error fetching usage:', err);
    res.status(500).json({ error: 'Failed to fetch usage data' });
  }
});

// --- AUTHENTICATED DATA ENDPOINTS ---

// Apply authentication, rate limiting, and logging to all /v1 endpoints
app.use('/v1', authenticateApiKey, rateLimitMiddleware, logRequest);

// GET /v1/events
app.get('/v1/events', async (req, res) => {
  const limit = parseIntOr(50, req.query.limit, 1, 500);
  const offset = parseIntOr(0, req.query.offset, 0);

  try {
    const { rows } = await pool.query(
      `SELECT id, title, slug, description, categories,
              created_at, start_date, end_date,
              active, closed, archived,
              volume, liquidity, open_interest, comment_count
       FROM events
       ORDER BY end_date NULLS LAST, id
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({ limit, offset, data: rows });
  } catch (err) {
    console.error('GET /v1/events error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /v1/events/:id
app.get('/v1/events/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM events WHERE id = $1`,
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /v1/events/:id error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /v1/markets
app.get('/v1/markets', async (req, res) => {
  const limit = parseIntOr(50, req.query.limit, 1, 500);
  const offset = parseIntOr(0, req.query.offset, 0);
  const min24hVolume = parseFloat(req.query.min24hVolume ?? '0') || 0;

  try {
    const { rows } = await pool.query(
      `SELECT id, event_id, question, slug, description,
              created_at, start_date, end_date, deploying_timestamp,
              active, closed, archived, ready, funded, accepting_orders, neg_risk,
              volume_24h, volume_total, liquidity,
              order_min_size, order_price_min_tick_size
       FROM markets
       WHERE (volume_24h IS NULL OR volume_24h >= $1)
       ORDER BY volume_24h DESC NULLS LAST, id
       LIMIT $2 OFFSET $3`,
      [min24hVolume, limit, offset]
    );
    res.json({ limit, offset, min24hVolume, data: rows });
  } catch (err) {
    console.error('GET /v1/markets error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /v1/markets/:id
app.get('/v1/markets/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM markets WHERE id = $1`,
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Market not found' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /v1/markets/:id error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /v1/orderbook - Main orderbook endpoint with lookback validation
app.get('/v1/orderbook', validateLookbackTime, async (req, res) => {
  const { market_id, asset_id } = req.query;
  const limit = parseIntOr(100, req.query.limit, 1, 1000);
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
  if (!Number.isNaN(fromTs) && fromTs !== undefined) {
    conditions.push(`ts >= $${idx++}`);
    values.push(fromTs);
  }
  if (!Number.isNaN(toTs) && toTs !== undefined) {
    conditions.push(`ts <= $${idx++}`);
    values.push(toTs);
  }

  if (conditions.length === 0) {
    return res.status(400).json({ error: 'Provide at least market_id or asset_id' });
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  try {
    const { rows } = await pool.query(
      `SELECT ts, asset_id, market_id, outcome_index, bids, asks
       FROM orderbooks
       ${whereClause}
       ORDER BY ts DESC
       LIMIT $${idx}`,
      [...values, limit]
    );

    res.json({
      filters: { market_id, asset_id, from: fromTs, to: toTs },
      limit,
      count: rows.length,
      data: rows,
    });
  } catch (err) {
    console.error('GET /v1/orderbook error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /v1/outcomes - Query market outcomes
app.get('/v1/outcomes', async (req, res) => {
  const { market_id } = req.query;

  if (!market_id) {
    return res.status(400).json({ error: 'market_id is required' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, market_id, outcome_index, outcome, token_id
       FROM outcomes
       WHERE market_id = $1
       ORDER BY outcome_index`,
      [market_id]
    );

    res.json({ market_id, data: rows });
  } catch (err) {
    console.error('GET /v1/outcomes error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /v1/stats/db-size
app.get('/v1/stats/db-size', async (req, res) => {
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
        `SELECT relname AS table_name,
                pg_total_relation_size(relid) AS size_bytes
         FROM pg_catalog.pg_statio_user_tables
         WHERE relname IN ('events', 'markets', 'outcomes', 'orderbooks')
         ORDER BY size_bytes DESC`
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
    console.error('GET /v1/stats/db-size error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- START SERVER ---

app.listen(PORT, () => {
  console.log(`✓ Authenticated API server listening on http://localhost:${PORT}`);
  console.log(`✓ Rate limiting enabled (Free: 200/day, Pro: 10k/day, Enterprise: unlimited)`);
  console.log(`✓ Lookback limits (Free: 2 weeks, Pro: 3 months, Enterprise: unlimited)`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down server...');
  await pool.end();
  process.exit(0);
});
