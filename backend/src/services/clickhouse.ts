/**
 * ClickHouse writer service.
 *
 * Responsibilities:
 *  - Maintain a single @clickhouse/client instance
 *  - Insert valid events into the `analytics_events` table
 *  - Insert invalid events into `analytics_events_invalid` for debugging
 *  - Both inserts use async streaming inserts (non-blocking)
 *
 * The schema for both tables is in clickhouse/schema.sql.
 */

import { createClient } from '@clickhouse/client';
import type { ClickHouseClient } from '@clickhouse/client';
import { config } from '../config';
import type { AnalyticsEvent } from '../../../schema/events';

export type EnrichedEvent = AnalyticsEvent & {
  // Server-side enriched fields — added after geo lookup
  received_at:    number;   // epoch ms when collector received the batch
  client_ip_hash: string;   // SHA-256 of client IP — never store raw IP
  country_code:   string | null;
  country_name:   string | null;
  region:         string | null;
  city:           string | null;
  latitude:       number | null;
  longitude:      number | null;
  isp:            string | null;
  asn:            number | null;
  collector_version: string;
};

// Singleton ClickHouse client
let ch: ClickHouseClient | null = null;

export function getClickHouseClient(): ClickHouseClient {
  if (!ch) {
    ch = createClient({
      host:     config.clickhouse.host,
      database: config.clickhouse.database,
      username: config.clickhouse.username,
      password: config.clickhouse.password,
      request_timeout: 30_000,
      // Compression reduces bandwidth between collector and ClickHouse
      compression: { request: true, response: true },
      clickhouse_settings: {
        // Async inserts let ClickHouse buffer and merge small batches server-side
        async_insert:                          1,
        wait_for_async_insert:                 0,
        async_insert_max_data_size:            '10485760', // 10 MB
        async_insert_busy_timeout_ms:          5000
      }
    });
  }
  return ch;
}

const COLLECTOR_VERSION = '1.0.0';

/**
 * Insert a batch of validated, enriched events into ClickHouse.
 * Fire-and-forget from the request handler's perspective — errors are logged
 * but do not cause the HTTP response to fail (we already returned 202 to the client).
 */
export async function insertEvents(events: EnrichedEvent[]): Promise<void> {
  if (events.length === 0) return;

  const rows = events.map(e => flattenEvent(e));

  await getClickHouseClient().insert({
    table: 'analytics_events',
    values: rows,
    format: 'JSONEachRow'
  });
}

/**
 * Insert invalid events for debugging / monitoring.
 * Keeps the raw payload as a JSON string for inspection.
 */
export async function insertInvalidEvents(
  items: Array<{ event: unknown; errors: string }>,
  receivedAt: number,
  clientIpHash: string
): Promise<void> {
  if (items.length === 0) return;

  const rows = items.map(item => ({
    received_at:    receivedAt,
    client_ip_hash: clientIpHash,
    raw_event:      JSON.stringify(item.event),
    validation_errors: item.errors
  }));

  await getClickHouseClient().insert({
    table: 'analytics_events_invalid',
    values: rows,
    format: 'JSONEachRow'
  });
}

/**
 * Flatten the nested AnalyticsEvent envelope into a single-level row
 * matching the ClickHouse `analytics_events` table schema.
 */
function flattenEvent(e: EnrichedEvent): Record<string, unknown> {
  return {
    // Time
    event_date:  toDateString(e.timestamp),
    timestamp:   e.timestamp,
    received_at: e.received_at,

    // Envelope
    session_id:   e.session_id,
    event_type:   e.event_type,
    seq:          e.seq,
    platform:     e.platform,

    // Content
    content_id:    e.content.content_id,
    content_type:  e.content.type,
    content_title: e.content.title,
    duration_s:    e.content.duration_s ?? -1,
    series_id:     e.content.series_id ?? '',

    // Player
    player_engine:         e.player.engine,
    player_engine_version: e.player.engine_version,
    sdk_version:           e.player.sdk_version,

    // Network
    connection_type: e.network.connection_type,
    cdn:             e.network.cdn ?? '',
    bandwidth_kbps:  e.network.bandwidth_kbps ?? 0,

    // Device
    device_os:         e.device.os,
    device_os_version: e.device.os_version,
    device_model:      e.device.model,
    screen_resolution: e.device.screen_resolution ?? '',

    // Geo (server-enriched)
    country_code:  e.country_code ?? '',
    country_name:  e.country_name ?? '',
    region:        e.region ?? '',
    city:          e.city ?? '',
    latitude:      e.latitude ?? 0,
    longitude:     e.longitude ?? 0,
    isp:           e.isp ?? '',
    asn:           e.asn ?? 0,

    // Client identity (hashed — no raw IP)
    client_ip_hash: e.client_ip_hash,

    // Payload — stored as JSON string for flexible querying
    payload: JSON.stringify(e.payload),

    collector_version: COLLECTOR_VERSION
  };
}

function toDateString(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10); // "YYYY-MM-DD"
}
