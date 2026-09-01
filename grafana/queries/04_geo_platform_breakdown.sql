-- =============================================================================
-- Dashboard 4: Geographic & Platform Breakdown
-- Panels: World map, Country table, Platform pie, Device OS breakdown
-- Grafana variables: $__timeFrom, $__timeTo, $content_type, $cdn
-- Refresh: 5min
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Panel: Sessions by Country — world map / choropleth
-- Grafana Geomap panel uses 'country_code' field directly
-- Query type: Table (Geomap)
-- ---------------------------------------------------------------------------
SELECT
    country_code,
    country_name,
    count()                                                     AS sessions,
    round(avg(toFloat32(startup_time_ms)), 0)                   AS avg_startup_ms,
    round(100.0 * sum(rebuffer_time_s) / nullIf(sum(watch_time_s), 0), 3) AS rebuffer_ratio_pct,
    round(100.0 * countIf(had_error = 1) / count(), 2)          AS error_rate_pct,
    round(avg(watch_time_s), 0)                                 AS avg_watch_time_s
FROM analytics_sessions
WHERE session_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND country_code != ''
  AND ($content_type = 'ALL' OR content_type = $content_type)
  AND ($cdn          = 'ALL' OR cdn          = $cdn)
GROUP BY country_code, country_name
ORDER BY sessions DESC
LIMIT 100;


-- ---------------------------------------------------------------------------
-- Panel: Top 10 Countries — bar chart
-- Query type: Bar chart
-- ---------------------------------------------------------------------------
SELECT
    country_name                AS country,
    count()                     AS sessions,
    round(sum(watch_time_s) / 3600, 1) AS watch_time_hours
FROM analytics_sessions
WHERE session_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND country_name != ''
  AND ($content_type = 'ALL' OR content_type = $content_type)
  AND ($cdn          = 'ALL' OR cdn          = $cdn)
GROUP BY country_name
ORDER BY sessions DESC
LIMIT 10;


-- ---------------------------------------------------------------------------
-- Panel: Sessions by Platform — pie chart
-- Query type: Pie chart
-- ---------------------------------------------------------------------------
SELECT
    platform,
    count()                     AS sessions,
    round(100.0 * count() / sum(count()) OVER (), 1) AS pct
FROM analytics_sessions
WHERE session_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND ($content_type = 'ALL' OR content_type = $content_type)
  AND ($cdn          = 'ALL' OR cdn          = $cdn)
GROUP BY platform
ORDER BY sessions DESC;


-- ---------------------------------------------------------------------------
-- Panel: QoE by Platform — table (one row per platform)
-- Query type: Table
-- ---------------------------------------------------------------------------
SELECT
    platform,
    count()                                                     AS sessions,
    round(avg(toFloat32(startup_time_ms)), 0)                   AS avg_startup_ms,
    round(100.0 * sum(rebuffer_time_s) / nullIf(sum(watch_time_s), 0), 3) AS rebuffer_ratio_pct,
    round(100.0 * countIf(had_error = 1) / count(), 2)          AS error_rate_pct,
    round(100.0 * countIf(video_start_failure = 1) / count(), 2) AS vsf_rate_pct,
    round(avg(watch_time_s), 0)                                 AS avg_watch_time_s
FROM analytics_sessions
WHERE session_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND ($content_type = 'ALL' OR content_type = $content_type)
  AND ($cdn          = 'ALL' OR cdn          = $cdn)
GROUP BY platform
ORDER BY sessions DESC;


-- ---------------------------------------------------------------------------
-- Panel: Sessions by OS — bar chart
-- Query type: Bar chart
-- ---------------------------------------------------------------------------
SELECT
    device_os,
    count()             AS sessions
FROM analytics_sessions
WHERE session_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND device_os != ''
  AND ($content_type = 'ALL' OR content_type = $content_type)
GROUP BY device_os
ORDER BY sessions DESC
LIMIT 10;


-- ---------------------------------------------------------------------------
-- Panel: Sessions by Connection Type — pie chart
-- Query type: Pie chart
-- ---------------------------------------------------------------------------
SELECT
    connection_type,
    count()             AS sessions
FROM analytics_sessions
WHERE session_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND ($platform     = 'ALL' OR platform     = $platform)
  AND ($content_type = 'ALL' OR content_type = $content_type)
GROUP BY connection_type
ORDER BY sessions DESC;


-- ---------------------------------------------------------------------------
-- Panel: ISP breakdown (top 15 by error rate)
-- Query type: Table
-- ---------------------------------------------------------------------------
SELECT
    isp,
    count()                                                     AS sessions,
    round(100.0 * countIf(had_error = 1) / count(), 2)          AS error_rate_pct,
    round(100.0 * sum(rebuffer_time_s) / nullIf(sum(watch_time_s), 0), 3) AS rebuffer_ratio_pct,
    round(avg(toFloat32(startup_time_ms)), 0)                   AS avg_startup_ms
FROM analytics_sessions
WHERE session_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND isp != ''
  AND ($country_code = 'ALL' OR country_code = $country_code)
GROUP BY isp
HAVING sessions >= 50     -- exclude very low-volume ISPs
ORDER BY error_rate_pct DESC
LIMIT 15;
