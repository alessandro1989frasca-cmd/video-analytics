/**
 * SDK Core — public barrel export.
 * Platform adapters import from here, not from individual files.
 */

export { AnalyticsCore } from './AnalyticsCore';
export { SessionManager } from './SessionManager';
export { EventQueue } from './EventQueue';
export { generateUUID, sha256Hex, now, backoffMs, setDebug, log, warn } from './utils';
export type {
  SdkConfig,
  ResolvedConfig,
  SessionState,
  QueuedBatch
} from './types';
