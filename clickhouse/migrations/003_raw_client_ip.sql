-- The user opted into raw IP collection for the demo.
-- analytics_events retains raw events for 90 days; analytics_sessions retains
-- the summary (and IP) for 365 days unless its TTL is changed separately.

ALTER TABLE analytics.analytics_events
    ADD COLUMN IF NOT EXISTS client_ip String DEFAULT ''
    AFTER client_ip_hash;