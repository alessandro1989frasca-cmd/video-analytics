-- Additive migration for richer cross-platform QoE heartbeat and CDN fields.
-- Safe to run more than once.

ALTER TABLE analytics_heartbeats ADD COLUMN IF NOT EXISTS current_resolution LowCardinality(String) AFTER current_bitrate_kbps;
ALTER TABLE analytics_heartbeats ADD COLUMN IF NOT EXISTS buffer_length_s Float32 AFTER live_latency_s;
ALTER TABLE analytics_heartbeats ADD COLUMN IF NOT EXISTS bandwidth_estimate_kbps Float32 AFTER buffer_length_s;
ALTER TABLE analytics_heartbeats ADD COLUMN IF NOT EXISTS decoded_video_frames UInt64 AFTER bandwidth_estimate_kbps;
ALTER TABLE analytics_heartbeats ADD COLUMN IF NOT EXISTS dropped_video_frames UInt64 AFTER decoded_video_frames;
ALTER TABLE analytics_heartbeats ADD COLUMN IF NOT EXISTS playback_rate Float32 AFTER dropped_video_frames;
ALTER TABLE analytics_cdn_requests ADD COLUMN IF NOT EXISTS media_type LowCardinality(String) AFTER request_type;

DROP VIEW IF EXISTS mv_heartbeats;
CREATE MATERIALIZED VIEW mv_heartbeats
TO analytics_heartbeats
AS
SELECT
    toStartOfMinute(fromUnixTimestamp64Milli(timestamp)) AS event_minute,
    session_id,
    content_id,
    content_type,
    platform,
    cdn,
    country_code,
    CAST(JSONExtractFloat(payload, 'playback_position_s') AS Float32) AS playback_position_s,
    CAST(JSONExtractFloat(payload, 'current_bitrate_kbps') AS Float32) AS current_bitrate_kbps,
    JSONExtractString(payload, 'current_resolution') AS current_resolution,
    CAST(JSONExtractBool(payload, 'is_buffering') AS UInt8) AS is_buffering,
    CAST(JSONExtractFloat(payload, 'rebuffer_time_ms') AS Float32) AS rebuffer_time_ms,
    CAST(COALESCE(JSONExtractFloat(payload, 'live_latency_s'), 0) AS Float32) AS live_latency_s,
    CAST(COALESCE(JSONExtractFloat(payload, 'buffer_length_s'), 0) AS Float32) AS buffer_length_s,
    CAST(COALESCE(JSONExtractFloat(payload, 'bandwidth_estimate_kbps'), 0) AS Float32) AS bandwidth_estimate_kbps,
    CAST(COALESCE(JSONExtractInt(payload, 'decoded_video_frames'), 0) AS UInt64) AS decoded_video_frames,
    CAST(COALESCE(JSONExtractInt(payload, 'dropped_video_frames'), 0) AS UInt64) AS dropped_video_frames,
    CAST(COALESCE(JSONExtractFloat(payload, 'playback_rate'), 1) AS Float32) AS playback_rate
FROM analytics_events
WHERE event_type = 'HEARTBEAT';

DROP VIEW IF EXISTS mv_cdn_requests;
CREATE MATERIALIZED VIEW mv_cdn_requests
TO analytics_cdn_requests
AS
SELECT
    event_date,
    timestamp,
    session_id,
    JSONExtractString(payload, 'cdn_name') AS cdn_name,
    JSONExtractString(payload, 'request_type') AS request_type,
    JSONExtractString(payload, 'media_type') AS media_type,
    CAST(COALESCE(JSONExtractInt(payload, 'http_status'), 0) AS UInt16) AS http_status,
    CAST(JSONExtractFloat(payload, 'ttfb_ms') AS Float32) AS ttfb_ms,
    CAST(JSONExtractFloat(payload, 'duration_ms') AS Float32) AS duration_ms,
    CAST(JSONExtractInt(payload, 'bytes') AS UInt64) AS bytes,
    CAST(JSONExtractFloat(payload, 'throughput_kbps') AS Float32) AS throughput_kbps,
    platform,
    country_code,
    content_id,
    content_type
FROM analytics_events
WHERE event_type = 'CDN_REQUEST';