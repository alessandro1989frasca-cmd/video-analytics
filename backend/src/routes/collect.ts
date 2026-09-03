/**
 * POST /v1/collect — the main ingestion endpoint.
 *
 * Pipeline:
 *  1. Parse JSON body
 *  2. Validate outer envelope + per-event payloads (Ajv)
 *  3. Extract client IP, run geo-IP lookup
 *  4. Enrich each valid event with server-side fields
 *  5. Fire-and-forget insert into ClickHouse (valid + invalid tables)
 *  6. Return 202 Accepted immediately — client does not need to wait for CH insert
 *
 * The endpoint also supports:
 *  - OPTIONS (CORS preflight) — handled by @fastify/cors
 *  - Content-Encoding: gzip — handled by @fastify/compress
 *
 * Designed to handle high-throughput beacons from browser sendBeacon
 * (Content-Type: application/octet-stream / text/plain) as well as
 * standard application/json POST bodies.
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { createHash } from 'crypto';
import { validateBatchPayload } from '../services/validator';
import { lookupGeo, extractClientIp } from '../services/geoip';
import { insertEvents, insertInvalidEvents } from '../services/clickhouse';
import type { EnrichedEvent } from '../services/clickhouse';
import { config } from '../config';

// Fastify route plugin
const collectRoute: FastifyPluginAsync = async (fastify) => {

  // Accept both strict JSON and the blob types sendBeacon uses
  fastify.addContentTypeParser(
    ['text/plain', 'application/octet-stream'],
    { parseAs: 'string' },
    (req, body, done) => {
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  );

  fastify.post<{ Body: unknown }>(
    '/v1/collect',
    {
      schema: {
        response: {
          202: {
            type: 'object',
            properties: {
              accepted: { type: 'integer' },
              rejected: { type: 'integer' },
              request_id: { type: 'string' }
            }
          },
          400: {
            type: 'object',
            properties: { error: { type: 'string' } }
          }
        }
      }
    },
    async (request, reply) => {
      const receivedAt = Date.now();

      // -----------------------------------------------------------------------
      // 1. Validate
      // -----------------------------------------------------------------------
      const validation = validateBatchPayload(request.body);
      if (!validation.ok) {
        return reply.status(400).send({ error: validation.errors });
      }

      const { valid, invalid } = validation.result;

      // -----------------------------------------------------------------------
      // 2. Geo enrichment
      // -----------------------------------------------------------------------
      const clientIp = extractClientIp(
        request.socket.remoteAddress,
        request.headers as Record<string, string | string[] | undefined>
      );

      // Keep both the raw IP (demo retention: 90 days) and its hash for
      // correlation without exposing the address in normal dashboards.
      const clientIpHash = createHash('sha256').update(clientIp).digest('hex');

      const geo = await lookupGeo(clientIp);

      if (config.debugLogEvents) {
        request.log.debug({
          ip_hash: clientIpHash.slice(0, 8) + '…',
          geo,
          event_count: valid.length,
          invalid_count: invalid.length
        }, 'Batch received');
      }

      // -----------------------------------------------------------------------
      // 3. Enrich valid events with server-side fields
      // -----------------------------------------------------------------------
      const enriched: EnrichedEvent[] = valid.map(event => ({
        ...event,
        received_at:       receivedAt,
        client_ip_hash:    clientIpHash,
        client_ip:         clientIp,
        country_code:      geo.country_code,
        country_name:      geo.country_name,
        region:            geo.region,
        city:              geo.city,
        latitude:          geo.latitude,
        longitude:         geo.longitude,
        isp:               geo.isp,
        asn:               geo.asn,
        collector_version: '1.0.0'
      }));

      // -----------------------------------------------------------------------
      // 4. Fire-and-forget ClickHouse inserts
      // Neither insert blocks the HTTP response.
      // -----------------------------------------------------------------------
      Promise.all([
        insertEvents(enriched).catch(err =>
          request.log.error({ err }, 'ClickHouse insert (valid) failed')
        ),
        insertInvalidEvents(invalid, receivedAt, clientIpHash).catch(err =>
          request.log.error({ err }, 'ClickHouse insert (invalid) failed')
        )
      ]);

      // -----------------------------------------------------------------------
      // 5. Return 202 immediately
      // -----------------------------------------------------------------------
      return reply.status(202).send({
        accepted:   valid.length,
        rejected:   invalid.length,
        request_id: request.id as string
      });
    }
  );

  // Health check endpoint — used by load balancers and Kubernetes liveness probes
  fastify.get('/health', async (_request, reply) => {
    return reply.send({ status: 'ok', ts: Date.now() });
  });

  // Readiness probe — checks ClickHouse connectivity
  fastify.get('/ready', async (request, reply) => {
    try {
      const { getClickHouseClient } = await import('../services/clickhouse');
      await getClickHouseClient().query({ query: 'SELECT 1', format: 'JSONEachRow' });
      return reply.send({ status: 'ready' });
    } catch (err) {
      request.log.warn({ err }, 'Readiness check failed');
      return reply.status(503).send({ status: 'not_ready' });
    }
  });
};

export default collectRoute;
