/**
 * GeoIP enrichment service — adds country, city, ISP, and ASN to events.
 *
 * Uses MaxMind GeoLite2 databases (local mmdb files) via the `maxmind` npm package.
 * Database files must be downloaded separately from maxmind.com (free registration).
 *
 * Never sends any IP address to an external service — all lookups are local.
 * The raw IP is not stored; only the derived geo/ASN fields are attached to events.
 */

import * as maxmind from 'maxmind';
import type { CityResponse, AsnResponse } from 'maxmind';
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

/**
 * Initialise both GeoIP readers.
 * Called once at server startup. If the DB files are missing, enrichment
 * is silently skipped (all fields null) — not a fatal error.
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
 * Safe to call with private/loopback IPs (returns all nulls).
 */
export function lookupGeo(ip: string): GeoInfo {
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

  if (!cityReader && !asnReader) return result;

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
  } catch {
    // IP parse failure or other lookup error — return partial/empty result
  }

  return result;
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
