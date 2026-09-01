-- =============================================================================
-- Dashboard 2: QoE Trends Over Time
-- Panels: Startup Time, Rebuffering Ratio, Error Rate — time series
-- Uses v_qoe_hourly for queries > 6h, raw analytics_sessions for shorter windows.
-- Grafana variables: $__timeFrom, $__timeTo, $platform, $cdn, $content_type
-- Refresh: 5min
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Panel: Average Startup Time (ms) — hourly trend
-- Query type: Time series
-- ---------------------------------------------------------------------------
SELECT
    hour                        AS time,
    avg_startup_time_ms
FROM v_qoe_hourly
WHERE hour BETWEEN $__timeFrom AND $__timeTo
  AND ($platform     = 'ALL' OR platform      = $platform)
  AND ($cdn          = 'ALL' OR cdn           = $cdn)
  AND ($content_type = 'ALL' OR content_type  = $content_type)
ORDER BY hour ASC;


-- ---------------------------------------------------------------------------
-- Panel: Rebuffering Ratio (%) — hourly trend
-- rebuffer_ratio = rebuffer_time_s / watch_time_s * 100
-- Query type: Time series
-- ---------------------------------------------------------------------------
SELECT
    hour                                            AS time,
    round(avg_rebuffer_ratio * 100, 3)              AS rebuffer_ratio_pct
FROM v_qoe_hourly
WHERE hour BETWEEN $__timeFrom AND $__timeTo
  AND ($platform     = 'ALL' OR platform      = $platform)
  AND ($cdn          = 'ALL' OR cdn           = $cdn)
  AND ($content_type = 'ALL' OR content_type  = $content_type)
ORDER BY hour ASC;


-- ---------------------------------------------------------------------------
-- Panel: Error Rate (%) — hourly trend
-- Query type: Time series
-- ---------------------------------------------------------------------------
SELECT
    hour                            AS time,
    round(error_rate * 100, 3)      AS error_rate_pct
FROM v_qoe_hourly
WHERE hour BETWEEN $__timeFrom AND $__timeTo
  AND ($platform     = 'ALL' OR platform     = $platform)
  AND ($cdn          = 'ALL' OR cdn          = $cdn)
  AND ($content_type = 'ALL' OR content_type = $content_type)
ORDER BY hour ASC;


-- ---------------------------------------------------------------------------
-- Panel: VSF Rate (%) — hourly trend
-- Video Start Failure: session ended with error before first frame
-- Query type: Time series
-- ---------------------------------------------------------------------------
SELECT
    hour                            AS time,
    round(vsf_rate * 100, 3)        AS vsf_rate_pct
FROM v_qoe_hourly
WHERE hour BETWEEN $__timeFrom AND $__timeTo
  AND ($platform     = 'ALL' OR platform     = $platform)
  AND ($cdn          = 'ALL' OR cdn          = $cdn)
  AND ($content_type = 'ALL' OR content_type = $content_type)
ORDER BY hour ASC;


-- ---------------------------------------------------------------------------
-- Panel: Avg Completion % (VOD only) — hourly trend
-- Query type: Time series
-- ---------------------------------------------------------------------------
SELECT
    hour                                AS time,
    round(avg_completion_pct, 1)        AS avg_completion_pct
FROM v_qoe_hourly
WHERE hour BETWEEN $__timeFrom AND $__timeTo
  AND content_type = 'vod'
  AND ($platform = 'ALL' OR platform = $platform)
  AND ($cdn      = 'ALL' OR cdn      = $cdn)
ORDER BY hour ASC;


-- ---------------------------------------------------------------------------
-- Panel: Unique Viewers — hourly trend
-- Query type: Time series
-- ---------------------------------------------------------------------------
SELECT
    hour                        AS time,
    unique_sessions             AS unique_viewers
FROM v_qoe_hourly
WHERE hour BETWEEN $__timeFrom AND $__timeTo
  AND ($platform     = 'ALL' OR platform     = $platform)
  AND ($cdn          = 'ALL' OR cdn          = $cdn)
  AND ($content_type = 'ALL' OR content_type = $content_type)
ORDER BY hour ASC;


-- ---------------------------------------------------------------------------
-- Panel: Total Watch Time (hours) — daily bar chart
-- Query type: Bar chart
-- ---------------------------------------------------------------------------
SELECT
    toStartOfDay(hour)              AS day,
    round(sum(total_watch_time_s) / 3600, 1) AS watch_time_hours
FROM v_qoe_hourly
WHERE hour BETWEEN $__timeFrom AND $__timeTo
  AND ($platform     = 'ALL' OR platform     = $platform)
  AND ($content_type = 'ALL' OR content_type = $content_type)
GROUP BY day
ORDER BY day ASC;
