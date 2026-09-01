-- =============================================================================
-- Dashboard 6: Error Drill-down
-- Panels: Error distribution, trend, impacted sessions, top error codes
-- Grafana variables: $__timeFrom, $__timeTo, $platform, $cdn, $error_source
-- Refresh: 1min
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Panel: Error Count by Code — bar chart
-- Query type: Bar chart
-- ---------------------------------------------------------------------------
SELECT
    error_code,
    error_source,
    count()                                     AS occurrences,
    countIf(fatal = 1)                          AS fatal_count,
    countIf(video_start_failure = 1)            AS vsf_count,
    countIf(exit_before_start = 1)              AS ebvs_count
FROM analytics_errors
WHERE event_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND ($platform      = 'ALL' OR platform     = $platform)
  AND ($cdn           = 'ALL' OR cdn          = $cdn)
  AND ($error_source  = 'ALL' OR error_source = $error_source)
GROUP BY error_code, error_source
ORDER BY occurrences DESC
LIMIT 25;


-- ---------------------------------------------------------------------------
-- Panel: Error Rate over time — time series (by source)
-- Query type: Time series
-- ---------------------------------------------------------------------------
SELECT
    toStartOfHour(fromUnixTimestamp(toUInt32(timestamp / 1000))) AS time,
    error_source,
    count()                                                       AS errors
FROM analytics_errors
WHERE event_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND ($platform      = 'ALL' OR platform     = $platform)
  AND ($cdn           = 'ALL' OR cdn          = $cdn)
GROUP BY time, error_source
ORDER BY time ASC;


-- ---------------------------------------------------------------------------
-- Panel: Fatal vs Non-fatal errors trend
-- Query type: Time series (stacked)
-- ---------------------------------------------------------------------------
SELECT
    toStartOfHour(fromUnixTimestamp(toUInt32(timestamp / 1000))) AS time,
    countIf(fatal = 1)                                            AS fatal_errors,
    countIf(fatal = 0)                                            AS non_fatal_errors
FROM analytics_errors
WHERE event_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND ($platform = 'ALL' OR platform = $platform)
  AND ($cdn      = 'ALL' OR cdn      = $cdn)
GROUP BY time
ORDER BY time ASC;


-- ---------------------------------------------------------------------------
-- Panel: HTTP Error Status Distribution
-- Query type: Pie chart / Bar chart
-- ---------------------------------------------------------------------------
SELECT
    toString(http_status)       AS status_code,
    count()                     AS occurrences
FROM analytics_errors
WHERE event_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND http_status > 0
  AND ($cdn           = 'ALL' OR cdn          = $cdn)
  AND ($error_source  = 'ALL' OR error_source = $error_source)
GROUP BY http_status
ORDER BY occurrences DESC
LIMIT 15;


-- ---------------------------------------------------------------------------
-- Panel: VSF (Video Start Failure) breakdown — technical vs business
-- Sessions that never delivered a first frame
-- Query type: Stat + Table
-- ---------------------------------------------------------------------------
-- Summary stat
SELECT
    count()                                             AS total_vsf,
    countIf(fatal = 1)                                  AS technical_vsf,
    countIf(video_start_failure = 1 AND http_status IN (403, 451)) AS geo_block_vsf
FROM analytics_errors
WHERE event_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND video_start_failure = 1
  AND ($platform = 'ALL' OR platform = $platform)
  AND ($cdn      = 'ALL' OR cdn      = $cdn);

-- Detail table
SELECT
    error_code,
    error_source,
    cdn,
    country_code,
    count()                     AS vsf_count
FROM analytics_errors
WHERE event_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND video_start_failure = 1
  AND ($platform = 'ALL' OR platform = $platform)
  AND ($cdn      = 'ALL' OR cdn      = $cdn)
GROUP BY error_code, error_source, cdn, country_code
ORDER BY vsf_count DESC
LIMIT 20;


-- ---------------------------------------------------------------------------
-- Panel: Error Rate by CDN (for error dashboard CDN drill-down)
-- Query type: Table
-- ---------------------------------------------------------------------------
SELECT
    cdn,
    error_source,
    count()                                     AS error_sessions,
    round(100.0 * countIf(fatal = 1) / count(), 2) AS fatal_pct,
    groupArray(10)(error_code)                  AS top_error_codes
FROM analytics_errors
WHERE event_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND ($platform = 'ALL' OR platform = $platform)
GROUP BY cdn, error_source
ORDER BY error_sessions DESC
LIMIT 30;


-- ---------------------------------------------------------------------------
-- Panel: Error impacted sessions — raw session list for drill-down
-- Use when a user clicks on a spike in the error trend chart.
-- Grafana variable: $error_code (set from a variable or click)
-- Query type: Table (with link to session_id detail)
-- ---------------------------------------------------------------------------
SELECT
    e.session_id,
    e.timestamp,
    e.platform,
    e.cdn,
    e.country_code,
    e.error_code,
    e.error_source,
    e.fatal,
    s.content_title,
    s.player_engine,
    s.device_os
FROM analytics_errors e
LEFT JOIN analytics_sessions s ON e.session_id = s.session_id
WHERE e.event_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND ($error_code = 'ALL' OR e.error_code = $error_code)
  AND ($cdn        = 'ALL' OR e.cdn        = $cdn)
  AND ($platform   = 'ALL' OR e.platform   = $platform)
ORDER BY e.timestamp DESC
LIMIT 200;
