-- =============================================================================
-- Grafana Dashboard Variables
-- =============================================================================
-- Configure these in Grafana → Dashboard Settings → Variables.
-- Each query below populates a dropdown filter variable.
-- All dashboards use the same variable names for consistency.
-- =============================================================================

-- Variable: $platform
-- Type: Query | Multi-value | Include "ALL" option
SELECT DISTINCT platform
FROM analytics_sessions
WHERE session_date >= today() - 30
ORDER BY platform ASC;

-- Variable: $cdn
-- Type: Query | Multi-value | Include "ALL" option
SELECT DISTINCT cdn
FROM analytics_sessions
WHERE session_date >= today() - 30
  AND cdn != ''
ORDER BY cdn ASC;

-- Variable: $content_type
-- Type: Query | Include "ALL" option
SELECT DISTINCT content_type
FROM analytics_sessions
WHERE session_date >= today() - 30;

-- Variable: $content_id
-- Type: Query | Searchable | Include "ALL" option
SELECT DISTINCT concat(content_id, ' — ', content_title) AS label, content_id AS value
FROM analytics_sessions
WHERE session_date >= today() - 30
ORDER BY content_title ASC
LIMIT 500;

-- Variable: $country_code
-- Type: Query | Multi-value | Include "ALL" option
SELECT DISTINCT country_code
FROM analytics_sessions
WHERE session_date >= today() - 30
  AND country_code != ''
ORDER BY country_code ASC;

-- Variable: $error_source
-- Type: Query | Include "ALL" option
SELECT DISTINCT error_source
FROM analytics_errors
WHERE event_date >= today() - 30;

-- Variable: $error_code
-- Type: Query | Searchable | Include "ALL" option
SELECT DISTINCT error_code
FROM analytics_errors
WHERE event_date >= today() - 7
ORDER BY error_code ASC
LIMIT 200;

-- Variable: $device_os
-- Type: Query | Multi-value | Include "ALL" option
SELECT DISTINCT device_os
FROM analytics_sessions
WHERE session_date >= today() - 30
  AND device_os != '';

-- =============================================================================
-- Macros used in query files
-- =============================================================================
-- $__timeFrom → Grafana resolves to: toDateTime('2024-01-01 00:00:00')
-- $__timeTo   → Grafana resolves to: toDateTime('2024-01-31 23:59:59')
-- $__interval → Grafana auto-calculates interval based on time range and panel width
--
-- For ClickHouse datasource (grafana-clickhouse-datasource), use:
--   $__fromTime  (alias of $__timeFrom)
--   $__toTime    (alias of $__timeTo)
--   $__timeFilter(column_name)  → expands to: column BETWEEN $__fromTime AND $__toTime
-- =============================================================================

-- =============================================================================
-- Alert rules (reference queries)
-- Configure in Grafana Alerting or as recording rules
-- =============================================================================

-- Alert: Error rate > 5% in last 15 minutes
SELECT round(100.0 * countIf(had_error = 1) / count(), 2) AS error_rate_pct
FROM analytics_sessions
WHERE session_end_ts >= (toUnixTimestamp(now()) - 900) * 1000
HAVING error_rate_pct > 5;

-- Alert: No heartbeats received in last 5 minutes (collector down / SDK issue)
SELECT count() AS heartbeats_last_5min
FROM analytics_heartbeats
WHERE event_minute >= now() - INTERVAL 5 MINUTE
HAVING heartbeats_last_5min = 0;

-- Alert: Rebuffering ratio > 3% on any CDN in last 30 minutes
SELECT
    cdn,
    round(100.0 * sum(rebuffer_time_s) / nullIf(sum(watch_time_s), 0), 3) AS rebuffer_ratio_pct
FROM analytics_sessions
WHERE session_end_ts >= (toUnixTimestamp(now()) - 1800) * 1000
  AND cdn != ''
GROUP BY cdn
HAVING rebuffer_ratio_pct > 3;

-- Alert: Average startup time > 5000ms in last 15 minutes
SELECT round(avg(toFloat32(startup_time_ms)), 0) AS avg_startup_ms
FROM analytics_sessions
    JOIN analytics_startup_times USING (session_id)
WHERE session_end_ts >= (toUnixTimestamp(now()) - 900) * 1000
HAVING avg_startup_ms > 5000;
