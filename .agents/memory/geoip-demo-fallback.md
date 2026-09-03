---
name: GeoIP demo fallback
description: Privacy and reliability tradeoff chosen for location enrichment when local GeoLite databases are unavailable.
---

Use an external IP-geolocation fallback for the demo, with a short timeout, hashed-key in-memory cache, and empty-data fallback. Prefer local GeoLite databases for a production deployment.

**Why:** The user chose the simplest setup without downloading GeoLite files and accepted that the visitor IP is sent to an external provider for approximate location.

**How to apply:** Keep raw IPs out of persisted analytics and logs. Any production hardening should offer local GeoLite lookup to remove the third-party disclosure and rate-limit dependency.