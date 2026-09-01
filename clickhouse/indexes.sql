-- =============================================================================
-- Secondary / Skip Indexes
-- =============================================================================
-- ClickHouse primary key (ORDER BY) already handles most query patterns.
-- These secondary indexes accelerate specific high-cardinality filters.
-- =============================================================================

USE analytics;

-- ---------------------------------------------------------------------------
-- analytics_events: fast lookup by session_id (for drill-down)
-- ---------------------------------------------------------------------------
ALTER TABLE analytics_events
    ADD INDEX IF NOT EXISTS idx_session_id session_id TYPE bloom_filter(0.01) GRANULARITY 4;

-- ---------------------------------------------------------------------------
-- analytics_events: fast lookup by content_id (for per-content dashboards)
-- ---------------------------------------------------------------------------
ALTER TABLE analytics_events
    ADD INDEX IF NOT EXISTS idx_content_id content_id TYPE bloom_filter(0.01) GRANULARITY 4;

-- ---------------------------------------------------------------------------
-- analytics_errors: fast lookup by error_code
-- ---------------------------------------------------------------------------
ALTER TABLE analytics_errors
    ADD INDEX IF NOT EXISTS idx_error_code error_code TYPE bloom_filter(0.01) GRANULARITY 4;

-- ---------------------------------------------------------------------------
-- analytics_cdn_requests: fast filter on cdn_name + http_status for CDN health
-- ---------------------------------------------------------------------------
ALTER TABLE analytics_cdn_requests
    ADD INDEX IF NOT EXISTS idx_cdn_name cdn_name TYPE set(20) GRANULARITY 4;

ALTER TABLE analytics_cdn_requests
    ADD INDEX IF NOT EXISTS idx_cdn_http_status http_status TYPE set(50) GRANULARITY 4;

-- ---------------------------------------------------------------------------
-- Build skip indexes for existing data (needed after ALTER ADD INDEX)
-- ---------------------------------------------------------------------------
-- ALTER TABLE analytics_events MATERIALIZE INDEX idx_session_id;
-- ALTER TABLE analytics_events MATERIALIZE INDEX idx_content_id;
-- ALTER TABLE analytics_errors MATERIALIZE INDEX idx_error_code;
-- ALTER TABLE analytics_cdn_requests MATERIALIZE INDEX idx_cdn_name;
-- ALTER TABLE analytics_cdn_requests MATERIALIZE INDEX idx_cdn_http_status;
