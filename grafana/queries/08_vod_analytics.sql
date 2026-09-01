-- =============================================================================
-- Dashboard 8: VOD Analytics
-- Panels: Completion rate, abandonment curve, binge behaviour, per-title QoE
-- Only applies to content_type = 'vod'
-- Grafana variables: $__timeFrom, $__timeTo, $content_id, $platform, $cdn
-- Refresh: 5min
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Panel: Overall VOD Completion Rate — Stat
-- Query type: Stat / Gauge
-- ---------------------------------------------------------------------------
SELECT
    round(avg(completion_pct), 1)   AS avg_completion_pct,
    countIf(completion_pct >= 90)   AS completions,
    count()                         AS total_sessions,
    round(100.0 * countIf(completion_pct >= 90) / count(), 1) AS completion_rate_pct
FROM analytics_sessions
WHERE session_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND content_type = 'vod'
  AND completion_pct >= 0
  AND ($content_id = 'ALL' OR content_id = $content_id)
  AND ($platform   = 'ALL' OR platform   = $platform)
  AND ($cdn        = 'ALL' OR cdn        = $cdn);


-- ---------------------------------------------------------------------------
-- Panel: Abandonment Curve — at which % do viewers drop off?
-- Fine-grained 5% buckets for a smooth curve.
-- Query type: Bar chart / Line chart
-- ---------------------------------------------------------------------------
SELECT
    floor(completion_pct / 5) * 5  AS pct_bucket,
    count()                         AS sessions_ending_here
FROM analytics_sessions
WHERE session_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND content_type = 'vod'
  AND completion_pct >= 0
  AND session_end_reason != 'error'   -- exclude error-terminated sessions for clean curve
  AND ($content_id = 'ALL' OR content_id = $content_id)
  AND ($platform   = 'ALL' OR platform   = $platform)
GROUP BY pct_bucket
ORDER BY pct_bucket ASC;


-- ---------------------------------------------------------------------------
-- Panel: Abandonment Curve by Platform (for A/B comparison)
-- Query type: Time series / Line chart (one line per platform)
-- ---------------------------------------------------------------------------
SELECT
    floor(completion_pct / 5) * 5  AS pct_bucket,
    platform,
    count()                         AS sessions_ending_here
FROM analytics_sessions
WHERE session_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND content_type = 'vod'
  AND completion_pct >= 0
  AND session_end_reason != 'error'
  AND ($content_id = 'ALL' OR content_id = $content_id)
GROUP BY pct_bucket, platform
ORDER BY pct_bucket ASC;


-- ---------------------------------------------------------------------------
-- Panel: Completion Rate over time — daily trend
-- Query type: Time series
-- ---------------------------------------------------------------------------
SELECT
    session_date                                            AS date,
    round(avg(completion_pct), 1)                           AS avg_completion_pct,
    round(100.0 * countIf(completion_pct >= 90) / count(), 1) AS completion_rate_pct,
    count()                                                 AS sessions
FROM analytics_sessions
WHERE session_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND content_type = 'vod'
  AND completion_pct >= 0
  AND ($content_id = 'ALL' OR content_id = $content_id)
  AND ($platform   = 'ALL' OR platform   = $platform)
GROUP BY session_date
ORDER BY session_date ASC;


-- ---------------------------------------------------------------------------
-- Panel: Watch Time Distribution — how long do VOD sessions last?
-- Query type: Histogram / Bar chart
-- ---------------------------------------------------------------------------
SELECT
    multiIf(
        watch_time_s < 30,    '< 30s',
        watch_time_s < 120,   '30s-2min',
        watch_time_s < 300,   '2-5min',
        watch_time_s < 600,   '5-10min',
        watch_time_s < 1200,  '10-20min',
        watch_time_s < 2400,  '20-40min',
        watch_time_s < 3600,  '40-60min',
                              '> 60min'
    )                               AS watch_bucket,
    count()                         AS sessions
FROM analytics_sessions
WHERE session_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND content_type = 'vod'
  AND ($content_id = 'ALL' OR content_id = $content_id)
  AND ($platform   = 'ALL' OR platform   = $platform)
GROUP BY watch_bucket
ORDER BY watch_bucket ASC;


-- ---------------------------------------------------------------------------
-- Panel: Top 20 VOD assets by Completion Rate
-- Only assets with enough sessions to be statistically significant
-- Query type: Bar chart
-- ---------------------------------------------------------------------------
SELECT
    content_title,
    content_id,
    count()                                                     AS sessions,
    round(avg(completion_pct), 1)                               AS avg_completion_pct,
    round(100.0 * countIf(completion_pct >= 90) / count(), 1)   AS completion_rate_pct,
    round(avg(watch_time_s), 0)                                 AS avg_watch_time_s
FROM analytics_sessions
WHERE session_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND content_type = 'vod'
  AND completion_pct >= 0
  AND ($platform = 'ALL' OR platform = $platform)
GROUP BY content_id, content_title
HAVING sessions >= 50
ORDER BY avg_completion_pct DESC
LIMIT 20;


-- ---------------------------------------------------------------------------
-- Panel: Exit Before Video Starts (EBVS) — sessions that abandoned during load
-- Distinct from errors: user left voluntarily during the loading spinner
-- Query type: Stat + Trend
-- ---------------------------------------------------------------------------
-- EBVS rate stat
SELECT
    count()                                                     AS total_sessions,
    countIf(exit_before_start = 1)                              AS ebvs_sessions,
    round(100.0 * countIf(exit_before_start = 1) / count(), 2)  AS ebvs_rate_pct
FROM analytics_sessions
WHERE session_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND content_type = 'vod'
  AND ($platform   = 'ALL' OR platform   = $platform)
  AND ($cdn        = 'ALL' OR cdn        = $cdn);

-- EBVS trend
SELECT
    session_date                                                AS date,
    round(100.0 * countIf(exit_before_start = 1) / count(), 2)  AS ebvs_rate_pct
FROM analytics_sessions
WHERE session_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND content_type = 'vod'
  AND ($platform   = 'ALL' OR platform   = $platform)
GROUP BY session_date
ORDER BY session_date ASC;


-- ---------------------------------------------------------------------------
-- Panel: Session End Reason breakdown
-- completed / user_stop / error — shows natural vs forced endings
-- Query type: Pie chart
-- ---------------------------------------------------------------------------
SELECT
    session_end_reason,
    count()                                     AS sessions,
    round(100.0 * count() / sum(count()) OVER (), 1) AS pct
FROM analytics_sessions
WHERE session_date BETWEEN toDate($__timeFrom) AND toDate($__timeTo)
  AND content_type = 'vod'
  AND ($content_id = 'ALL' OR content_id = $content_id)
  AND ($platform   = 'ALL' OR platform   = $platform)
GROUP BY session_end_reason
ORDER BY sessions DESC;
