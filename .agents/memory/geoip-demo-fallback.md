---
name: GeoIP demo fallback
description: Privacy and reliability tradeoff chosen for location enrichment when local GeoLite databases are unavailable.
---

Use an external IP-geolocation fallback for the demo, with a short timeout, hashed-key in-memory cache, empty-data fallback, and raw IP retention limited to the raw-events table's 90-day TTL. Prefer local GeoLite databases for a production deployment.

**Why:** The user chose the simplest setup without downloading GeoLite files and explicitly accepted external lookup plus raw IP collection for technical analytics.

**How to apply:** Keep raw IPs out of logs and long-lived session aggregates. Any production hardening should offer local GeoLite lookup, a shorter retention policy, and an updated privacy notice.