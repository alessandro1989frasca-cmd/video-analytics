/**
 * GeoIP enrichment service — adds country, city, ISP, and ASN to events.
 *
 * Prefers MaxMind GeoLite2 databases (local mmdb files) via the `maxmind` npm
 * package. If those files are unavailable, the demo fallback uses ipwho.is
 * with a short timeout and an in-memory cache.
 *
 * The external fallback is intended for demos: the visitor IP is sent to the
 * configured provider. The raw IP is not stored in the event payload; only the
 * derived geo/ASN fields are attached to events.
 */

import * as maxmind from 'maxmind';
import type { CityResponse, AsnResponse } from 'maxmind';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { config } from '../config';

interface GeoInfo {
  country_code:  string | null;
  country_name:  string | null;
  region:        string | null;
  city:          string | null;
  latitude:      number | null;
  longitude:     number | null;
  isp:           string | null;
  asn:           number | null;
}

let cityReader: maxmind.Reader<CityResponse>  | null = null;
let asnReader:  maxmind.Reader<AsnResponse>   | null = null;
let initAttempted = false;
const externalCache = new Map<string, { expiresAt: number; value: GeoInfo }>();
const EXTERNAL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Initialise both GeoIP readers.
 * Called once at server startup. If the DB files are missing, the external
 * fallback is used by lookupGeo — not a fatal startup error.
 */
export async function initGeoIp(): Promise<void> {
  if (initAttempted) return;
  initAttempted = true;

  try {
    cityReader = await maxmind.open<CityResponse>(config.geoip.cityDbPath);
  } catch (err) {
    console.warn('[GeoIP] City DB not loaded — enrichment disabled:', (err as Error).message);
  }

  try {
    asnReader = await maxmind.open<AsnResponse>(config.geoip.asnDbPath);
  } catch (err) {
    console.warn('[GeoIP] ASN DB not loaded — ISP enrichment disabled:', (err as Error).message);
  }
}

/**
 * Look up geo and ISP info for an IP address.
 * Returns null fields for anything not found.
 * Safe to call with private/loopback IPs (returns all nulls). When local
 * databases are unavailable, performs one cached external lookup per public IP.
 */
export async function lookupGeo(ip: string): Promise<GeoInfo> {
  const result: GeoInfo = {
    country_code: null,
    country_name: null,
    region:       null,
    city:         null,
    latitude:     null,
    longitude:    null,
    isp:          null,
    asn:          null
  };

  if (!cityReader && !asnReader && !isPublicIp(ip)) return result;

  if (cityReader || asnReader) {
    try {
      if (cityReader) {
        const city = cityReader.get(ip);
        if (city) {
          result.country_code = city.country?.iso_code ?? null;
          result.country_name = city.country?.names?.en ?? null;
          result.region       = city.subdivisions?.[0]?.names?.en ?? null;
          result.city         = city.city?.names?.en ?? null;
          result.latitude     = city.location?.latitude ?? null;
          result.longitude    = city.location?.longitude ?? null;
        }
      }

      if (asnReader) {
        const asn = asnReader.get(ip);
        if (asn) {
          result.isp = (asn as any).autonomous_system_organization ?? null;
          result.asn = (asn as any).autonomous_system_number ?? null;
        }
      }
      return result;
    } catch {
      // Fall through to the external lookup if the local reader fails.
    }
  }

  const cacheKey = createHash('sha256').update(ip).digest('hex');
  const cached = externalCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.geoip.externalTimeoutMs);
    let response: Response;
    try {
      response = await fetch(
        `${config.geoip.externalUrl.replace(/\/$/, '')}/${encodeURIComponent(ip)}`,
        { signal: controller.signal, headers: { accept: 'application/json' } }
      );
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) return result;

    const data = await response.json() as {
      success?: boolean;
      country_code?: string;
      country?: string;
      region?: string;
      city?: string;
      latitude?: number;
      longitude?: number;
      connection?: { isp?: string; asn?: string | number };
    };
    if (data.success === false) return result;

    const value: GeoInfo = {
      country_code: data.country_code ?? null,
      country_name: data.country ?? null,
      region: data.region ?? null,
      city: data.city ?? null,
      latitude: Number.isFinite(data.latitude) ? data.latitude! : null,
      longitude: Number.isFinite(data.longitude) ? data.longitude! : null,
      isp: data.connection?.isp ?? null,
      asn: typeof data.connection?.asn === 'string'
        ? parseAsn(data.connection.asn)
        : data.connection?.asn ?? null
    };
    externalCache.set(cacheKey, { expiresAt: Date.now() + EXTERNAL_CACHE_TTL_MS, value });
    return value;
  } catch {
    return result;
  }
}

function parseAsn(value: string): number | null {
  const numeric = Number(value.replace(/^AS/i, ''));
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : null;
}

function isPublicIp(ip: string): boolean {
  const normalized = ip.replace(/^\[|\]$/g, '').split('%')[0];
  const version = isIP(normalized);
  if (version === 4) {
    const octets = normalized.split('.').map(Number);
    const [a, b] = octets;
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (version === 6) {
    const lower = normalized.toLowerCase();
    return lower !== '::1' &&
      !lower.startsWith('fc') &&
      !lower.startsWith('fd') &&
      !lower.startsWith('fe80:');
  }
  return false;
}

/**
 * Extract the real client IP from a Fastify request.
 * Handles X-Forwarded-For (set by CDN/load balancer) and falls back to
 * the socket remote address.
 *
 * Important: only trust X-Forwarded-For if your load balancer sets it.
 * Configure TRUSTED_PROXIES in production to avoid IP spoofing.
 */
export function extractClientIp(
  remoteAddress: string | undefined,
  headers: Record<string, string | string[] | undefined>
): string {
  // X-Forwarded-For: client, proxy1, proxy2
  const xff = headers['x-forwarded-for'];
  if (xff) {
    const first = Array.isArray(xff) ? xff[0] : xff.split(',')[0];
    return first.trim();
  }

  // Cloudflare real IP header
  const cfIp = headers['cf-connecting-ip'];
  if (cfIp) return Array.isArray(cfIp) ? cfIp[0] : cfIp;

  return remoteAddress ?? '0.0.0.0';
}
