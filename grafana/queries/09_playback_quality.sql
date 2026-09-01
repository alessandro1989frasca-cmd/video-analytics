-- Dashboard 9: Playback Quality
-- Grafana variables: $__timeFrom, $__timeTo, $content_id, $platform, $cdn

-- Panel: Average buffer health over time
SELECT
    event_minute AS time,
    avg(buffer_length_s) AS average_buffer_seconds,
    quantile(0.10)(buffer_length_s) AS p10_buffer_seconds
FROM analytics_heartbeats
WHERE event_minute BETWEEN $__timeFrom AND $__timeTo
  AND ('$content_id' = 'all' OR content_id = '$content_id')
  AND ('$platform' = 'all' OR platform = '$platform')
  AND ('$cdn' = 'all' OR cdn = '$cdn')
GROUP BY event_minute
ORDER BY time;

-- Panel: Frame drop ratio by platform
SELECT
    platform,
    sum(dropped_video_frames) /
      nullIf(sum(decoded_video_frames), 0) * 100 AS dropped_frame_pct
FROM
(
    SELECT
        session_id,
        platform,
        max(dropped_video_frames) AS dropped_video_frames,
        max(decoded_video_frames) AS decoded_video_frames
    FROM analytics_heartbeats
    WHERE event_minute BETWEEN $__timeFrom AND $__timeTo
      AND ('$content_id' = 'all' OR content_id = '$content_id')
      AND ('$platform' = 'all' OR platform = '$platform')
      AND ('$cdn' = 'all' OR cdn = '$cdn')
    GROUP BY session_id, platform
)
GROUP BY platform
ORDER BY dropped_frame_pct DESC;

-- Panel: Playback sessions at risk of rebuffering
SELECT
    session_id,
    content_id,
    platform,
    cdn,
    min(buffer_length_s) AS minimum_buffer_seconds,
    avg(buffer_length_s) AS average_buffer_seconds,
    max(bandwidth_estimate_kbps) AS peak_bandwidth_estimate_kbps
FROM analytics_heartbeats
WHERE event_minute BETWEEN $__timeFrom AND $__timeTo
  AND ('$content_id' = 'all' OR content_id = '$content_id')
  AND ('$platform' = 'all' OR platform = '$platform')
  AND ('$cdn' = 'all' OR cdn = '$cdn')
GROUP BY session_id, content_id, platform, cdn
HAVING minimum_buffer_seconds < 2
ORDER BY minimum_buffer_seconds ASC
LIMIT 100;

-- Panel: Playback rate distribution
SELECT
    playback_rate,
    count() AS heartbeat_samples
FROM analytics_heartbeats
WHERE event_minute BETWEEN $__timeFrom AND $__timeTo
  AND ('$content_id' = 'all' OR content_id = '$content_id')
  AND ('$platform' = 'all' OR platform = '$platform')
GROUP BY playback_rate
ORDER BY playback_rate;