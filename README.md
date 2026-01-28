# Polymarket API Documentation

A REST API for accessing Polymarket prediction market data including events, markets, and orderbook snapshots.

**Base URL:** `https://your-api-domain.com`

---

## Quick Start Walkthrough

Here's a complete workflow to find an event, explore its markets, and fetch orderbook data:

### Step 1: Search for an Event

Find events related to "election":

```bash
curl "https://your-api-domain.com/events/search?q=election&limit=5"
```

Response:
```json
{
  "q": "election",
  "filters": { "active": null, "closed": null, "archived": null },
  "limit": 5,
  "count": 5,
  "next": { "cursor_end_date": 1735689600000, "cursor_id": 12345 },
  "data": [
    {
      "id": 101,
      "title": "2024 Presidential Election",
      "slug": "2024-presidential-election",
      "volume": 15000000,
      "market_ids": ["5001", "5002", "5003"],
      "market_count": 3
    }
  ]
}
```

### Step 2: Get Markets for the Event

Fetch all markets associated with event ID `101`:

```bash
curl "https://your-api-domain.com/events/101/markets"
```

Response:
```json
{
  "event_id": "101",
  "limit": 100,
  "data": [
    {
      "id": 5001,
      "event_id": 101,
      "question": "Will candidate A win?",
      "volume_24h": 250000,
      "liquidity": 500000,
      "active": true,
      "closed": false
    },
    {
      "id": 5002,
      "event_id": 101,
      "question": "Will candidate B win?",
      "volume_24h": 180000,
      "liquidity": 420000,
      "active": true,
      "closed": false
    }
  ],
  "next": null
}
```

### Step 3: Get Market Details with Outcomes

Fetch market `5001` to see its token IDs:

```bash
curl "https://your-api-domain.com/markets/5001"
```

Response:
```json
{
  "id": 5001,
  "event_id": 101,
  "question": "Will candidate A win?",
  "outcomes": [
    { "id": 1, "outcome_index": 0, "outcome": "Yes", "token_id": "abc123..." },
    { "id": 2, "outcome_index": 1, "outcome": "No", "token_id": "def456..." }
  ]
}
```

### Step 4: Get Latest Orderbook

Fetch the most recent orderbook snapshot for market `5001`:

```bash
curl "https://your-api-domain.com/orderbooks/latest?market_id=5001"
```

Response:
```json
{
  "ts": 1706000000000,
  "asset_id": "abc123...",
  "market_id": "5001",
  "outcome_index": 0,
  "bids": [[0.55, 1000], [0.54, 2500], [0.53, 5000]],
  "asks": [[0.56, 800], [0.57, 1500], [0.58, 3000]]
}
```

---

## Rate Limits

| Scope | Limit | Window |
|-------|-------|--------|
| **Global (all endpoints)** | 60 requests | 1 minute |
| **Orderbooks endpoints** | 30 requests | 1 minute |

Rate limit headers are included in responses:
- `RateLimit-Limit` – Maximum requests allowed
- `RateLimit-Remaining` – Requests remaining in current window
- `RateLimit-Reset` – Time when the rate limit resets

When rate limited, you'll receive a `429 Too Many Requests` response.

---

## Pagination

The API supports two pagination methods:

### Cursor-based (Recommended)
Use the `next` object returned in responses. Pass the cursor values to fetch the next page:

```bash
# First request
curl "https://your-api-domain.com/events?limit=50"

# Next page (using cursor from response)
curl "https://your-api-domain.com/events?limit=50&cursor_end_date=1735689600000&cursor_id=12345"
```

### Offset-based
Traditional offset pagination (less efficient for large datasets):

```bash
curl "https://your-api-domain.com/events?limit=50&offset=100"
```

---

## Endpoints

### Health Check

#### `GET /health`

Check API status.

```bash
curl "https://your-api-domain.com/health"
```

Response:
```json
{ "status": "ok", "time": "2024-01-23T12:00:00.000Z" }
```

---

### Events

#### `GET /events`

List all events, ordered by end date.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | 50 | Results per page (1-500) |
| `offset` | integer | — | Offset for pagination |
| `cursor_end_date` | integer | — | Unix timestamp (ms) from previous response |
| `cursor_id` | integer | — | Event ID from previous response |

```bash
# Get first 20 events
curl "https://your-api-domain.com/events?limit=20"

# Get next page using cursor
curl "https://your-api-domain.com/events?limit=20&cursor_end_date=1735689600000&cursor_id=500"
```

---

#### `GET /events/search`

Search events by text query.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `q` | string | **required** | Search query |
| `limit` | integer | 50 | Results per page (1-500) |
| `active` | boolean | — | Filter by active status |
| `closed` | boolean | — | Filter by closed status |
| `archived` | boolean | — | Filter by archived status |
| `cursor_end_date` | integer | — | Cursor for pagination |
| `cursor_id` | integer | — | Cursor for pagination |

```bash
# Search for crypto events
curl "https://your-api-domain.com/events/search?q=bitcoin"

# Search active sports events only
curl "https://your-api-domain.com/events/search?q=superbowl&active=true&closed=false"
```

Response includes `market_ids` and `market_count` for each event.

---

#### `GET /events/:id`

Get a single event by ID.

```bash
curl "https://your-api-domain.com/events/101"
```

---

#### `GET /events/:id/markets`

Get all markets belonging to an event.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | 100 | Results per page (1-1000) |
| `offset` | integer | — | Offset for pagination |
| `cursor_id` | integer | — | Market ID cursor for pagination |

```bash
curl "https://your-api-domain.com/events/101/markets?limit=50"
```

---

### Markets

#### `GET /markets`

List all markets, ordered by 24h volume (descending).

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | 50 | Results per page (1-500) |
| `min24hVolume` | number | 0 | Minimum 24h volume filter |
| `offset` | integer | — | Offset for pagination |
| `cursor_volume` | number | — | Volume cursor for pagination |
| `cursor_id` | integer | — | Market ID cursor for pagination |

```bash
# Get top markets by volume
curl "https://your-api-domain.com/markets?limit=10"

# Get markets with at least $10,000 daily volume
curl "https://your-api-domain.com/markets?min24hVolume=10000"
```

---

#### `GET /markets/:id`

Get a single market with its outcomes/tokens.

```bash
curl "https://your-api-domain.com/markets/5001"
```

Response:
```json
{
  "id": 5001,
  "event_id": 101,
  "question": "Will candidate A win?",
  "active": true,
  "closed": false,
  "volume_24h": 250000,
  "volume_total": 5000000,
  "liquidity": 500000,
  "outcomes": [
    { "id": 1, "outcome_index": 0, "outcome": "Yes", "token_id": "abc123..." },
    { "id": 2, "outcome_index": 1, "outcome": "No", "token_id": "def456..." }
  ]
}
```

---

### Orderbooks

Orderbook endpoints have stricter rate limits (30/min). Each snapshot contains bid/ask arrays as `[price, size]` tuples.

#### `GET /orderbooks`

Query orderbook snapshots with filters.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `market_id` | string | — | Filter by market ID |
| `asset_id` | string | — | Filter by asset/token ID |
| `outcome` | string | — | Filter by outcome name |
| `from` | integer | — | Start timestamp (ms) |
| `to` | integer | — | End timestamp (ms) |
| `limit` | integer | 100 | Results per page (1-1000) |
| `cursor_ts` | integer | — | Timestamp cursor for pagination |

**Note:** At least one of `market_id` or `asset_id` is required.

```bash
# Get orderbook history for a market
curl "https://your-api-domain.com/orderbooks?market_id=5001&limit=50"

# Get orderbooks in a time range
curl "https://your-api-domain.com/orderbooks?market_id=5001&from=1705900000000&to=1706000000000"
```

---

#### `GET /orderbooks/latest`

Get the most recent orderbook snapshot for a market or asset.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `market_id` | string | — | Filter by market ID |
| `asset_id` | string | — | Filter by asset/token ID |
| `outcome` | string | — | Filter by outcome name |

**Note:** At least one filter is required.

```bash
# Get latest orderbook for a market
curl "https://your-api-domain.com/orderbooks/latest?market_id=5001"

# Get latest orderbook for a specific token
curl "https://your-api-domain.com/orderbooks/latest?asset_id=abc123..."
```

---

#### `GET /orderbooks/:market_id`

Get orderbook snapshots for a specific market (convenience endpoint).

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `outcome` | string | — | Filter by outcome name |
| `from` | integer | — | Start timestamp (ms) |
| `to` | integer | — | End timestamp (ms) |
| `limit` | integer | 100 | Results per page (1-1000) |
| `cursor_ts` | integer | — | Timestamp cursor for pagination |

```bash
curl "https://your-api-domain.com/orderbooks/5001?limit=100"
```

---

### Statistics

#### `GET /stats/db-size`

Get database size statistics.

```bash
curl "https://your-api-domain.com/stats/db-size"
```

Response:
```json
{
  "database": "defaultdb",
  "size_bytes": 5368709120,
  "size_pretty": "5.00 GB",
  "tables": [
    { "table": "orderbooks", "size_bytes": 4294967296, "size_pretty": "4.00 GB" },
    { "table": "markets", "size_bytes": 536870912, "size_pretty": "512.00 MB" },
    { "table": "events", "size_bytes": 268435456, "size_pretty": "256.00 MB" },
    { "table": "outcomes", "size_bytes": 134217728, "size_pretty": "128.00 MB" }
  ]
}
```

---

## Error Responses

All errors follow this format:

```json
{ "error": "Error message description" }
```

| Status Code | Description |
|-------------|-------------|
| `400` | Bad request (missing required parameters) |
| `404` | Resource not found |
| `429` | Rate limit exceeded |
| `500` | Internal server error |

---

## Response Caching

Responses are cached briefly (2-5 seconds) to improve performance. For real-time data, the `/orderbooks/latest` endpoint has a 500ms cache TTL.