/**
 * Video QoE & CDN Analytics — Shared Event Schema
 * 
 * This file is the single source of truth for all event types across
 * Web, iOS, Android, and Smart TV platforms.
 * 
 * Design principles:
 *  - One common "envelope" for every event: backend never needs platform-specific parsing
 *  - Geo/ISP are intentionally absent from the client schema — enriched server-side via IP
 *  - No PII in any field; user_id must be hashed (SHA-256) before being set
 *  - `payload` is a discriminated union keyed on `event_type`
 */

// ---------------------------------------------------------------------------
// Primitives & enumerations
// ---------------------------------------------------------------------------

export type Platform =
  | 'web'
  | 'ios'
  | 'android'
  | 'tvos'
  | 'androidtv'
  | 'tizen'
  | 'webos'
  | 'roku'
  | 'unknown';

export type ContentType = 'live' | 'vod';

export type ConnectionType = 'wifi' | 'cellular' | 'ethernet' | 'unknown';

export type PlayerEngine =
  | 'hls.js'
  | 'dash.js'
  | 'shaka'
  | 'exoplayer'
  | 'media3'
  | 'avplayer'
  | 'native'
  | 'unknown';

export type ErrorSource = 'player' | 'network' | 'drm' | 'cdn' | 'unknown';

export type SessionEndReason = 'completed' | 'user_stop' | 'error' | 'unknown';

export type AdPosition = 'pre' | 'mid' | 'post';

export type AdQuartile = 0 | 25 | 50 | 75 | 100;

// ---------------------------------------------------------------------------
// All possible event types
// ---------------------------------------------------------------------------

export type EventType =
  // Session lifecycle
  | 'SESSION_START'
  | 'PLAY_REQUEST'
  | 'FIRST_FRAME'
  | 'PAUSE'
  | 'RESUME'
  | 'SEEK'
  | 'STOP'
  | 'SESSION_END'
  | 'HEARTBEAT'
  // Buffering
  | 'BUFFERING_START'
  | 'BUFFERING_END'
  // Bitrate / ABR
  | 'BITRATE_CHANGE'
  // Errors
  | 'ERROR'
  // CDN
  | 'CDN_REQUEST'
  | 'CDN_SWITCH'
  // Live-specific
  | 'JOIN_TIME'
  | 'LIVE_LATENCY'
  | 'MANIFEST_ERROR'
  // Ads
  | 'AD_BREAK_START'
  | 'AD_BREAK_END'
  | 'AD_QUARTILE'
  | 'AD_ERROR';

// ---------------------------------------------------------------------------
// Envelope sub-objects
// ---------------------------------------------------------------------------

export interface ContentInfo {
  /** Unique identifier for the asset (e.g. CMS ID, stream key) */
  content_id: string;
  type: ContentType;
  title: string;
  /** Total duration in seconds. null for live streams */
  duration_s: number | null;
  /** Optional: channel / show identifier */
  series_id?: string;
}

export interface PlayerInfo {
  engine: PlayerEngine;
  engine_version: string;
  /** Version of this analytics SDK */
  sdk_version: string;
  /** Autoplay was triggered without explicit user gesture */
  autoplay?: boolean;
}

export interface NetworkInfo {
  connection_type: ConnectionType;
  /** CDN name as identified by the client (e.g. "akamai", "cloudfront", "fastly") */
  cdn?: string;
  /** Effective bandwidth estimate in kbps, if available */
  bandwidth_kbps?: number;
}

export interface DeviceInfo {
  os: string;
  os_version: string;
  /** Device model string, e.g. "iPhone 15", "Samsung QN90" */
  model: string;
  /** Screen resolution, e.g. "1920x1080" */
  screen_resolution?: string;
  /** Viewport / player size, e.g. "1280x720" */
  player_resolution?: string;
}

// ---------------------------------------------------------------------------
// Per-event payload types (discriminated by event_type)
// ---------------------------------------------------------------------------

export interface PayloadSessionStart {
  /** SHA-256 hash of internal user ID. Never send raw user ID. */
  user_id_hash?: string;
  /** Originating page URL (web) or deeplink (mobile). Strip any PII from the URL. */
  page_url?: string;
  /** Was the session initiated by autoplay? */
  autoplay: boolean;
}

export interface PayloadPlayRequest {
  /** Playback position at which play was requested (for resume from position) */
  start_position_s?: number;
}

export interface PayloadFirstFrame {
  /**
   * Startup time in milliseconds.
   * SDK MUST compute this as: FIRST_FRAME.timestamp − PLAY_REQUEST.timestamp
   */
  startup_time_ms: number;
}

export interface PayloadPause {
  playback_position_s: number;
}

export interface PayloadResume {
  playback_position_s: number;
  /** How long the player was paused, in ms */
  pause_duration_ms: number;
}

export interface PayloadSeek {
  from_position_s: number;
  to_position_s: number;
}

export interface PayloadStop {
  playback_position_s: number;
  reason: SessionEndReason;
}

export interface PayloadSessionEnd {
  /** Total watch time for this session, in seconds */
  watch_time_s: number;
  /** Percentage of content watched (0-100). null for live. */
  completion_pct: number | null;
  reason: SessionEndReason;
  /** Total number of rebuffering events */
  rebuffer_count: number;
  /** Total seconds spent rebuffering */
  rebuffer_time_s: number;
  /** Total number of bitrate changes */
  bitrate_change_count: number;
}

export interface PayloadHeartbeat {
  /** Current playback position in seconds */
  playback_position_s: number;
  /** Current playing bitrate in kbps */
  current_bitrate_kbps: number;
  /** Current rendered resolution, e.g. "1280x720" */
  current_resolution: string;
  /** Is the player currently in a buffering state? */
  is_buffering: boolean;
  /** Cumulative rebuffering time so far in this session, in ms */
  rebuffer_time_ms: number;
  /** For live: current end-to-end latency in seconds */
  live_latency_s?: number;
}

export interface PayloadBufferingStart {
  playback_position_s: number;
  /** Best-effort cause: initial load, seek, bitrate switch, or unknown */
  cause?: 'initial' | 'seek' | 'bitrate_switch' | 'network' | 'unknown';
}

export interface PayloadBufferingEnd {
  playback_position_s: number;
  /** How long buffering lasted in ms */
  buffering_duration_ms: number;
}

export interface PayloadBitrateChange {
  previous_bitrate_kbps: number;
  new_bitrate_kbps: number;
  previous_resolution: string;
  new_resolution: string;
  codec?: string;
  /** Was this change triggered by the ABR algorithm (auto) or by the user? */
  reason: 'auto' | 'user';
  playback_position_s: number;
}

export interface PayloadError {
  error_code: string;
  error_message: string;
  source: ErrorSource;
  /** If true, playback cannot continue */
  fatal: boolean;
  /**
   * VIDEO_START_FAILURE: error occurred before first frame was rendered.
   * Distinguish: 'technical' = player/network error, 'business' = geo-block / DRM / entitlement
   */
  vsf_type?: 'technical' | 'business';
  /**
   * EXIT_BEFORE_VIDEO_START: user abandoned before first frame.
   * Set this flag instead of error_code for clean exits during loading.
   */
  is_ebvs?: boolean;
  playback_position_s?: number;
  /** Raw HTTP status code if applicable */
  http_status?: number;
}

export interface PayloadCdnRequest {
  cdn_name: string;
  /** 'manifest' or 'segment' or 'key' (DRM) */
  request_type: 'manifest' | 'segment' | 'key';
  /** Full URL of the request. Strip tokens/query params if sensitive. */
  url?: string;
  http_status: number;
  /** Time to first byte in ms */
  ttfb_ms: number;
  /** Total request duration in ms */
  duration_ms: number;
  /** Downloaded bytes */
  bytes: number;
  /** Estimated throughput for this request in kbps */
  throughput_kbps: number;
  /** Segment sequence number, if available */
  sequence_number?: number;
}

export interface PayloadCdnSwitch {
  cdn_from: string;
  cdn_to: string;
  /** Why the switch happened */
  reason: 'error' | 'policy' | 'latency' | 'manual' | 'unknown';
  /** HTTP error that triggered the switch, if applicable */
  trigger_http_status?: number;
  playback_position_s: number;
}

export interface PayloadJoinTime {
  /** For live: time from channel selection to first frame, in ms */
  join_time_ms: number;
}

export interface PayloadLiveLatency {
  /** Current edge-to-player latency in seconds */
  latency_s: number;
  /** Target latency configured in the player (LL-HLS/DASH) */
  target_latency_s?: number;
  playback_position_s: number;
}

export interface PayloadManifestError {
  http_status: number;
  url?: string;
  /** How many consecutive failures before giving up */
  retry_count: number;
  fatal: boolean;
}

export interface PayloadAdBreakStart {
  ad_id: string;
  position: AdPosition;
  /** Scheduled duration in seconds */
  duration_s: number;
  /** Number of ads in this break */
  ad_count: number;
}

export interface PayloadAdBreakEnd {
  ad_id: string;
  position: AdPosition;
  /** Actual watched duration in seconds */
  watched_s: number;
  skipped: boolean;
}

export interface PayloadAdQuartile {
  ad_id: string;
  quartile: AdQuartile;
  position: AdPosition;
}

export interface PayloadAdError {
  ad_id?: string;
  error_code: string;
  error_message: string;
  fatal: boolean;
}

// ---------------------------------------------------------------------------
// Discriminated union: EventPayload
// ---------------------------------------------------------------------------

export type EventPayload =
  | { event_type: 'SESSION_START';    payload: PayloadSessionStart }
  | { event_type: 'PLAY_REQUEST';     payload: PayloadPlayRequest }
  | { event_type: 'FIRST_FRAME';      payload: PayloadFirstFrame }
  | { event_type: 'PAUSE';            payload: PayloadPause }
  | { event_type: 'RESUME';           payload: PayloadResume }
  | { event_type: 'SEEK';             payload: PayloadSeek }
  | { event_type: 'STOP';             payload: PayloadStop }
  | { event_type: 'SESSION_END';      payload: PayloadSessionEnd }
  | { event_type: 'HEARTBEAT';        payload: PayloadHeartbeat }
  | { event_type: 'BUFFERING_START';  payload: PayloadBufferingStart }
  | { event_type: 'BUFFERING_END';    payload: PayloadBufferingEnd }
  | { event_type: 'BITRATE_CHANGE';   payload: PayloadBitrateChange }
  | { event_type: 'ERROR';            payload: PayloadError }
  | { event_type: 'CDN_REQUEST';      payload: PayloadCdnRequest }
  | { event_type: 'CDN_SWITCH';       payload: PayloadCdnSwitch }
  | { event_type: 'JOIN_TIME';        payload: PayloadJoinTime }
  | { event_type: 'LIVE_LATENCY';     payload: PayloadLiveLatency }
  | { event_type: 'MANIFEST_ERROR';   payload: PayloadManifestError }
  | { event_type: 'AD_BREAK_START';   payload: PayloadAdBreakStart }
  | { event_type: 'AD_BREAK_END';     payload: PayloadAdBreakEnd }
  | { event_type: 'AD_QUARTILE';      payload: PayloadAdQuartile }
  | { event_type: 'AD_ERROR';         payload: PayloadAdError };

// ---------------------------------------------------------------------------
// The envelope — every event sent to the collector is wrapped in this
// ---------------------------------------------------------------------------

export type AnalyticsEvent = {
  /** UUID v4 identifying the playback session. Generated by the SDK on SESSION_START. */
  session_id: string;
  /** Monotonic epoch milliseconds from the client clock. */
  timestamp: number;
  platform: Platform;
  content: ContentInfo;
  player: PlayerInfo;
  network: NetworkInfo;
  device: DeviceInfo;
  /**
   * Sequence number within the session — lets the backend detect dropped/out-of-order events.
   * Starts at 1 for SESSION_START, increments by 1 per event.
   */
  seq: number;
} & EventPayload;

// ---------------------------------------------------------------------------
// Batch payload — the SDK sends arrays of events in a single HTTP call
// ---------------------------------------------------------------------------

export interface EventBatch {
  /** SDK version — top-level for quick routing before full parse */
  sdk_version: string;
  /** Epoch ms when this batch was assembled */
  sent_at: number;
  events: AnalyticsEvent[];
}
