/**
 * Fastify server entry point — Video QoE Analytics Collector
 *
 * Plugins registered:
 *  - @fastify/helmet    — security headers
 *  - @fastify/cors      — CORS for browser beacons
 *  - @fastify/compress  — gzip/br response + accepts compressed bodies
 *  - @fastify/rate-limit — per-IP rate limiting
 *  - pino               — structured JSON logging (built into Fastify)
 *
 * Route plugins:
 *  - POST /v1/collect   — main ingestion endpoint
 *  - GET  /health       — liveness probe
 *  - GET  /ready        — readiness probe (checks ClickHouse)
 */

import Fastify from 'fastify';
import helmet  from '@fastify/helmet';
import cors    from '@fastify/cors';
import compress from '@fastify/compress';
import rateLimit from '@fastify/rate-limit';
import { config } from './config';
import { initGeoIp } from './services/geoip';
import collectRoute from './routes/collect';

async function buildServer() {
  const fastify = Fastify({
    logger: {
      level: config.logLevel,
      transport: process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined
    },
    // Trust the first proxy hop for IP extraction
    trustProxy: true,
    // Limit request body to 2 MB — a batch of 500 events is ~500 KB JSON
    bodyLimit: 2 * 1024 * 1024
  });

  // -------------------------------------------------------------------------
  // Security headers
  // -------------------------------------------------------------------------
  await fastify.register(helmet, {
    crossOriginResourcePolicy: { policy: 'cross-origin' }
  });

  // -------------------------------------------------------------------------
  // CORS — allow browsers to POST from any origin (analytics beacons)
  // -------------------------------------------------------------------------
  await fastify.register(cors, {
    origin: config.cors.origins.length === 1 && config.cors.origins[0] === '*'
      ? true
      : config.cors.origins,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Request-ID'],
    exposedHeaders: ['X-Request-ID'],
    // No credentials needed for analytics
    credentials: false,
    // Preflight cache: 24h
    maxAge: 86400
  });

  // -------------------------------------------------------------------------
  // Compression — accept gzip bodies (sendBeacon may send compressed)
  // -------------------------------------------------------------------------
  await fastify.register(compress, {
    requestEncodings: ['gzip', 'deflate'],
    encodings: ['gzip', 'br']
  });

  // -------------------------------------------------------------------------
  // Rate limiting — prevent abuse; legitimate SDKs batch events so they
  // never come close to 300 req/min per IP
  // -------------------------------------------------------------------------
  await fastify.register(rateLimit, {
    max:      config.rateLimit.max,
    timeWindow: config.rateLimit.windowMs,
    // Return 429 with Retry-After so SDK back-off logic can respect it
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Retry after ${Math.ceil(context.ttl / 1000)}s`,
      retryAfter: Math.ceil(context.ttl / 1000)
    })
  });

  // -------------------------------------------------------------------------
  // Request ID header
  // -------------------------------------------------------------------------
  fastify.addHook('onRequest', async (request, reply) => {
    if (!request.id) {
      const { v4: uuidv4 } = await import('uuid');
      request.id = uuidv4();
    }
    reply.header('X-Request-ID', request.id);
  });

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------
  await fastify.register(collectRoute);

  // -------------------------------------------------------------------------
  // Global error handler
  // -------------------------------------------------------------------------
  fastify.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, 'Unhandled error');

    // Don't leak internal error details to clients in production
    const isDev = process.env.NODE_ENV !== 'production';
    reply.status(error.statusCode ?? 500).send({
      error: isDev ? error.message : 'Internal server error',
      request_id: request.id
    });
  });

  return fastify;
}

// -------------------------------------------------------------------------
// Bootstrap
// -------------------------------------------------------------------------

async function main() {
  // Initialise GeoIP databases (non-blocking — missing DBs are warned, not fatal)
  await initGeoIp();

  const app = await buildServer();

  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`Collector listening on ${config.host}:${config.port}`);
  } catch (err) {
    app.log.fatal({ err }, 'Server failed to start');
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal} — shutting down gracefully`);
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

main();
