-- =============================================================================
-- Dashboard 1: Real-time Overview
-- Panels: Concurrent Viewers, Plays (last hour), Error Rate, Avg Bitrate
-- Refresh: 30s
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Panel: Concurrent Viewers RIGHT NOW
-- Uses the last 2 heartbeat intervals (~30s) to count live sessions.
-- Query type: Stat / Gauge
-- ---------------------------------------------------------------------------
SELECT uniqMerge(viewers_state) AS concurrent_viewers
FROM analytics_concurrent_viewers
WHERE minute >= toStartOfMinute(now() - INTERVAL 2 MINUTE)
  AND minute <= toStartOfMinute(now());


-- ---------------------------------------------------------------------------
-- Panel: Concurrent Viewers — time series (last 2h, 1-min granularity)
-- Query type: Time series
-- Grafana variables: $content_id (optional filter)
-- ---------------------------------------------------------------------------
SELECT
    minute                          AS time,
    uniqMerge(viewers_state)        AS concurrent_viewers
FROM analytics_concurrent_viewers
WHERE minute >= now() - INTERVAL 2 HOUR
  AND ($content_id = 'ALL' OR content_id = $content_id)
GROUP BY minute
ORDER BY minute ASC;


-- ---------------------------------------------------------------------------
-- Panel: Total Plays — last 60 minutes
-- Query type: Stat
-- ---------------------------------------------------------------------------
SELECT count() AS plays_last_hour
FROM analytics_sessions
WHERE session_date >= today()
  AND session_end_ts >= (toUnixTimestamp(now()) - 3600) * 1000;


-- ---------------------------------------------------------------------------
-- Panel: Error Rate (%) — last 60 minutes
-- Query type: Stat / Gauge
-- ---------------------------------------------------------------------------
SELECT
    round(100.0 * countIf(had_error = 1) / count(), 2) AS error_rate_pct
FROM analytics_sessions
WHERE session_date >= today()
  AND session_end_ts >= (toUnixTimestamp(now()) - 3600) * 1000;


-- ---------------------------------------------------------------------------
-- Panel: Average Bitrate (kbps) — last 60 minutes
-- Sourced from heartbeat current_bitrate_kbps for live accuracy
-- Query type: Stat
-- ---------------------------------------------------------------------------
SELECT round(avg(current_bitrate_kbps), 0) AS avg_bitrate_kbps
FROM analytics_heartbeats
WHERE event_minute >= now() - INTERVAL 1 HOUR
  AND current_bitrate_kbps > 0;


-- ---------------------------------------------------------------------------
-- Panel: Plays per minute — sparkline (last 30 min)
-- Query type: Time series
-- ---------------------------------------------------------------------------
SELECT
    toStartOfMinute(fromUnixTimestamp64Milli(session_end_ts)) AS time,
    count()                                                    AS plays
FROM analytics_sessions
WHERE session_date >= today()
  AND session_end_ts >= (toUnixTimestamp(now()) - 1800) * 1000
GROUP BY time
ORDER BY time ASC;


-- ---------------------------------------------------------------------------
-- Panel: Video Start Failure Rate (%) — last 60 minutes
-- Query type: Stat
-- ---------------------------------------------------------------------------
SELECT
    round(100.0 * countIf(video_start_failure = 1) / count(), 2) AS vsf_rate_pct
FROM analytics_sessions
WHERE session_date >= today()
  AND session_end_ts >= (toUnixTimestamp(now()) - 3600) * 1000;
