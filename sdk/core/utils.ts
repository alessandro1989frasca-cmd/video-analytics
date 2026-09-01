/**
 * Utility functions for the SDK core.
 * No external dependencies — must work in any JS runtime (browser, Node, QuickJS on Smart TV).
 */

import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// UUID v4 — RFC 4122, crypto-random
// ---------------------------------------------------------------------------

/**
 * Generates a UUID v4.
 * Uses crypto.getRandomValues in browser environments; crypto.randomUUID if available.
 */
export function generateUUID(): string {
  // Modern environments (Chrome 92+, Node 15.6+, Safari 15.4+)
  if (typeof crypto !== 'undefined' && typeof (crypto as any).randomUUID === 'function') {
    return (crypto as any).randomUUID() as string;
  }

  // Fallback: manual construction via getRandomValues
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }

  // Last resort (Node < 15): Math.random (not cryptographically secure but acceptable for session IDs)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ---------------------------------------------------------------------------
// SHA-256 hash for user IDs (GDPR compliance)
// ---------------------------------------------------------------------------

/**
 * Returns the SHA-256 hex digest of the input string.
 * In Node (backend/server-side rendering): uses the built-in `crypto` module.
 * In the browser: uses the Web Crypto API (async).
 */
export async function sha256Hex(input: string): Promise<string> {
  if (typeof window === 'undefined') {
    // Node.js
    return createHash('sha256').update(input, 'utf8').digest('hex');
  }

  // Browser Web Crypto
  const encoded = new TextEncoder().encode(input);
  const hashBuffer = await window.crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Monotonic timestamp
// ---------------------------------------------------------------------------

/** Returns the current epoch in milliseconds. */
export function now(): number {
  return Date.now();
}

// ---------------------------------------------------------------------------
// Exponential back-off
// ---------------------------------------------------------------------------

/**
 * Computes the next retry delay with full jitter.
 * delay = random(0, min(cap, base * 2^attempt))
 */
export function backoffMs(attempt: number, baseMs: number, capMs = 30_000): number {
  const ceiling = Math.min(capMs, baseMs * Math.pow(2, attempt));
  return Math.floor(Math.random() * ceiling);
}

// ---------------------------------------------------------------------------
// Debug logger — stripped in production via tree-shaking / dead-code elimination
// ---------------------------------------------------------------------------

let _debugEnabled = false;

export function setDebug(enabled: boolean): void {
  _debugEnabled = enabled;
}

export function log(message: string, ...args: unknown[]): void {
  if (_debugEnabled) {
    console.log(`[VideoAnalytics] ${message}`, ...args);
  }
}

export function warn(message: string, ...args: unknown[]): void {
  if (_debugEnabled) {
    console.warn(`[VideoAnalytics] ${message}`, ...args);
  }
}
