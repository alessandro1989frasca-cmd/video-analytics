-- =============================================================================
-- Retention & Maintenance
-- =============================================================================
-- TTL is already declared on all tables in schema.sql.
-- ClickHouse enforces TTL lazily during merges; run these commands if you need
-- to trigger immediate cleanup or change retention on a live system.
-- =============================================================================

USE analytics;

-- ---------------------------------------------------------------------------
-- Force TTL cleanup on all tables
-- (Only needed if you want immediate reclaim — TTL auto-runs during merges)
-- ---------------------------------------------------------------------------

-- SYSTEM MATERIALIZE TTL analytics_events;
-- SYSTEM MATERIALIZE TTL analytics_sessions;
-- SYSTEM MATERIALIZE TTL analytics_heartbeats;
-- SYSTEM MATERIALIZE TTL analytics_cdn_requests;
-- SYSTEM MATERIALIZE TTL analytics_errors;


-- ---------------------------------------------------------------------------
-- Manual partition drop (alternative to TTL — runs instantly)
-- Example: drop all events older than 90 days
-- ---------------------------------------------------------------------------

-- ALTER TABLE analytics_events
--     DROP PARTITION toYYYYMM(toDate(now()) - INTERVAL 91 DAY);


-- ---------------------------------------------------------------------------
-- Storage size report — run periodically to monitor growth
-- ---------------------------------------------------------------------------

SELECT
    table,
    formatReadableSize(sum(bytes_on_disk))   AS disk_size,
    formatReadableSize(sum(data_uncompressed_bytes)) AS uncompressed_size,
    round(sum(bytes_on_disk) / sum(data_uncompressed_bytes), 2) AS compression_ratio,
    sum(rows)                                AS total_rows,
    count()                                  AS part_count
FROM system.parts
WHERE database = 'analytics'
  AND active = 1
GROUP BY table
ORDER BY sum(bytes_on_disk) DESC;


-- ---------------------------------------------------------------------------
-- Partition list — useful for planning manual drops
-- ---------------------------------------------------------------------------

SELECT
    table,
    partition,
    rows,
    formatReadableSize(bytes_on_disk) AS disk_size,
    modification_time
FROM system.parts
WHERE database = 'analytics'
  AND active = 1
ORDER BY table, partition;


-- ---------------------------------------------------------------------------
-- Async insert queue status
-- Monitor if inserts are being processed or backing up
-- ---------------------------------------------------------------------------

SELECT
    database,
    table,
    current_bytes,
    rows,
    last_reset_time
FROM system.asynchronous_insert_log
WHERE database = 'analytics'
ORDER BY last_reset_time DESC
LIMIT 20;


-- ---------------------------------------------------------------------------
-- Materialized view refresh status
-- ---------------------------------------------------------------------------

SELECT
    database,
    name,
    engine,
    is_live_view,
    dependencies_database,
    dependencies_table
FROM system.tables
WHERE database = 'analytics'
  AND engine LIKE '%MaterializedView%'
ORDER BY name;
