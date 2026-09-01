-- =============================================================================
-- Dashboard 3: CDN Comparison  ← THE KEY VIEW
-- Panels: Rebuffering, Error Rate, Bitrate, Latency — per CDN side by side
-- This is what makes the system "CDN analytics" not just "player analytics".
-- Grafana variables: $__timeFrom, $__timeTo, $platform, $content_type, $country_code
-- Refresh: 1min
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Panel: Rebuffering Ratio by CDN (%) — bar chart + trend overlay
-- Query type: Bar chart (grouped by cdn)
-- ---------------------------------------------------------------------------
SELECT
    cdn,
    round(
        100.0 * sum(rebuffer_time_s) / nullIf(sum(watch_time_s), 0),
        3
    )                                       AS rebuffer_ratio_pct,
    count()                                 AS session_count
FROM analytics_sessions
WHERE session_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND watch_time_s > 0
  AND cdn != ''
  AND ($platform      = 'ALL' OR platform      = $platform)
  AND ($content_type  = 'ALL' OR content_type  = $content_type)
  AND ($country_code  = 'ALL' OR country_code  = $country_code)
GROUP BY cdn
ORDER BY rebuffer_ratio_pct ASC;


-- ---------------------------------------------------------------------------
-- Panel: Error Rate by CDN (%) — bar chart
-- Query type: Bar chart
-- ---------------------------------------------------------------------------
SELECT
    cdn,
    round(100.0 * countIf(had_error = 1) / count(), 3)         AS error_rate_pct,
    round(100.0 * countIf(video_start_failure = 1) / count(), 3) AS vsf_rate_pct,
    count()                                                      AS sessions
FROM analytics_sessions
WHERE session_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND cdn != ''
  AND ($platform      = 'ALL' OR platform      = $platform)
  AND ($content_type  = 'ALL' OR content_type  = $content_type)
  AND ($country_code  = 'ALL' OR country_code  = $country_code)
GROUP BY cdn
ORDER BY error_rate_pct ASC;


-- ---------------------------------------------------------------------------
-- Panel: Average Throughput by CDN (kbps) — bar chart
-- Sourced from CDN_REQUEST events for highest fidelity
-- Query type: Bar chart
-- ---------------------------------------------------------------------------
SELECT
    cdn_name                                AS cdn,
    round(avg(throughput_kbps), 0)          AS avg_throughput_kbps,
    round(avg(ttfb_ms), 0)                  AS avg_ttfb_ms,
    round(avg(duration_ms), 0)              AS avg_segment_duration_ms,
    count()                                 AS request_count,
    countIf(http_status >= 400)             AS error_requests,
    round(100.0 * countIf(http_status >= 400) / count(), 2) AS http_error_rate_pct
FROM analytics_cdn_requests
WHERE event_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND cdn_name != ''
  AND ($platform      = 'ALL' OR platform     = $platform)
  AND ($content_type  = 'ALL' OR content_type = $content_type)
  AND ($country_code  = 'ALL' OR country_code = $country_code)
GROUP BY cdn_name
ORDER BY avg_throughput_kbps DESC;


-- ---------------------------------------------------------------------------
-- Panel: CDN Rebuffering Ratio over time — time series per CDN
-- Query type: Time series (one line per CDN)
-- ---------------------------------------------------------------------------
SELECT
    toStartOfHour(fromUnixTimestamp64Milli(session_end_ts))     AS time,
    cdn,
    round(
        100.0 * sum(rebuffer_time_s) / nullIf(sum(watch_time_s), 0),
        3
    )                                                           AS rebuffer_ratio_pct
FROM analytics_sessions
WHERE session_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND cdn != ''
  AND watch_time_s > 0
  AND ($platform      = 'ALL' OR platform     = $platform)
  AND ($content_type  = 'ALL' OR content_type = $content_type)
GROUP BY time, cdn
ORDER BY time ASC;


-- ---------------------------------------------------------------------------
-- Panel: CDN HTTP Error Rate over time — time series per CDN
-- Query type: Time series
-- ---------------------------------------------------------------------------
SELECT
    toStartOfHour(fromUnixTimestamp(toUInt32(timestamp / 1000)))    AS time,
    cdn_name                                                         AS cdn,
    round(100.0 * countIf(http_status >= 400) / count(), 2)         AS http_error_pct
FROM analytics_cdn_requests
WHERE event_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND cdn_name != ''
  AND ($platform      = 'ALL' OR platform     = $platform)
  AND ($content_type  = 'ALL' OR content_type = $content_type)
GROUP BY time, cdn
ORDER BY time ASC;


-- ---------------------------------------------------------------------------
-- Panel: CDN Throughput over time — time series per CDN
-- Query type: Time series
-- ---------------------------------------------------------------------------
SELECT
    toStartOfHour(fromUnixTimestamp(toUInt32(timestamp / 1000)))    AS time,
    cdn_name                                                         AS cdn,
    round(avg(throughput_kbps), 0)                                   AS avg_throughput_kbps
FROM analytics_cdn_requests
WHERE event_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND cdn_name != ''
  AND ($platform      = 'ALL' OR platform     = $platform)
  AND ($content_type  = 'ALL' OR content_type = $content_type)
GROUP BY time, cdn
ORDER BY time ASC;


-- ---------------------------------------------------------------------------
-- Panel: CDN Switch events — count by from→to pair
-- Shows which CDN failover paths are being hit
-- Query type: Table
-- ---------------------------------------------------------------------------
SELECT
    JSONExtractString(payload, 'cdn_from')      AS cdn_from,
    JSONExtractString(payload, 'cdn_to')        AS cdn_to,
    JSONExtractString(payload, 'reason')        AS reason,
    count()                                     AS switches,
    countIf(JSONExtractInt(payload, 'trigger_http_status') >= 500) AS server_error_triggers
FROM analytics_events
WHERE event_type = 'CDN_SWITCH'
  AND event_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND ($platform      = 'ALL' OR platform     = $platform)
GROUP BY cdn_from, cdn_to, reason
ORDER BY switches DESC
LIMIT 20;


-- ---------------------------------------------------------------------------
-- Panel: CDN Summary Table (the "scorecard")
-- All key CDN KPIs in one table for at-a-glance comparison
-- Query type: Table
-- ---------------------------------------------------------------------------
WITH
    sessions AS (
        SELECT
            cdn,
            count()                                             AS sessions,
            round(100.0 * countIf(had_error = 1) / count(), 2) AS error_rate_pct,
            round(100.0 * countIf(video_start_failure = 1) / count(), 2) AS vsf_pct,
            round(100.0 * sum(rebuffer_time_s) / nullIf(sum(watch_time_s), 0), 3) AS rebuffer_ratio_pct,
            round(avg(toFloat32(startup_time_ms)), 0)           AS avg_startup_ms
        FROM analytics_sessions
        WHERE session_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
          AND cdn != ''
        GROUP BY cdn
    ),
    cdn_req AS (
        SELECT
            cdn_name                                            AS cdn,
            round(avg(throughput_kbps), 0)                     AS avg_throughput_kbps,
            round(avg(ttfb_ms), 0)                             AS avg_ttfb_ms,
            round(100.0 * countIf(http_status >= 400) / count(), 2) AS http_error_pct
        FROM analytics_cdn_requests
        WHERE event_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
          AND cdn_name != ''
        GROUP BY cdn_name
    )
SELECT
    s.cdn,
    s.sessions,
    s.error_rate_pct,
    s.vsf_pct,
    s.rebuffer_ratio_pct,
    s.avg_startup_ms,
    r.avg_throughput_kbps,
    r.avg_ttfb_ms,
    r.http_error_pct
FROM sessions s
LEFT JOIN cdn_req r ON s.cdn = r.cdn
ORDER BY s.sessions DESC;
