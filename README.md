# poly-data API

REST API for historical Polymarket data — events, markets, outcomes, and orderbook snapshots.

**Base URL:** `http://api.poly-data.xyz`

---

## Rate Limits

| Scope | Limit |
|---|---|
| Global | 60 req/min per IP |
| `/orderbooks` | 30 req/min per IP |

---

## Pagination

Most list endpoints support two pagination modes:

- **Cursor-based** (default, recommended): pass `cursor_id` / `cursor_ts` / `cursor_end_date` from the `next` field of the previous response.
- **Offset-based**: pass `offset=<n>` explicitly.

When a `next` field is `null`, you've reached the end of the results.

---

## Endpoints

### Health

#### `GET /health`
Returns server status.

```json
{ "status": "ok", "time": "2025-01-01T00:00:00.000Z" }
```

---

### Events

#### `GET /events`
List all events, ordered by `end_date`.

| Param | Type | Default | Description |
|---|---|---|---|
| `limit` | int | 50 | Max 500 |
| `offset` | int | — | Enables offset mode |
| `cursor_end_date` | int | — | Unix ms, from `next` |
| `cursor_id` | int | — | From `next` |

---

#### `GET /events/search`
Full-text search across event title, slug, and description.

| Param | Type | Required | Description |
|---|---|---|---|
| `q` | string | ✅ | Search query |
| `limit` | int | — | Default 50, max 500 |
| `active` | bool | — | Filter by active status |
| `closed` | bool | — | Filter by closed status |
| `archived` | bool | — | Filter by archived status |
| `cursor_end_date` | int | — | Unix ms, from `next` |
| `cursor_id` | int | — | From `next` |

Response also includes `market_ids[]` and `market_count` per event.

---

#### `GET /events/:id`
Get a single event by ID.

---

#### `GET /events/:id/markets`
List all markets belonging to an event.

| Param | Type | Default | Description |
|---|---|---|---|
| `limit` | int | 100 | Max 1000 |
| `offset` | int | — | Enables offset mode |
| `cursor_id` | int | — | From `next` |

---

### Markets

#### `GET /markets`
List markets, ordered by `volume_24h` descending.

| Param | Type | Default | Description |
|---|---|---|---|
| `limit` | int | 50 | Max 500 |
| `min24hVolume` | float | 0 | Minimum 24h volume filter |
| `offset` | int | — | Enables offset mode |
| `cursor_volume` | float | — | From `next` |
| `cursor_id` | int | — | From `next` |

---

#### `GET /markets/:id`
Get a single market by ID, with its outcomes embedded.

```json
{
  "id": 123,
  "question": "...",
  "outcomes": [
    { "id": 1, "outcome_index": 0, "outcome": "Yes", "token_id": "..." },
    { "id": 2, "outcome_index": 1, "outcome": "No",  "token_id": "..." }
  ]
}
```

---

### Orderbooks

Orderbook snapshots are stored as timestamped `bids` / `asks` arrays per outcome.

#### `GET /orderbooks`
Query snapshots with flexible filters. **At least one of `market_id` or `asset_id` is required.**

| Param | Type | Description |
|---|---|---|
| `market_id` | string | Filter by market |
| `asset_id` | string | Filter by asset/token |
| `outcome` | string | `yes` / `no` / `0` / `1` |
| `from` | int | Unix ms lower bound on `ts` |
| `to` | int | Unix ms upper bound on `ts` |
| `limit` | int | Default 100, max 1000 |
| `cursor_ts` | int | From `next`, paginates backwards in time |

---

#### `GET /orderbooks/latest`
Get the single most recent snapshot matching the given filters. Same filter params as above (at least one required). Returns `404` if nothing is found.

---

#### `GET /orderbooks/:market_id`
Shorthand to query snapshots for a specific market.

| Param | Type | Description |
|---|---|---|
| `outcome` | string | `yes` / `no` / `0` / `1` |
| `from` | int | Unix ms lower bound |
| `to` | int | Unix ms upper bound |
| `limit` | int | Default 100, max 1000 |
| `cursor_ts` | int | From `next` |

---

### Stats

#### `GET /stats/db-size`
Returns database and per-table size information.

```json
{
  "database": "polymarket",
  "size_bytes": 12345678,
  "size_pretty": "11.77 MB",
  "tables": [
    { "table": "orderbooks", "size_bytes": 9876543, "size_pretty": "9.42 MB" },
    ...
  ]
}
```

---

## Example Requests

```bash
# Search for active US election markets
curl "http://api.poly-data.xyz/events/search?q=election&active=true"

# Get a market with its outcomes
curl "http://api.poly-data.xyz/markets/12345"

# Fetch the latest orderbook snapshot for a market
curl "http://api.poly-data.xyz/orderbooks/latest?market_id=12345&outcome=yes"

# Page through orderbook history
curl "http://api.poly-data.xyz/orderbooks/12345?limit=200&from=1700000000000&to=1710000000000"

# Next page using cursor from previous response
curl "http://api.poly-data.xyz/orderbooks/12345?limit=200&cursor_ts=1705000000000"
```

---

## Data Model

| Table | Description |
|---|---|
| `events` | Top-level prediction market events |
| `markets` | Individual binary markets within an event |
| `outcomes` | Yes/No outcome tokens per market |
| `orderbooks` | Time-series snapshots of bids/asks per outcome |