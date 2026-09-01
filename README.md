# Video QoE & CDN Analytics

A complete NPAW/Conviva-style video analytics system for measuring Quality of Experience (QoE) and CDN performance across Web, iOS, Android, and Smart TV platforms.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  CLIENT LAYER                                                       │
│                                                                     │
│  Web (hls.js / dash.js / Shaka)  ──┐                               │
│  iOS (AVPlayer)                  ──┤                               │
│  Android (ExoPlayer / Media3)    ──┼──▶  SDK Core                  │
│  Tizen (AVPlay)                  ──┤    (batching, queue, retry)   │
│  webOS (HTML5 video)             ──┤                               │
│  Android TV                      ──┤                               │
│  Roku (BrightScript)             ──┘                               │
└──────────────────────────┬──────────────────────────────────────────┘
                           │  HTTP POST /v1/collect
                           │  (JSON batch, async, sendBeacon on unload)
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│  COLLECTOR (Fastify / Node.js)                                      │
│                                                                     │
│  1. Parse + validate (Ajv)                                          │
│  2. Extract client IP → geo-IP lookup (MaxMind GeoLite2)           │
│  3. Hash IP (SHA-256) — raw IP never stored                        │
│  4. Enrich events with geo/ISP fields                              │
│  5. Insert to ClickHouse (async_insert, fire-and-forget)           │
│  6. Return 202 Accepted                                            │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│  CLICKHOUSE                                                         │
│                                                                     │
│  analytics_events (raw, 90d TTL)                                    │
│       │                                                             │
│       ├──▶ mv_sessions      → analytics_sessions                   │
│       ├──▶ mv_heartbeats    → analytics_heartbeats                 │
│       ├──▶ mv_cdn_requests  → analytics_cdn_requests               │
│       ├──▶ mv_errors        → analytics_errors                     │
│       ├──▶ mv_qoe_hourly    → analytics_qoe_hourly (AggMT)         │
│       └──▶ mv_concurrent_viewers → analytics_concurrent_viewers    │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│  GRAFANA (grafana-clickhouse-datasource)                            │
│                                                                     │
│  D1: Real-time Overview    D5: Content Performance                  │
│  D2: QoE Trends            D6: Error Drill-down                    │
│  D3: CDN Comparison ★      D7: Live Streaming                       │
│  D4: Geo / Platform        D8: VOD Analytics                        │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
video-analytics/
├── schema/
│   ├── events.ts                  TypeScript types (source of truth)
│   └── event-batch-schema.ts      Ajv JSON Schema + per-event payload schemas
│
├── sdk/
│   ├── core/                      Platform-agnostic core (TS)
│   │   ├── AnalyticsCore.ts       Public API entry point
│   │   ├── SessionManager.ts      Session lifecycle + metrics
│   │   ├── EventQueue.ts          Batching, sendBeacon, retry
│   │   ├── utils.ts               UUID, SHA-256, backoff, logger
│   │   └── types.ts               Internal SDK types
│   │
│   ├── web/                       Browser SDK (TypeScript)
│   │   ├── WebAdapter.ts          Base HTML5 <video> adapter
│   │   ├── HlsJsAdapter.ts        hls.js adapter
│   │   ├── DashJsAdapter.ts       dash.js adapter
│   │   └── ShakaAdapter.ts        Shaka Player adapter
│   │
│   ├── ios/                       iOS / tvOS SDK (Swift)
│   │   ├── AVPlayerAdapter.swift  KVO + access log + NWPathMonitor
│   │   ├── AnalyticsSessionManager.swift
│   │   ├── AnalyticsEventQueue.swift
│   │   └── VideoAnalyticsEvent.swift
│   │
│   ├── android/                   Android / Android TV SDK (Kotlin)
│   │   ├── ExoPlayerAdapter.kt    AnalyticsListener + lifecycle
│   │   ├── AnalyticsSessionManager.kt
│   │   └── AnalyticsEventQueue.kt
│   │
│   └── smarttv/
│       ├── TizenAdapter.ts        Samsung Tizen (AVPlay)
│       ├── WebOsAdapter.ts        LG webOS (HTML5 video)
│       ├── AndroidTvAdapter.kt    Android TV (wraps ExoPlayerAdapter)
│       ├── RokuAdapter.brs        Roku (BrightScript)
│       └── PLATFORM-NOTES.md     Firmware quirks + CDN detection guide
│
├── backend/
│   ├── src/
│   │   ├── server.ts              Fastify app (helmet/cors/compress/rate-limit)
│   │   ├── config.ts              Env-var config loader
│   │   ├── routes/collect.ts      POST /v1/collect  GET /health  GET /ready
│   │   └── services/
│   │       ├── validator.ts       Ajv validation (envelope + per-event payload)
│   │       ├── geoip.ts           MaxMind lookup + IP extraction
│   │       └── clickhouse.ts      @clickhouse/client writer
│   ├── Dockerfile
│   ├── package.json
│   └── .env.example
│
├── clickhouse/
│   ├── schema.sql                 8 tables (raw events, sessions, CDN, errors, aggregates)
│   ├── materialized-views.sql     7 MVs + 3 read-time merge views
│   ├── indexes.sql                Bloom filter skip indexes
│   └── retention.sql              TTL management + storage reports
│
├── grafana/
│   ├── provisioning/datasources/clickhouse.yaml
│   └── queries/
│       ├── 00_grafana_variables.sql   Dashboard variable definitions + alert rules
│       ├── 01_realtime_overview.sql
│       ├── 02_qoe_trends.sql
│       ├── 03_cdn_comparison.sql      ★ CDN scorecard
│       ├── 04_geo_platform_breakdown.sql
│       ├── 05_content_performance.sql
│       ├── 06_error_drilldown.sql
│       ├── 07_live_streaming.sql
│       └── 08_vod_analytics.sql
│
└── docker-compose.yml             Full local stack (clickhouse + collector + grafana)
```

---

## Quick Start (Local)

### Prerequisites
- Docker + Docker Compose
- Node.js 20+ (for local backend dev)
- MaxMind GeoLite2 databases (free — see below)

### 1. Get GeoIP databases

Register at [maxmind.com](https://www.maxmind.com/en/geolite2/signup) and download:
- `GeoLite2-City.mmdb`
- `GeoLite2-ASN.mmdb`

Place both files in `./geoip/`.

### 2. Start the stack

```bash
docker compose up -d
```

Services:
| Service | URL |
|---|---|
| Collector API | http://localhost:3000 |
| ClickHouse HTTP | http://localhost:8123 |
| Grafana | http://localhost:3001 (admin / analytics) |

### 3. Verify

```bash
curl http://localhost:3000/health
# {"status":"ok","ts":1234567890}

curl http://localhost:3000/ready
# {"status":"ready"}
```

### 4. Send a test event batch

```bash
curl -X POST http://localhost:3000/v1/collect \
  -H "Content-Type: application/json" \
  -d '{
    "sdk_version": "1.0.0",
    "sent_at": 1700000000000,
    "events": [{
      "session_id": "550e8400-e29b-41d4-a716-446655440000",
      "event_type": "SESSION_START",
      "timestamp": 1700000000000,
      "platform": "web",
      "seq": 1,
      "content": {
        "content_id": "test-001",
        "type": "vod",
        "title": "Test Video",
        "duration_s": 3600
      },
      "player": {
        "engine": "hls.js",
        "engine_version": "1.4.0",
        "sdk_version": "1.0.0"
      },
      "network": { "connection_type": "wifi" },
      "device": { "os": "macos", "os_version": "14.0", "model": "browser" },
      "payload": { "autoplay": false }
    }]
  }'
# {"accepted":1,"rejected":0,"request_id":"..."}
```

### 5. Backend development

```bash
cd backend
cp .env.example .env
npm install
npm run dev
```

---

## SDK Integration

### Web — hls.js

```typescript
import { HlsJsAdapter } from './sdk/web';
import Hls from 'hls.js';

const hls = new Hls();
hls.loadSource('https://cdn.example.com/stream.m3u8');
hls.attachMedia(videoElement);

const adapter = new HlsJsAdapter({
  videoElement,
  hlsInstance: hls,
  content: {
    content_id: 'channel-1',
    type: 'live',
    title: 'RAI 1',
    duration_s: null
  },
  sdkConfig: {
    collectorUrl: 'https://analytics.yourcompany.com/v1/collect',
    sdkVersion: '1.0.0'
  }
});

await adapter.attach();
```

For **dash.js** use `DashJsAdapter`, for **Shaka** use `ShakaAdapter`, for plain HTML5 use `WebAdapter`. All share the same options shape — only the engine-specific instance changes.

### iOS (Swift)

```swift
let options = AVPlayerAdapter.Options(
    player: avPlayer,
    content: AnalyticsContentInfo(
        contentId: "vod-123", type: .vod,
        title: "Il Commissario Montalbano", durationS: 5400
    ),
    config: AnalyticsConfig(
        collectorUrl: "https://analytics.yourcompany.com/v1/collect",
        sdkVersion: "1.0.0"
    )
)
let adapter = AVPlayerAdapter(options: options)
adapter.attach()
// adapter.detach() on viewWillDisappear
```

### Android (Kotlin)

```kotlin
val adapter = ExoPlayerAdapter(
    context = this,
    player  = exoPlayer,
    content = AnalyticsContentInfo("live-rai2", AnalyticsContentType.LIVE, "RAI 2", null),
    config  = AnalyticsConfig(
        collectorUrl = "https://analytics.yourcompany.com/v1/collect",
        sdkVersion   = "1.0.0"
    )
)
lifecycle.addObserver(adapter)  // auto attach/detach
```

### Smart TV

| Platform | SDK |
|---|---|
| Samsung Tizen (AVPlay) | `TizenAdapter` (TypeScript) |
| LG webOS | `WebOsAdapter` (TypeScript) |
| Android TV / Fire TV | `AndroidTvAdapter` (Kotlin) |
| Roku | `RokuAdapter.brs` (BrightScript) |

See `sdk/smarttv/PLATFORM-NOTES.md` for firmware compatibility matrix and CDN detection strategies per platform.

---

## Event Schema

Every event sent by every SDK follows the same envelope:

```json
{
  "session_id": "uuid-v4",
  "event_type": "HEARTBEAT",
  "timestamp": 1700000000000,
  "platform": "ios",
  "seq": 42,
  "content":  { "content_id": "…", "type": "live", "title": "…", "duration_s": null },
  "player":   { "engine": "avplayer", "engine_version": "17.0", "sdk_version": "1.0.0" },
  "network":  { "connection_type": "wifi", "cdn": "akamai" },
  "device":   { "os": "ios", "os_version": "17.0", "model": "iPhone16,2" },
  "payload":  { "playback_position_s": 120.5, "current_bitrate_kbps": 2500, … }
}
```

The full TypeScript type definition is in `schema/events.ts`. The Ajv validation schema is in `schema/event-batch-schema.ts`.

### Event types

| Category | Events |
|---|---|
| Session lifecycle | `SESSION_START`, `PLAY_REQUEST`, `FIRST_FRAME`, `PAUSE`, `RESUME`, `SEEK`, `STOP`, `SESSION_END` |
| Heartbeat | `HEARTBEAT` (every 15s — used for watch time and zombie detection) |
| Buffering | `BUFFERING_START`, `BUFFERING_END` |
| Quality | `BITRATE_CHANGE` |
| Errors | `ERROR` (with VSF / EBVS flags) |
| CDN | `CDN_REQUEST`, `CDN_SWITCH` |
| Live | `JOIN_TIME`, `LIVE_LATENCY`, `MANIFEST_ERROR` |
| Ads | `AD_BREAK_START`, `AD_BREAK_END`, `AD_QUARTILE`, `AD_ERROR` |

---

## ClickHouse Data Model

### Tables

| Table | Content | Retention |
|---|---|---|
| `analytics_events` | All raw events | 90 days |
| `analytics_events_invalid` | Validation failures | 30 days |
| `analytics_sessions` | One row per SESSION_END | 1 year |
| `analytics_heartbeats` | Heartbeat snapshots | 30 days |
| `analytics_cdn_requests` | Per-segment CDN metrics | 30 days |
| `analytics_errors` | Denormalised error events | 90 days |
| `analytics_qoe_hourly` | Pre-aggregated QoE rollup | 2 years |
| `analytics_concurrent_viewers` | Per-minute viewer counts | 90 days |

### Materialized views pipeline

```
analytics_events
  ├─▶ mv_sessions        → analytics_sessions
  ├─▶ mv_heartbeats      → analytics_heartbeats
  ├─▶ mv_cdn_requests    → analytics_cdn_requests
  ├─▶ mv_errors          → analytics_errors
  ├─▶ mv_startup_times   → analytics_startup_times (ReplacingMergeTree)
  └─▶ mv_qoe_hourly      → analytics_qoe_hourly (AggregatingMergeTree)

analytics_heartbeats
  └─▶ mv_concurrent_viewers → analytics_concurrent_viewers (AggregatingMergeTree)
```

Read-time merge views (`v_qoe_hourly`, `v_concurrent_viewers`) call `*Merge()` aggregate combiners so Grafana queries never touch partially-merged state.

---

## Dashboards

| # | Dashboard | Key metric | Source table |
|---|---|---|---|
| 1 | Real-time Overview | Concurrent viewers, error rate | `analytics_concurrent_viewers` |
| 2 | QoE Trends | Startup time, rebuffering ratio | `v_qoe_hourly` |
| **3** | **CDN Comparison** | **Rebuffer/error/throughput per CDN** | `analytics_cdn_requests`, `analytics_sessions` |
| 4 | Geo / Platform | Country map, platform pie | `analytics_sessions` |
| 5 | Content Performance | Top assets, abandonment curve | `analytics_sessions` |
| 6 | Error Drill-down | Error distribution, VSF breakdown | `analytics_errors` |
| 7 | Live Streaming | Join time, live latency, manifest errors | `analytics_events` |
| 8 | VOD Analytics | Completion rate, drop-off curve | `analytics_sessions` |
| 9 | Playback Quality | Buffer health, frame drops, bandwidth estimate | `analytics_heartbeats` |

All SQL queries are in `grafana/queries/`. Variable definitions and alert rules are in `00_grafana_variables.sql`.

### Setting up Grafana

1. Open http://localhost:3001 (admin / analytics)
2. The ClickHouse datasource is auto-provisioned from `grafana/provisioning/`
3. Create a new dashboard, add a panel, select **ClickHouse** datasource
4. Paste any query from `grafana/queries/` — replace `$__timeFrom`/`$__timeTo` with the Grafana time range macro

---

## Key Metrics Definitions

| Metric | Formula | Source |
|---|---|---|
| Startup Time | `FIRST_FRAME.timestamp − PLAY_REQUEST.timestamp` | SDK (client-computed) |
| Rebuffering Ratio | `total_rebuffer_time_s / watch_time_s` | SESSION_END payload |
| Rebuffering Count | count of BUFFERING_START events | SESSION_END payload |
| Error Rate | `sessions_with_error / total_sessions` | analytics_sessions |
| VSF Rate | `sessions_where_error_before_first_frame / total` | analytics_errors.video_start_failure |
| EBVS Rate | `sessions_where_user_left_during_load / total` | analytics_errors.exit_before_start |
| Completion % | `last_position_s / duration_s * 100` | SESSION_END payload (VOD) |
| Live Join Time | `FIRST_FRAME.timestamp − channel_selection_time` | JOIN_TIME event |
| Live Latency | edge clock − player clock (measured by player) | LIVE_LATENCY event |
| CDN Throughput | `bytes * 8 / download_duration_ms` | CDN_REQUEST payload |

---

## Non-functional Design

### SDK performance
- All sends are **async fire-and-forget** — the player thread is never blocked
- In-memory event queue with configurable size cap (default 1000 events)
- Exponential back-off with full jitter for failed sends
- `navigator.sendBeacon` (Web) / synchronous URLSession (iOS) / `flushBlocking` (Android) guarantee delivery on page/app teardown
- Heartbeat timer drives zombie session detection: sessions with no activity for `2 × heartbeatInterval + 5s` are auto-closed

### Privacy (GDPR)
- Raw IP addresses are **never stored** — hashed with SHA-256 server-side before writing to ClickHouse
- User IDs are hashed client-side before being placed in any event payload
- Page URLs are sanitised (path only, no query string / fragment) before sending
- Geo and ISP data is derived server-side from IP — client never computes or sends location

### Backend resilience
- Rate limiting: 300 req/min per IP (configurable)
- Body size limit: 2 MB
- ClickHouse `async_insert` absorbs write bursts; collector returns 202 before CH confirms
- Invalid events are quarantined to `analytics_events_invalid` — never silently dropped
- `/ready` endpoint checks ClickHouse connectivity for orchestrator health gates

### Data retention
| Data | Retention | Rationale |
|---|---|---|
| Raw events | 90 days | Hot data for drill-downs |
| CDN requests / heartbeats | 30 days | High volume, short operational value |
| Session summaries | 1 year | KPI trending |
| Hourly aggregates | 2 years | Long-term capacity planning |

---

## Production Deployment

### Scaling the collector

The collector is stateless — run multiple replicas behind a load balancer:

```
Internet → CDN/LB → collector-1 ─┐
                  → collector-2 ─┼──▶ ClickHouse cluster
                  → collector-3 ─┘
```

A single Fastify instance on a 2 vCPU node can handle ~5000 req/s given that each request is lightweight (validate → enrich → async CH insert → 202).

### ClickHouse sizing

| Events/day | Storage (compressed) | Recommended setup |
|---|---|---|
| < 10M | ~1 GB/day | Single node, 4 vCPU, 16 GB RAM |
| 10M–100M | ~5 GB/day | Single node, 16 vCPU, 64 GB RAM |
| > 100M | ~50 GB/day | ReplicatedMergeTree + 3-node cluster |

For single-node deployments, remove the `Replicated` prefix from engine names in `schema.sql`.

### Environment variables

Copy `backend/.env.example` to `backend/.env` and set:

| Variable | Description |
|---|---|
| `COLLECTOR_URL` | Collector endpoint (used by SDKs) |
| `CLICKHOUSE_HOST` | ClickHouse HTTP endpoint |
| `CLICKHOUSE_PASSWORD` | ClickHouse password |
| `GEOIP_DB_PATH` | Path to GeoLite2-City.mmdb |
| `GEOIP_ASN_DB_PATH` | Path to GeoLite2-ASN.mmdb |
| `RATE_LIMIT_MAX` | Max requests/min per IP |

---

## Extending the System

### Adding a new event type
1. Add the type to the `EventType` union in `schema/events.ts`
2. Define its payload interface (`PayloadMyNewEvent`)
3. Add it to the `EventPayload` discriminated union
4. Add its payload schema to `PAYLOAD_SCHEMAS` in `schema/event-batch-schema.ts`
5. Add a handler in `SessionManager.ts` (and platform adapters as needed)
6. Add a materialized view in `clickhouse/materialized-views.sql` if it needs its own table

### Adding a new platform
1. Implement the platform's native event hooks
2. Map each native event to a `SessionManager` call
3. Set the correct `platform` value in `SdkConfig` / `AnalyticsConfig`
4. No backend changes needed — the schema is platform-agnostic

### Sampling
The system defaults to 100% sampling. To introduce sampling:
- Add a `sampleRate` field to `SdkConfig`
- In `AnalyticsCore.attach()`, skip `startSession()` if `Math.random() > sampleRate`
- Tag sampled events with the sample rate so the backend can weight metrics correctly
