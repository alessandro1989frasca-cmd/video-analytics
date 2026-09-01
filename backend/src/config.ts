/**
 * Centralised configuration loader.
 * Reads from environment variables (populated by dotenv in development,
 * real env vars in production / Docker / Kubernetes).
 */

import 'dotenv/config';

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  port:    parseInt(optional('PORT', '3000'), 10),
  host:    optional('HOST', '0.0.0.0'),
  logLevel: optional('LOG_LEVEL', 'info') as 'trace' | 'debug' | 'info' | 'warn' | 'error',

  clickhouse: {
    host:     optional('CLICKHOUSE_HOST', 'http://localhost:8123'),
    database: optional('CLICKHOUSE_DATABASE', 'analytics'),
    username: optional('CLICKHOUSE_USER', 'default'),
    password: optional('CLICKHOUSE_PASSWORD', '')
  },

  geoip: {
    cityDbPath: optional('GEOIP_DB_PATH', '/opt/geoip/GeoLite2-City.mmdb'),
    asnDbPath:  optional('GEOIP_ASN_DB_PATH', '/opt/geoip/GeoLite2-ASN.mmdb')
  },

  rateLimit: {
    max:      parseInt(optional('RATE_LIMIT_MAX', '300'), 10),
    windowMs: parseInt(optional('RATE_LIMIT_WINDOW_MS', '60000'), 10)
  },

  cors: {
    origins: optional('CORS_ORIGINS', '*').split(',').map(s => s.trim())
  },

  maxBatchEvents: parseInt(optional('MAX_BATCH_EVENTS', '500'), 10),
  debugLogEvents: optional('DEBUG_LOG_EVENTS', 'false') === 'true'
} as const;
