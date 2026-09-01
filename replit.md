# Running on Replit

This repository runs as two workflows:

- **Player Demo**: `PORT=5000 node player-demo/server.js`
  - Opens the browser preview on port 5000.
  - Proxies `/v1/collect` to the local collector workflow.
- **Collector API**: `cd backend && npm ci --no-audit --no-fund && npm run build && NODE_ENV=production npm start`
  - Runs the compiled Fastify collector on port 3000.
  - Restores locked dependencies and builds automatically from a clean checkout.
  - `GET /health` confirms the HTTP service is running.
  - `GET /ready` returns `503` until ClickHouse is configured.

## Build the collector

```bash
cd backend
npm install
npm run build
```

## Optional services

The original Docker Compose stack is retained for non-Replit environments. Replit does not run the repository's Docker Compose stack, so ClickHouse and Grafana require separately hosted services.

Configure a hosted ClickHouse instance with:

- `CLICKHOUSE_HOST`
- `CLICKHOUSE_DATABASE`
- `CLICKHOUSE_USER`
- `CLICKHOUSE_PASSWORD`

GeoIP enrichment is optional. To enable it, provide the MaxMind GeoLite2 City and ASN database files and set:

- `GEOIP_DB_PATH`
- `GEOIP_ASN_DB_PATH`

Without ClickHouse, the demo and collector health endpoint run, but accepted analytics events are not persisted and `/ready` remains unavailable.