-- =============================================================================
-- Video QoE & CDN Analytics — ClickHouse Schema
-- =============================================================================
-- Engine choices:
--   analytics_events            → ReplicatedMergeTree (raw events, hot storage)
--   analytics_events_invalid    → ReplicatedMergeTree (quarantine)
--   agg_* tables                → AggregatingMergeTree (pre-aggregated rollups)
--
-- Partition key: toYYYYMM(event_date)
--   → monthly partitions allow cheap DROP PARTITION for data retention
--
-- TTL:
--   Raw events:  90 days  (then DELETE)
--   Aggregates:  2 years  (cheap to keep — much smaller)
--
-- For single-node dev remove the "Replicated" prefix:
--   ReplicatedMergeTree → MergeTree
-- =============================================================================

CREATE DATABASE IF NOT EXISTS analytics;

USE analytics;

-- =============================================================================
-- 1. Raw events table
-- =============================================================================

CREATE TABLE IF NOT EXISTS analytics_events
(
    -- Partitioning / ordering
    event_date          Date,               -- toDate(timestamp)
    timestamp           Int64,              -- epoch ms, client clock
    received_at         Int64,              -- epoch ms, server clock

    -- Session envelope
    session_id          LowCardinality(String),
    event_type          LowCardinality(String),
    seq                 UInt32,
    platform            LowCardinality(String),

    -- Content
    content_id          String,
    content_type        LowCardinality(String),   -- 'live' | 'vod'
    content_title       String,
    duration_s          Float32,                  -- -1 for live
    series_id           String,

    -- Player
    player_engine         LowCardinality(String),
    player_engine_version LowCardinality(String),
    sdk_version           LowCardinality(String),

    -- Network (client-reported)
    connection_type     LowCardinality(String),
    cdn                 LowCardinality(String),
    bandwidth_kbps      Float32,

    -- Device
    device_os           LowCardinality(String),
    device_os_version   LowCardinality(String),
    device_model        String,
    screen_resolution   LowCardinality(String),

    -- Geo (server-enriched)
    country_code        LowCardinality(String),
    country_name        LowCardinality(String),
    region              LowCardinality(String),
    city                String,
    latitude            Float32,
    longitude           Float32,
    isp                 String,
    asn                 UInt32,

    -- Identity (hashed — GDPR compliant)
    client_ip_hash      String,

    -- Event-specific payload (full JSON for flexible querying)
    payload             String,             -- JSON

    -- Metadata
    collector_version   LowCardinality(String)
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(event_date)
ORDER BY (event_date, content_id, session_id, timestamp, seq)
TTL event_date + INTERVAL 90 DAY DELETE
SETTINGS index_granularity = 8192;


-- =============================================================================
-- 2. Invalid / quarantine events table
-- =============================================================================

CREATE TABLE IF NOT EXISTS analytics_events_invalid
(
    received_at        Int64,
    client_ip_hash     String,
    raw_event          String,              -- full JSON of the invalid event
    validation_errors  String
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(toDate(received_at / 1000))
ORDER BY (received_at)
TTL toDate(received_at / 1000) + INTERVAL 30 DAY DELETE
SETTINGS index_granularity = 8192;


-- =============================================================================
-- 3. Aggregation source table: per-session summary
--    Populated by the SESSION_END event (one row per completed session).
--    This is the most useful table for most dashboard queries.
-- =============================================================================

CREATE TABLE IF NOT EXISTS analytics_sessions
(
    session_date        Date,
    session_id          String,
    platform            LowCardinality(String),
    content_id          String,
    content_type        LowCardinality(String),
    content_title       String,
    player_engine       LowCardinality(String),
    cdn                 LowCardinality(String),
    connection_type     LowCardinality(String),
    device_os           LowCardinality(String),
    device_model        String,
    country_code        LowCardinality(String),
    country_name        LowCardinality(String),
    region              LowCardinality(String),
    city                String,
    isp                 String,

    -- QoE metrics from SESSION_END payload
    watch_time_s        Float32,
    completion_pct      Float32,            -- -1 if live
    rebuffer_count      UInt32,
    rebuffer_time_s     Float32,
    bitrate_change_count UInt32,
    session_end_reason  LowCardinality(String),

    -- From FIRST_FRAME payload
    startup_time_ms     UInt32,

    -- Derived flags
    had_error           UInt8,              -- 1 if any ERROR event in session
    had_fatal_error     UInt8,
    video_start_failure UInt8,              -- 1 if error before first frame
    exit_before_start   UInt8,             -- 1 if EBVS

    -- From CDN_REQUEST events (aggregated per session by the collector)
    avg_throughput_kbps Float32,
    avg_ttfb_ms         Float32,

    -- Timestamps
    session_start_ts    Int64,
    first_frame_ts      Int64,
    session_end_ts      Int64
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(session_date)
ORDER BY (session_date, content_id, cdn, platform)
TTL session_date + INTERVAL 365 DAY DELETE
SETTINGS index_granularity = 8192;


-- =============================================================================
-- 4. Per-minute concurrent viewers (sliding window approximation)
--    Populated from HEARTBEAT events — one row per heartbeat.
--    Use window functions in queries to compute concurrent viewers.
-- =============================================================================

CREATE TABLE IF NOT EXISTS analytics_heartbeats
(
    event_minute        DateTime,           -- toStartOfMinute(timestamp)
    session_id          LowCardinality(String),
    content_id          String,
    content_type        LowCardinality(String),
    platform            LowCardinality(String),
    cdn                 LowCardinality(String),
    country_code        LowCardinality(String),
    playback_position_s Float32,
    current_bitrate_kbps Float32,
    is_buffering        UInt8,
    rebuffer_time_ms    Float32,
    live_latency_s      Float32             -- 0 for VOD
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(event_minute)
ORDER BY (event_minute, content_id, session_id)
TTL toDate(event_minute) + INTERVAL 30 DAY DELETE
SETTINGS index_granularity = 8192;


-- =============================================================================
-- 5. Per-CDN request metrics (raw, from CDN_REQUEST events)
-- =============================================================================

CREATE TABLE IF NOT EXISTS analytics_cdn_requests
(
    event_date          Date,
    timestamp           Int64,
    session_id          LowCardinality(String),
    cdn_name            LowCardinality(String),
    request_type        LowCardinality(String),   -- manifest | segment | key
    http_status         UInt16,
    ttfb_ms             Float32,
    duration_ms         Float32,
    bytes               UInt64,
    throughput_kbps     Float32,
    platform            LowCardinality(String),
    country_code        LowCardinality(String),
    content_id          String,
    content_type        LowCardinality(String)
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(event_date)
ORDER BY (event_date, cdn_name, timestamp)
TTL event_date + INTERVAL 30 DAY DELETE
SETTINGS index_granularity = 8192;


-- =============================================================================
-- 6. Error events (denormalised for fast error analysis)
-- =============================================================================

CREATE TABLE IF NOT EXISTS analytics_errors
(
    event_date          Date,
    timestamp           Int64,
    session_id          LowCardinality(String),
    platform            LowCardinality(String),
    content_id          String,
    cdn                 LowCardinality(String),
    country_code        LowCardinality(String),
    error_code          String,
    error_source        LowCardinality(String),
    fatal               UInt8,
    video_start_failure UInt8,
    exit_before_start   UInt8,
    http_status         UInt16,
    device_os           LowCardinality(String)
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(event_date)
ORDER BY (event_date, error_code, cdn, platform)
TTL event_date + INTERVAL 90 DAY DELETE
SETTINGS index_granularity = 8192;


-- =============================================================================
-- 7. Pre-aggregated hourly QoE rollup (AggregatingMergeTree)
--    Feed the main dashboard panels — much faster than scanning raw events.
-- =============================================================================

CREATE TABLE IF NOT EXISTS analytics_qoe_hourly
(
    hour                DateTime,
    platform            LowCardinality(String),
    cdn                 LowCardinality(String),
    content_type        LowCardinality(String),
    country_code        LowCardinality(String),

    -- Aggregated state columns
    plays_state                 AggregateFunction(count),
    unique_sessions_state       AggregateFunction(uniq, String),
    startup_time_ms_state       AggregateFunction(avg,  Float32),
    rebuffer_ratio_state        AggregateFunction(avg,  Float32),   -- avg(rebuffer_time_s/watch_time_s)
    bitrate_avg_state           AggregateFunction(avg,  Float32),
    error_rate_state            AggregateFunction(avg,  Float32),   -- avg(had_error)
    vsf_rate_state              AggregateFunction(avg,  Float32),   -- avg(video_start_failure)
    completion_pct_state        AggregateFunction(avg,  Float32),
    watch_time_s_state          AggregateFunction(sum,  Float32),
    throughput_kbps_state       AggregateFunction(avg,  Float32),
    ttfb_ms_state               AggregateFunction(avg,  Float32)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(hour)
ORDER BY (hour, platform, cdn, content_type, country_code)
TTL toDate(hour) + INTERVAL 730 DAY DELETE;


-- =============================================================================
-- 8. Concurrent viewers per minute (pre-aggregated)
-- =============================================================================

CREATE TABLE IF NOT EXISTS analytics_concurrent_viewers
(
    minute              DateTime,
    content_id          String,
    content_type        LowCardinality(String),
    platform            LowCardinality(String),
    cdn                 LowCardinality(String),
    country_code        LowCardinality(String),

    viewers_state       AggregateFunction(uniq, String)   -- uniq(session_id)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(minute)
ORDER BY (minute, content_id, platform)
TTL toDate(minute) + INTERVAL 90 DAY DELETE;
