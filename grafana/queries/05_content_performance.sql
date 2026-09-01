-- =============================================================================
-- Dashboard 5: Content Performance
-- Panels: Top content by views, QoE per asset, Completion rate ranking
-- Grafana variables: $__timeFrom, $__timeTo, $content_type, $platform
-- Refresh: 5min
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Panel: Top 20 Content by Sessions — bar chart
-- Query type: Bar chart
-- ---------------------------------------------------------------------------
SELECT
    content_id,
    content_title,
    count()                     AS sessions,
    round(sum(watch_time_s) / 3600, 1)  AS watch_time_hours,
    round(avg(watch_time_s), 0)         AS avg_watch_time_s
FROM analytics_sessions
WHERE session_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND ($content_type = 'ALL' OR content_type = $content_type)
  AND ($platform     = 'ALL' OR platform     = $platform)
GROUP BY content_id, content_title
ORDER BY sessions DESC
LIMIT 20;


-- ---------------------------------------------------------------------------
-- Panel: QoE per Content — table (sortable by any metric)
-- Query type: Table
-- ---------------------------------------------------------------------------
SELECT
    content_id,
    content_title,
    content_type,
    count()                                                     AS sessions,
    round(avg(watch_time_s), 0)                                 AS avg_watch_time_s,
    round(avg(toFloat32(startup_time_ms)), 0)                   AS avg_startup_ms,
    round(100.0 * sum(rebuffer_time_s) / nullIf(sum(watch_time_s), 0), 3) AS rebuffer_ratio_pct,
    round(100.0 * countIf(had_error = 1) / count(), 2)          AS error_rate_pct,
    round(100.0 * countIf(video_start_failure = 1) / count(), 2) AS vsf_rate_pct,
    round(avg(if(completion_pct >= 0, completion_pct, NULL)), 1) AS avg_completion_pct
FROM analytics_sessions
WHERE session_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND ($content_type = 'ALL' OR content_type = $content_type)
  AND ($platform     = 'ALL' OR platform     = $platform)
GROUP BY content_id, content_title, content_type
HAVING sessions >= 10
ORDER BY sessions DESC
LIMIT 50;


-- ---------------------------------------------------------------------------
-- Panel: VOD Completion Rate — bar chart (sorted descending)
-- Query type: Bar chart
-- ---------------------------------------------------------------------------
SELECT
    content_title,
    round(avg(completion_pct), 1)       AS avg_completion_pct,
    count()                             AS sessions
FROM analytics_sessions
WHERE session_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND content_type = 'vod'
  AND completion_pct >= 0
  AND ($platform = 'ALL' OR platform = $platform)
GROUP BY content_title
HAVING sessions >= 20
ORDER BY avg_completion_pct DESC
LIMIT 20;


-- ---------------------------------------------------------------------------
-- Panel: Abandonment Curve (VOD)
-- At which % of content do viewers drop off?
-- Buckets: 0-10, 10-20, ..., 90-100
-- Query type: Bar chart / Histogram
-- ---------------------------------------------------------------------------
SELECT
    multiIf(
        completion_pct < 10,  '0-10%',
        completion_pct < 20,  '10-20%',
        completion_pct < 30,  '20-30%',
        completion_pct < 40,  '30-40%',
        completion_pct < 50,  '40-50%',
        completion_pct < 60,  '50-60%',
        completion_pct < 70,  '60-70%',
        completion_pct < 80,  '70-80%',
        completion_pct < 90,  '80-90%',
                              '90-100%'
    )                               AS completion_bucket,
    count()                         AS sessions
FROM analytics_sessions
WHERE session_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND content_type = 'vod'
  AND completion_pct >= 0
  AND ($content_id = 'ALL' OR content_id = $content_id)
  AND ($platform   = 'ALL' OR platform   = $platform)
GROUP BY completion_bucket
ORDER BY completion_bucket ASC;


-- ---------------------------------------------------------------------------
-- Panel: Worst QoE Content (sorted by rebuffering)
-- Useful for content operations — flag assets with delivery problems
-- Query type: Table
-- ---------------------------------------------------------------------------
SELECT
    content_id,
    content_title,
    count()                                                     AS sessions,
    round(100.0 * sum(rebuffer_time_s) / nullIf(sum(watch_time_s), 0), 3) AS rebuffer_ratio_pct,
    round(100.0 * countIf(had_error = 1) / count(), 2)          AS error_rate_pct,
    round(avg(toFloat32(startup_time_ms)), 0)                   AS avg_startup_ms
FROM analytics_sessions
WHERE session_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND ($content_type = 'ALL' OR content_type = $content_type)
  AND ($platform     = 'ALL' OR platform     = $platform)
GROUP BY content_id, content_title
HAVING sessions >= 20
ORDER BY rebuffer_ratio_pct DESC
LIMIT 20;
