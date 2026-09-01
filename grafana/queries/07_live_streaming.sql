-- =============================================================================
-- Dashboard 7: Live Streaming
-- Panels: Join Time, Live Latency, Live Error Rate, Active Channels
-- Only applies to content_type = 'live'
-- Grafana variables: $__timeFrom, $__timeTo, $content_id, $cdn, $platform
-- Refresh: 15s (live data)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Panel: Current Live Viewers — stat (last 2 min heartbeats)
-- Query type: Stat
-- ---------------------------------------------------------------------------
SELECT uniqMerge(viewers_state) AS live_viewers
FROM analytics_concurrent_viewers
WHERE content_type = 'live'
  AND minute >= now() - INTERVAL 2 MINUTE
  AND ($content_id = 'ALL' OR content_id = $content_id);


-- ---------------------------------------------------------------------------
-- Panel: Live Viewers over time — time series per channel
-- Query type: Time series
-- ---------------------------------------------------------------------------
SELECT
    minute                          AS time,
    content_id,
    uniqMerge(viewers_state)        AS viewers
FROM analytics_concurrent_viewers
WHERE content_type = 'live'
  AND minute BETWEEN $__timeFrom AND $__timeTo
  AND ($content_id = 'ALL' OR content_id = $content_id)
  AND ($platform   = 'ALL' OR platform   = $platform)
GROUP BY minute, content_id
ORDER BY minute ASC;


-- ---------------------------------------------------------------------------
-- Panel: Average Join Time (ms) — current hour stat + trend
-- Join time = time from channel selection to first frame
-- Query type: Time series + Stat
-- ---------------------------------------------------------------------------
-- Stat: current hour avg
SELECT round(avg(join_time_ms), 0) AS avg_join_time_ms
FROM (
    SELECT
        session_id,
        CAST(JSONExtractInt(payload, 'join_time_ms') AS UInt32) AS join_time_ms
    FROM analytics_events
    WHERE event_type = 'JOIN_TIME'
      AND event_date = today()
      AND content_type = 'live'
      AND ($content_id = 'ALL' OR content_id = $content_id)
      AND ($cdn        = 'ALL' OR cdn        = $cdn)
      AND join_time_ms > 0
);

-- Trend: hourly avg join time
SELECT
    toStartOfHour(fromUnixTimestamp(toUInt32(timestamp / 1000))) AS time,
    round(avg(CAST(JSONExtractInt(payload, 'join_time_ms') AS UInt32)), 0) AS avg_join_time_ms,
    quantile(0.95)(CAST(JSONExtractInt(payload, 'join_time_ms') AS UInt32)) AS p95_join_time_ms
FROM analytics_events
WHERE event_type = 'JOIN_TIME'
  AND event_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND content_type = 'live'
  AND ($content_id = 'ALL' OR content_id = $content_id)
  AND ($cdn        = 'ALL' OR cdn        = $cdn)
GROUP BY time
ORDER BY time ASC;


-- ---------------------------------------------------------------------------
-- Panel: Live Latency Distribution — histogram (edge-to-player)
-- Query type: Bar chart / Histogram
-- ---------------------------------------------------------------------------
SELECT
    multiIf(
        latency_s < 2,   '< 2s',
        latency_s < 4,   '2-4s',
        latency_s < 6,   '4-6s',
        latency_s < 8,   '6-8s',
        latency_s < 10,  '8-10s',
        latency_s < 15,  '10-15s',
        latency_s < 20,  '15-20s',
                         '> 20s'
    )                               AS latency_bucket,
    count()                         AS sessions
FROM (
    SELECT
        CAST(JSONExtractFloat(payload, 'latency_s') AS Float32) AS latency_s
    FROM analytics_events
    WHERE event_type = 'LIVE_LATENCY'
      AND event_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
      AND content_type = 'live'
      AND ($content_id = 'ALL' OR content_id = $content_id)
)
WHERE latency_s > 0
GROUP BY latency_bucket
ORDER BY latency_bucket ASC;


-- ---------------------------------------------------------------------------
-- Panel: Live Latency over time — time series (avg + p95)
-- Query type: Time series
-- ---------------------------------------------------------------------------
SELECT
    toStartOfMinute(fromUnixTimestamp(toUInt32(timestamp / 1000))) AS time,
    round(avg(CAST(JSONExtractFloat(payload, 'latency_s') AS Float32)), 2)  AS avg_latency_s,
    round(quantile(0.95)(CAST(JSONExtractFloat(payload, 'latency_s') AS Float32)), 2) AS p95_latency_s
FROM analytics_events
WHERE event_type = 'LIVE_LATENCY'
  AND event_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND content_type = 'live'
  AND ($content_id = 'ALL' OR content_id = $content_id)
  AND ($cdn        = 'ALL' OR cdn        = $cdn)
GROUP BY time
ORDER BY time ASC;


-- ---------------------------------------------------------------------------
-- Panel: Manifest Errors — live streams only
-- Manifests refresh every 2-10s on live; failures directly impact viewers
-- Query type: Time series + Stat
-- ---------------------------------------------------------------------------
SELECT
    toStartOfMinute(fromUnixTimestamp(toUInt32(timestamp / 1000))) AS time,
    count()                                                         AS manifest_errors,
    countIf(CAST(JSONExtractBool(payload, 'fatal') AS UInt8) = 1)  AS fatal_manifest_errors
FROM analytics_events
WHERE event_type = 'MANIFEST_ERROR'
  AND event_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND content_type = 'live'
  AND ($content_id = 'ALL' OR content_id = $content_id)
  AND ($cdn        = 'ALL' OR cdn        = $cdn)
GROUP BY time
ORDER BY time ASC;


-- ---------------------------------------------------------------------------
-- Panel: Active Channels table — live channel health overview
-- Query type: Table
-- ---------------------------------------------------------------------------
SELECT
    content_id,
    content_title,
    uniqMerge(viewers_state)    AS live_viewers,
    cdn,
    platform,
    country_code
FROM analytics_concurrent_viewers
WHERE content_type = 'live'
  AND minute >= now() - INTERVAL 5 MINUTE
GROUP BY content_id, content_title, cdn, platform, country_code
ORDER BY live_viewers DESC
LIMIT 50;
