-- Stable anonymous viewer identifier supplied by the client.
-- It is not an account identifier and changes when local browser storage is reset.

ALTER TABLE analytics.analytics_events
    ADD COLUMN IF NOT EXISTS viewer_id String DEFAULT ''
    AFTER session_id;

ALTER TABLE analytics.analytics_sessions
    ADD COLUMN IF NOT EXISTS viewer_id String DEFAULT ''
    AFTER session_id;