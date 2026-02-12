
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import pg from "pg";
import cors from "cors";
import rateLimit from "express-rate-limit";

const { Pool } = pg;

const app = express();
const PORT = process.env.PORT || 3000;

/**
 * =========================
 * CONFIG / SECURITY NOTE
 * =========================
 * Your message included a live DB password. Do NOT keep credentials in source code.
 * Put them into env vars instead (see guide below).
 */
const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: parseInt(process.env.DB_POOL_SIZE || '20', 10),
  idleTimeoutMillis: 30000,
  ssl: process.env.DB_SSL === 'false' ? false : {
    rejectUnauthorized: false,
  },
});

// Apply per-connection settings (runs for each new physical connection in pool)
pool.on("connect", async (client) => {
  // Keep these conservative. You can tune further after measuring.
  // statement_timeout protects you from accidental table scans in prod.
  const statementTimeoutMs = Number(process.env.DB_STATEMENT_TIMEOUT_MS || 10_000);
  const idleTxTimeoutMs = Number(process.env.DB_IDLE_TX_TIMEOUT_MS || 10_000);

  try {
    await client.query(`SET statement_timeout = ${statementTimeoutMs}`);
    await client.query(`SET idle_in_transaction_session_timeout = ${idleTxTimeoutMs}`);

    // Helps avoid huge memory usage for sorts/hashes; keep small and predictable.
    await client.query(`SET work_mem = '16MB'`);

    // If you do lots of repeated small queries, this can help plan quality.
    await client.query(`SET random_page_cost = 1.1`);
  } catch (e) {
    // If this fails, we don't want to crash the server; just log.
    console.warn("Warning: failed to apply session settings:", e?.message || e);
  }
});

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json());

app.set("trust proxy", 1);

/**
 * =========================
 * RATE LIMITING
 * =========================
 * - Global limiter: applies to all endpoints
 * - Orderbooks limiter: stricter because it's expensive
 */
const globalLimiter = rateLimit({
  windowMs: 60_000, // 1 minute
  limit: Number(process.env.RATE_LIMIT_GLOBAL_PER_MIN || 60), // 120 req/min per IP
  standardHeaders: true,
  legacyHeaders: false,
});

const orderbooksLimiter = rateLimit({
  windowMs: 60_000, // 1 minute
  limit: Number(process.env.RATE_LIMIT_ORDERBOOKS_PER_MIN || 30), // 30 req/min per IP
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(globalLimiter);
app.use("/orderbooks", orderbooksLimiter);

// --- HELPERS ---

function parseIntOr(defaultValue, value, min = -Infinity, max = Infinity) {
  if (value === undefined || value === null) return defaultValue;
  const n = parseInt(String(value), 10);
  if (Number.isNaN(n)) return defaultValue;
  return Math.min(Math.max(n, min), max);
}

function parseFloatOr(defaultValue, value, min = -Infinity, max = Infinity) {
  if (value === undefined || value === null) return defaultValue;
  const n = parseFloat(String(value));
  if (Number.isNaN(n)) return defaultValue;
  return Math.min(Math.max(n, min), max);
}

function parseOutcomeIndex(value) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim().toLowerCase();
  if (raw === "yes") return 0;
  if (raw === "no") return 1;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return null;
  return n;
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const v = bytes / Math.pow(k, i);
  return `${v.toFixed(2)} ${sizes[i]}`;
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Small TTL cache (best for tiny dimension tables / repeated hits)
function createTTLCache({ defaultTtlMs = 5_000, maxKeys = 2_000 } = {}) {
  const store = new Map(); // key -> { value, expiresAt }
  return {
    get(key) {
      const e = store.get(key);
      if (!e) return undefined;
      if (Date.now() > e.expiresAt) {
        store.delete(key);
        return undefined;
      }
      return e.value;
    },
    set(key, value, ttlMs = defaultTtlMs) {
      if (store.size >= maxKeys) {
        // naive eviction: delete first key
        const firstKey = store.keys().next().value;
        if (firstKey !== undefined) store.delete(firstKey);
      }
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
  };
}

const cache = createTTLCache({
  defaultTtlMs: Number(process.env.API_CACHE_TTL_MS || 5_000),
  maxKeys: Number(process.env.API_CACHE_MAX_KEYS || 5_000),
});

// Prepared statement wrapper
async function q({ name, text, values }) {
  // name should be stable per query-shape
  return pool.query({ name, text, values });
}

// --- BASIC HEALTH CHECK ---
app.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

/**
 * =========================
 * EVENTS
 * =========================
 */

// GET /events
app.get(
  "/events",
  asyncHandler(async (req, res) => {
    const limit = parseIntOr(50, req.query.limit, 1, 500);
    const offset = req.query.offset !== undefined ? parseIntOr(0, req.query.offset, 0) : null;

    const cursorEndDate = req.query.cursor_end_date ? parseInt(req.query.cursor_end_date, 10) : null; // unix ms
    const cursorId = req.query.cursor_id ? parseInt(req.query.cursor_id, 10) : null;

    const useOffset = offset !== null;

    const cacheKey =
      useOffset
        ? `events:offset:${limit}:${offset}`
        : `events:cursor:${limit}:${cursorEndDate ?? "null"}:${cursorId ?? "null"}`;

    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    let rows;
    if (useOffset) {
      const r = await q({
        name: "events_offset_v1",
        text: `
          SELECT id, title, slug, description, categories,
                 created_at, start_date, end_date,
                 active, closed, archived,
                 volume, liquidity, open_interest, comment_count
          FROM events
          ORDER BY end_date NULLS LAST, id
          LIMIT $1 OFFSET $2
        `,
        values: [limit, offset],
      });
      rows = r.rows;
      const payload = { limit, offset, data: rows };
      cache.set(cacheKey, payload, 2_000);
      return res.json(payload);
    }

    const values = [limit];
    let where = "";
    if (cursorId !== null) {
      const cursorEndDateIso =
        cursorEndDate !== null ? new Date(cursorEndDate).toISOString() : "9999-12-31T23:59:59.999Z";
      values.push(cursorEndDateIso, cursorId);
      where = `
        WHERE (COALESCE(end_date, 'infinity'::timestamptz), id)
              > (COALESCE($2::timestamptz, 'infinity'::timestamptz), $3::bigint)
      `;
    }

    const r = await q({
      name: cursorId !== null ? "events_cursor_after_v1" : "events_cursor_first_v1",
      text: `
        SELECT id, title, slug, description, categories,
               created_at, start_date, end_date,
               active, closed, archived,
               volume, liquidity, open_interest, comment_count
        FROM events
        ${where}
        ORDER BY end_date NULLS LAST, id
        LIMIT $1
      `,
      values,
    });

    rows = r.rows;

    const last = rows[rows.length - 1];
    const nextCursor = last
      ? {
          cursor_end_date: last.end_date ? new Date(last.end_date).getTime() : null,
          cursor_id: last.id,
        }
      : null;

    const payload = { limit, data: rows, next: nextCursor };
    cache.set(cacheKey, payload, 2_000);
    res.json(payload);
  })
);

// GET /events/search?q=...&limit=50&cursor_end_date=...&cursor_id=...
app.get(
  "/events/search",
  asyncHandler(async (req, res) => {
    const limit = parseIntOr(50, req.query.limit, 1, 500);

    const qstrRaw = (req.query.q ?? "").toString().trim();
    if (!qstrRaw) {
      return res.status(400).json({ error: "Missing required query param: q" });
    }

    const active =
      req.query.active === undefined ? null : String(req.query.active).toLowerCase() === "true";
    const closed =
      req.query.closed === undefined ? null : String(req.query.closed).toLowerCase() === "true";
    const archived =
      req.query.archived === undefined ? null : String(req.query.archived).toLowerCase() === "true";

    const cursorEndDate = req.query.cursor_end_date ? parseInt(req.query.cursor_end_date, 10) : null; // unix ms
    const cursorId = req.query.cursor_id ? parseInt(req.query.cursor_id, 10) : null;

    const cacheKey = `events_search:${qstrRaw}:${active ?? "null"}:${closed ?? "null"}:${archived ?? "null"}:${limit}:${cursorEndDate ?? "null"}:${cursorId ?? "null"}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const values = [];
    let idx = 1;

    values.push(qstrRaw);
    const qPos = idx++;
    const conditions = [
      `
      to_tsvector(
        'english',
        COALESCE(title,'') || ' ' || COALESCE(slug,'') || ' ' || COALESCE(description,'')
      ) @@ websearch_to_tsquery('english', $${qPos})
      `,
    ];

    if (active !== null) {
      values.push(active);
      conditions.push(`active = $${idx++}`);
    }
    if (closed !== null) {
      values.push(closed);
      conditions.push(`closed = $${idx++}`);
    }
    if (archived !== null) {
      values.push(archived);
      conditions.push(`archived = $${idx++}`);
    }

    if (cursorId !== null) {
      const cursorEndDateIso =
        cursorEndDate !== null ? new Date(cursorEndDate).toISOString() : "9999-12-31T23:59:59.999Z";
      values.push(cursorEndDateIso, cursorId);
      const endDatePos = idx++;
      const idPos = idx++;
      conditions.push(`
        (COALESCE(end_date, 'infinity'::timestamptz), id)
        > (COALESCE($${endDatePos}::timestamptz, 'infinity'::timestamptz), $${idPos}::bigint)
      `);
    }

    values.push(limit);
    const limitPos = idx++;

    const { rows } = await q({
      name: cursorId !== null ? "events_search_cursor_after_v2" : "events_search_cursor_first_v2",
      text: `
        SELECT
          e.id, e.title, e.slug, e.description, e.categories,
          e.created_at, e.start_date, e.end_date,
          e.active, e.closed, e.archived,
          e.volume, e.liquidity, e.open_interest, e.comment_count,

          COALESCE(m.market_ids, '{}'::text[]) AS market_ids,
          COALESCE(m.market_count, 0) AS market_count

        FROM events e
        LEFT JOIN LATERAL (
          SELECT
            array_agg(mm.id::text ORDER BY mm.id) AS market_ids,
            count(*)::int AS market_count
          FROM markets mm
          WHERE mm.event_id = e.id
        ) m ON true

        WHERE ${conditions.join(" AND ")}
        ORDER BY e.end_date NULLS LAST, e.id
        LIMIT $${limitPos}
      `,
      values,
    });

    const last = rows[rows.length - 1];
    const nextCursor = last
      ? {
          cursor_end_date: last.end_date ? new Date(last.end_date).getTime() : null,
          cursor_id: last.id,
        }
      : null;

    const payload = {
      q: qstrRaw,
      filters: { active, closed, archived },
      limit,
      count: rows.length,
      next: nextCursor,
      data: rows,
    };

    cache.set(cacheKey, payload, 2_000);
    res.json(payload);
  })
);

// GET /events/:id/markets
app.get(
  "/events/:id/markets",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const limit = parseIntOr(100, req.query.limit, 1, 1000);

    const offset = req.query.offset !== undefined ? parseIntOr(0, req.query.offset, 0) : null;
    const cursorId = req.query.cursor_id ? parseInt(req.query.cursor_id, 10) : null;

    const useOffset = offset !== null;

    const cacheKey =
      useOffset
        ? `event_markets:offset:${id}:${limit}:${offset}`
        : `event_markets:cursor:${id}:${limit}:${cursorId ?? "null"}`;

    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    let rows;
    if (useOffset) {
      const r = await q({
        name: "markets_by_event_offset_v1",
        text: `
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
        values: [id, limit, offset],
      });
      rows = r.rows;
      const payload = { event_id: id, limit, offset, data: rows };
      cache.set(cacheKey, payload, 2_000);
      return res.json(payload);
    }

    const values = [id, limit];
    let where = "";
    if (cursorId !== null) {
      values.push(cursorId);
      where = `AND id > $3`;
    }

    const r = await q({
      name: cursorId !== null ? "markets_by_event_cursor_after_v1" : "markets_by_event_cursor_first_v1",
      text: `
        SELECT id, event_id, question, slug, description,
               created_at, start_date, end_date, deploying_timestamp,
               active, closed, archived, ready, funded, accepting_orders, neg_risk,
               volume_24h, volume_total, liquidity,
               order_min_size, order_price_min_tick_size
        FROM markets
        WHERE event_id = $1
        ${where}
        ORDER BY id
        LIMIT $2
      `,
      values,
    });

    rows = r.rows;
    const last = rows[rows.length - 1];
    const nextCursor = last ? { cursor_id: last.id } : null;

    const payload = { event_id: id, limit, data: rows, next: nextCursor };
    cache.set(cacheKey, payload, 2_000);
    res.json(payload);
  })
);

// GET /events/:id
app.get(
  "/events/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const cacheKey = `event:${id}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const { rows } = await q({
      name: "event_by_id_v1",
      text: `SELECT * FROM events WHERE id = $1`,
      values: [id],
    });

    if (!rows.length) return res.status(404).json({ error: "Event not found" });

    cache.set(cacheKey, rows[0], 5_000);
    res.json(rows[0]);
  })
);

/**
 * =========================
 * MARKETS
 * =========================
 */

// GET /markets
app.get(
  "/markets",
  asyncHandler(async (req, res) => {
    const limit = parseIntOr(50, req.query.limit, 1, 500);
    const min24hVolume = parseFloatOr(0, req.query.min24hVolume, 0);

    const offset = req.query.offset !== undefined ? parseIntOr(0, req.query.offset, 0) : null;

    const cursorVolume = req.query.cursor_volume !== undefined ? parseFloat(req.query.cursor_volume) : null;
    const cursorId = req.query.cursor_id ? parseInt(req.query.cursor_id, 10) : null;

    const useOffset = offset !== null;

    const cacheKey =
      useOffset
        ? `markets:offset:${min24hVolume}:${limit}:${offset}`
        : `markets:cursor:${min24hVolume}:${limit}:${cursorVolume ?? "null"}:${cursorId ?? "null"}`;

    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    let rows;
    if (useOffset) {
      const r = await q({
        name: "markets_offset_v1",
        text: `
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
        values: [min24hVolume, limit, offset],
      });
      rows = r.rows;
      const payload = { limit, offset, min24hVolume, data: rows };
      cache.set(cacheKey, payload, 2_000);
      return res.json(payload);
    }

    const values = [min24hVolume, limit];
    let where = "";

    if (cursorId !== null) {
      values.push(cursorVolume, cursorId);
      where = `
        AND (
          COALESCE(volume_24h, -1e308) < COALESCE($3::double precision, -1e308)
          OR (
            COALESCE(volume_24h, -1e308) = COALESCE($3::double precision, -1e308)
            AND id > $4::bigint
          )
        )
      `;
    }

    const r = await q({
      name: cursorId !== null ? "markets_cursor_after_v1" : "markets_cursor_first_v1",
      text: `
        SELECT id, event_id, question, slug, description,
               created_at, start_date, end_date, deploying_timestamp,
               active, closed, archived, ready, funded, accepting_orders, neg_risk,
               volume_24h, volume_total, liquidity,
               order_min_size, order_price_min_tick_size
        FROM markets
        WHERE (volume_24h IS NULL OR volume_24h >= $1)
        ${where}
        ORDER BY volume_24h DESC NULLS LAST, id
        LIMIT $2
      `,
      values,
    });

    rows = r.rows;
    const last = rows[rows.length - 1];
    const nextCursor = last ? { cursor_volume: last.volume_24h ?? null, cursor_id: last.id } : null;

    const payload = { limit, min24hVolume, data: rows, next: nextCursor };
    cache.set(cacheKey, payload, 2_000);
    res.json(payload);
  })
);

// GET /markets/:id  (with outcomes embedded)  — Express 5 safe
app.get(
  /^\/markets\/(\d+)$/,
  asyncHandler(async (req, res) => {
    const id = req.params[0]; // first capture group

    const cacheKey = `market_with_outcomes:${id}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const { rows } = await q({
      name: "market_by_id_with_outcomes_v1",
      text: `
        SELECT
          m.id,
          m.event_id,
          m.question,
          m.slug,
          m.description,
          m.created_at,
          m.start_date,
          m.end_date,
          m.deploying_timestamp,
          m.active,
          m.closed,
          m.archived,
          m.ready,
          m.funded,
          m.accepting_orders,
          m.neg_risk,
          m.volume_24h,
          m.volume_total,
          m.liquidity,
          m.order_min_size,
          m.order_price_min_tick_size,
          COALESCE(o.outcomes, '[]'::json) AS outcomes
        FROM markets m
        LEFT JOIN LATERAL (
          SELECT json_agg(
            json_build_object(
              'id', id,
              'outcome_index', outcome_index,
              'outcome', outcome,
              'token_id', token_id
            )
            ORDER BY outcome_index
          ) AS outcomes
          FROM outcomes
          WHERE market_id = m.id
        ) o ON true
        WHERE m.id = $1
        LIMIT 1
      `,
      values: [id],
    });

    if (!rows.length) return res.status(404).json({ error: "Market not found" });

    cache.set(cacheKey, rows[0], 5_000);
    res.json(rows[0]);
  })
);

/**
 * =========================
 * ORDERBOOKS (BIG TABLE)
 * =========================
 */

// GET /orderbooks
app.get(
  "/orderbooks",
  asyncHandler(async (req, res) => {
    const { market_id, asset_id, outcome } = req.query;
    const limit = parseIntOr(100, req.query.limit, 1, 1000);

    const outcomeIndex = parseOutcomeIndex(outcome);
    if (outcome !== undefined && outcomeIndex === null) {
      return res.status(400).json({ error: "Invalid outcome. Use yes/no or 0/1." });
    }

    const fromTs = req.query.from ? parseInt(req.query.from, 10) : null;
    const toTs = req.query.to ? parseInt(req.query.to, 10) : null;

    const cursorTs = req.query.cursor_ts ? parseInt(req.query.cursor_ts, 10) : null;

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
    if (outcomeIndex !== null) {
      conditions.push(`outcome_index = $${idx++}`);
      values.push(outcomeIndex);
    }

    if (!conditions.length) {
      return res.status(400).json({
        error: "Provide at least one filter: market_id or asset_id (and optionally outcome).",
      });
    }

    if (fromTs !== null && !Number.isNaN(fromTs)) {
      conditions.push(`ts >= $${idx++}`);
      values.push(fromTs);
    }
    if (toTs !== null && !Number.isNaN(toTs)) {
      conditions.push(`ts <= $${idx++}`);
      values.push(toTs);
    }
    if (cursorTs !== null && !Number.isNaN(cursorTs)) {
      conditions.push(`ts < $${idx++}`);
      values.push(cursorTs);
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    values.push(limit);
    const limitPos = values.length;

    const stmtName = `ob_filtered_${conditions.length}`;
    const { rows } = await q({
  	name: stmtName,
      	text: `
        SELECT ts, asset_id, market_id,
               outcome_index, bids, asks
        FROM orderbooks
        ${whereClause}
        ORDER BY ts DESC
        LIMIT $${limitPos}
      `,
      values,
    });

    const last = rows[rows.length - 1];
    const nextCursor = last ? { cursor_ts: last.ts } : null;

    res.json({
      filters: { market_id, asset_id, outcome, from: fromTs, to: toTs },
      limit,
      count: rows.length,
      next: nextCursor,
      data: rows,
    });
  })
);

// GET /orderbooks/latest
app.get(
  "/orderbooks/latest",
  asyncHandler(async (req, res) => {
    const { market_id, asset_id, outcome } = req.query;

    const outcomeIndex = parseOutcomeIndex(outcome);
    if (outcome !== undefined && outcomeIndex === null) {
      return res.status(400).json({ error: "Invalid outcome. Use yes/no or 0/1." });
    }

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
    if (outcomeIndex !== null) {
      conditions.push(`outcome_index = $${idx++}`);
      values.push(outcomeIndex);
    }

    if (!conditions.length) {
      return res.status(400).json({
        error: "Provide at least one filter: market_id, asset_id, or outcome",
      });
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const cacheKey = `orderbooks_latest:${values.join("|")}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const { rows } = await q({
      name: "orderbooks_latest_v2",
      text: `
        SELECT ts, asset_id, market_id,
               outcome_index, bids, asks
        FROM orderbooks
        ${whereClause}
        ORDER BY ts DESC
        LIMIT 1
      `,
      values,
    });

    if (!rows.length) return res.status(404).json({ error: "No orderbook snapshots found" });

    cache.set(cacheKey, rows[0], 500);
    res.json(rows[0]);
  })
);

// GET /orderbooks/:market_id
app.get(
  "/orderbooks/:market_id",
  asyncHandler(async (req, res) => {
    const { market_id } = req.params;
    const { outcome } = req.query;
    const limit = parseIntOr(100, req.query.limit, 1, 1000);

    const outcomeIndex = parseOutcomeIndex(outcome);
    if (outcome !== undefined && outcomeIndex === null) {
      return res.status(400).json({ error: "Invalid outcome. Use yes/no or 0/1." });
    }

    const fromTs = req.query.from ? parseInt(req.query.from, 10) : null;
    const toTs = req.query.to ? parseInt(req.query.to, 10) : null;
    const cursorTs = req.query.cursor_ts ? parseInt(req.query.cursor_ts, 10) : null;

    const conditions = [`market_id = $1`];
    const values = [String(market_id)];
    let idx = 2;

    if (outcomeIndex !== null) {
      conditions.push(`outcome_index = $${idx++}`);
      values.push(outcomeIndex);
    }
    if (fromTs !== null && !Number.isNaN(fromTs)) {
      conditions.push(`ts >= $${idx++}`);
      values.push(fromTs);
    }
    if (toTs !== null && !Number.isNaN(toTs)) {
      conditions.push(`ts <= $${idx++}`);
      values.push(toTs);
    }
    if (cursorTs !== null && !Number.isNaN(cursorTs)) {
      conditions.push(`ts < $${idx++}`);
      values.push(cursorTs);
    }

    values.push(limit);
    const limitPos = values.length;

    const stmtName = `ob_market_${conditions.length}`;
    const { rows } = await q({
        name: stmtName,
        text: `
        SELECT ts, asset_id, market_id,
               outcome_index, bids, asks
        FROM orderbooks
        WHERE ${conditions.join(" AND ")}
        ORDER BY ts DESC
        LIMIT $${limitPos}
      `,
      values,
    });

    const last = rows[rows.length - 1];
    const nextCursor = last ? { cursor_ts: last.ts } : null;

    res.json({
      market_id: String(market_id),
      filters: { outcome: outcome ?? null, from: fromTs ?? null, to: toTs ?? null },
      limit,
      count: rows.length,
      next: nextCursor,
      data: rows,
    });
  })
);

/**
 * =========================
 * DB SIZE STATS
 * =========================
 */

// GET /stats/db-size
app.get(
  "/stats/db-size",
  asyncHandler(async (req, res) => {
    const dbSizeResult = await q({
      name: "db_size_v1",
      text: `
        SELECT current_database() AS db_name,
               pg_database_size(current_database()) AS size_bytes
      `,
      values: [],
    });

    const dbRow = dbSizeResult.rows[0];
    const dbSizeBytes = Number(dbRow.size_bytes);

    const tablesResult = await q({
      name: "tables_size_v1",
      text: `
        SELECT relname AS table_name,
               pg_total_relation_size(relid) AS size_bytes
        FROM pg_catalog.pg_statio_user_tables
        WHERE relname IN ('events', 'markets', 'outcomes', 'orderbooks')
        ORDER BY size_bytes DESC
      `,
      values: [],
    });

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
  })
);

// --- ERROR HANDLER (must be last) ---
app.use((err, req, res, next) => {
  console.error("API error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// --- START SERVER ---
app.listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`);
});

// Optional: graceful shutdown
process.on("SIGINT", async () => {
  console.log("\nShutting down server...");
  await pool.end();
  process.exit(0);
});
