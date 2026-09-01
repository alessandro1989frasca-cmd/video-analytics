-- =============================================================================
-- Materialized Views — automatically populate aggregation tables from raw events
-- =============================================================================
-- Each MV fires on INSERT to analytics_events and routes rows to the
-- appropriate specialised table based on event_type.
--
-- Pattern:
--   CREATE MATERIALIZED VIEW mv_name TO target_table AS
--   SELECT ... FROM analytics_events WHERE event_type = '...'
-- =============================================================================

USE analytics;

-- =============================================================================
-- MV 1: SESSION_END → analytics_sessions
-- One row per completed session — the primary QoE record.
-- =============================================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_sessions
TO analytics_sessions
AS
SELECT
    event_date                                                  AS session_date,
    session_id,
    platform,
    content_id,
    content_type,
    content_title,
    player_engine,
    cdn,
    connection_type,
    device_os,
    device_model,
    country_code,
    country_name,
    region,
    city,
    isp,

    -- Extract fields from the JSON payload
    CAST(JSONExtractFloat(payload, 'watch_time_s')      AS Float32)  AS watch_time_s,
    CAST(COALESCE(JSONExtractFloat(payload, 'completion_pct'), -1) AS Float32) AS completion_pct,
    CAST(JSONExtractInt(payload,   'rebuffer_count')    AS UInt32)   AS rebuffer_count,
    CAST(JSONExtractFloat(payload, 'rebuffer_time_s')   AS Float32)  AS rebuffer_time_s,
    CAST(JSONExtractInt(payload,   'bitrate_change_count') AS UInt32) AS bitrate_change_count,
    JSONExtractString(payload, 'reason')                             AS session_end_reason,

    -- Placeholders filled by the collector via JOIN or separate inserts
    toUInt32(0)     AS startup_time_ms,
    toUInt8(0)      AS had_error,
    toUInt8(0)      AS had_fatal_error,
    toUInt8(0)      AS video_start_failure,
    toUInt8(0)      AS exit_before_start,
    toFloat32(0)    AS avg_throughput_kbps,
    toFloat32(0)    AS avg_ttfb_ms,

    timestamp       AS session_end_ts,
    toInt64(0)      AS session_start_ts,
    toInt64(0)      AS first_frame_ts
FROM analytics_events
WHERE event_type = 'SESSION_END';


-- =============================================================================
-- MV 2: FIRST_FRAME → update startup_time_ms in analytics_sessions
-- Because ClickHouse MVs cannot UPDATE, we use a separate aggregation table
-- and join at query time, OR we insert a second row that ReplacingMergeTree merges.
-- Here we use a dedicated startup_times table for clarity.
-- =============================================================================

CREATE TABLE IF NOT EXISTS analytics_startup_times
(
    event_date      Date,
    session_id      String,
    startup_time_ms UInt32
)
ENGINE = ReplacingMergeTree()
PARTITION BY toYYYYMM(event_date)
ORDER BY (event_date, session_id)
TTL event_date + INTERVAL 90 DAY DELETE;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_startup_times
TO analytics_startup_times
AS
SELECT
    event_date,
    session_id,
    CAST(JSONExtractInt(payload, 'startup_time_ms') AS UInt32) AS startup_time_ms
FROM analytics_events
WHERE event_type = 'FIRST_FRAME';


-- =============================================================================
-- MV 3: ERROR → analytics_errors
-- =============================================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_errors
TO analytics_errors
AS
SELECT
    event_date,
    timestamp,
    session_id,
    platform,
    content_id,
    cdn,
    country_code,
    JSONExtractString(payload, 'error_code')    AS error_code,
    JSONExtractString(payload, 'source')        AS error_source,
    CAST(JSONExtractBool(payload, 'fatal')   AS UInt8) AS fatal,
    -- video_start_failure: error before first frame
    -- Approximated here; precise value comes from SESSION_END
    CAST(if(JSONExtractString(payload, 'vsf_type') != '', 1, 0) AS UInt8) AS video_start_failure,
    CAST(if(JSONExtractBool(payload, 'is_ebvs'), 1, 0)          AS UInt8) AS exit_before_start,
    CAST(COALESCE(JSONExtractInt(payload, 'http_status'), 0) AS UInt16)   AS http_status,
    device_os
FROM analytics_events
WHERE event_type = 'ERROR';


-- =============================================================================
-- MV 4: CDN_REQUEST → analytics_cdn_requests
-- =============================================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_cdn_requests
TO analytics_cdn_requests
AS
SELECT
    event_date,
    timestamp,
    session_id,
    JSONExtractString(payload, 'cdn_name')          AS cdn_name,
    JSONExtractString(payload, 'request_type')      AS request_type,
    CAST(COALESCE(JSONExtractInt(payload, 'http_status'), 0) AS UInt16) AS http_status,
    CAST(JSONExtractFloat(payload, 'ttfb_ms')       AS Float32)         AS ttfb_ms,
    CAST(JSONExtractFloat(payload, 'duration_ms')   AS Float32)         AS duration_ms,
    CAST(JSONExtractInt(payload,   'bytes')         AS UInt64)          AS bytes,
    CAST(JSONExtractFloat(payload, 'throughput_kbps') AS Float32)       AS throughput_kbps,
    platform,
    country_code,
    content_id,
    content_type
FROM analytics_events
WHERE event_type = 'CDN_REQUEST';


-- =============================================================================
-- MV 5: HEARTBEAT → analytics_heartbeats
-- =============================================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_heartbeats
TO analytics_heartbeats
AS
SELECT
    toStartOfMinute(fromUnixTimestamp64Milli(timestamp))    AS event_minute,
    session_id,
    content_id,
    content_type,
    platform,
    cdn,
    country_code,
    CAST(JSONExtractFloat(payload, 'playback_position_s')   AS Float32) AS playback_position_s,
    CAST(JSONExtractFloat(payload, 'current_bitrate_kbps')  AS Float32) AS current_bitrate_kbps,
    CAST(JSONExtractBool(payload,  'is_buffering')          AS UInt8)   AS is_buffering,
    CAST(JSONExtractFloat(payload, 'rebuffer_time_ms')      AS Float32) AS rebuffer_time_ms,
    CAST(COALESCE(JSONExtractFloat(payload, 'live_latency_s'), 0) AS Float32) AS live_latency_s
FROM analytics_events
WHERE event_type = 'HEARTBEAT';


-- =============================================================================
-- MV 6: analytics_sessions → analytics_qoe_hourly
-- Hourly pre-aggregated QoE rollup — feeds fast dashboard panels.
-- This MV reads from analytics_sessions, not from analytics_events directly.
-- =============================================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_qoe_hourly
TO analytics_qoe_hourly
AS
SELECT
    toStartOfHour(toDateTime(session_date))     AS hour,
    platform,
    cdn,
    content_type,
    country_code,

    countState()                                                    AS plays_state,
    uniqState(session_id)                                           AS unique_sessions_state,
    avgState(toFloat32(startup_time_ms))                            AS startup_time_ms_state,
    avgState(
        if(watch_time_s > 0,
           rebuffer_time_s / watch_time_s,
           toFloat32(0)
        )
    )                                                               AS rebuffer_ratio_state,
    avgState(toFloat32(0))                                          AS bitrate_avg_state,  -- from HEARTBEAT data
    avgState(toFloat32(had_error))                                  AS error_rate_state,
    avgState(toFloat32(video_start_failure))                        AS vsf_rate_state,
    avgState(if(completion_pct >= 0, completion_pct, toFloat32(0))) AS completion_pct_state,
    sumState(watch_time_s)                                          AS watch_time_s_state,
    avgState(avg_throughput_kbps)                                   AS throughput_kbps_state,
    avgState(avg_ttfb_ms)                                           AS ttfb_ms_state
FROM analytics_sessions
GROUP BY hour, platform, cdn, content_type, country_code;


-- =============================================================================
-- MV 7: analytics_heartbeats → analytics_concurrent_viewers
-- Real-time concurrent viewers per minute per content/platform/CDN.
-- =============================================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_concurrent_viewers
TO analytics_concurrent_viewers
AS
SELECT
    event_minute                    AS minute,
    content_id,
    content_type,
    platform,
    cdn,
    country_code,
    uniqState(session_id)           AS viewers_state
FROM analytics_heartbeats
GROUP BY minute, content_id, content_type, platform, cdn, country_code;


-- =============================================================================
-- Helper views — merge ReplacingMergeTree duplicates at read time
-- =============================================================================

-- Final startup times (deduped)
CREATE VIEW IF NOT EXISTS v_startup_times AS
SELECT session_id, max(startup_time_ms) AS startup_time_ms
FROM analytics_startup_times FINAL
GROUP BY session_id;

-- Merged QoE hourly (AggregatingMergeTree merge at read time)
CREATE VIEW IF NOT EXISTS v_qoe_hourly AS
SELECT
    hour,
    platform,
    cdn,
    content_type,
    country_code,
    countMerge(plays_state)                     AS plays,
    uniqMerge(unique_sessions_state)            AS unique_sessions,
    avgMerge(startup_time_ms_state)             AS avg_startup_time_ms,
    avgMerge(rebuffer_ratio_state)              AS avg_rebuffer_ratio,
    avgMerge(error_rate_state)                  AS error_rate,
    avgMerge(vsf_rate_state)                    AS vsf_rate,
    avgMerge(completion_pct_state)              AS avg_completion_pct,
    sumMerge(watch_time_s_state)                AS total_watch_time_s,
    avgMerge(throughput_kbps_state)             AS avg_throughput_kbps,
    avgMerge(ttfb_ms_state)                     AS avg_ttfb_ms
FROM analytics_qoe_hourly
GROUP BY hour, platform, cdn, content_type, country_code;

-- Merged concurrent viewers (AggregatingMergeTree merge at read time)
CREATE VIEW IF NOT EXISTS v_concurrent_viewers AS
SELECT
    minute,
    content_id,
    content_type,
    platform,
    cdn,
    country_code,
    uniqMerge(viewers_state) AS concurrent_viewers
FROM analytics_concurrent_viewers
GROUP BY minute, content_id, content_type, platform, cdn, country_code;
