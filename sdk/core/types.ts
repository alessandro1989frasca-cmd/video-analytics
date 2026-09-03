/**
 * Internal types used only within the SDK core.
 * Public-facing types come from schema/events.ts.
 */

import type { AnalyticsEvent, EventBatch, EventType, Platform, ContentInfo, PlayerInfo, NetworkInfo, DeviceInfo } from '../../schema/events';

export type { ContentInfo, PlayerInfo, NetworkInfo, DeviceInfo } from '../../schema/events';

export type { AnalyticsEvent, EventBatch };

// ---------------------------------------------------------------------------
// SDK configuration
// ---------------------------------------------------------------------------

export interface SdkConfig {
  /** The collector endpoint URL */
  collectorUrl: string;
  /** SDK version string — injected at build time */
  sdkVersion: string;
  /** Platform identifier — set by each adapter */
  platform: Platform;
  /**
   * How many events to accumulate before flushing.
   * The SDK also flushes on a timer regardless of this threshold.
   * Default: 20
   */
  batchSize?: number;
  /**
   * Maximum ms to wait before flushing a non-empty queue.
   * Default: 10_000 (10s)
   */
  flushIntervalMs?: number;
  /**
   * Heartbeat interval in ms. 0 to disable.
   * Default: 15_000 (15s)
   */
  heartbeatIntervalMs?: number;
  /**
   * How many times to retry a failed batch before dropping it.
   * Default: 3
   */
  maxRetries?: number;
  /**
   * Base delay for exponential back-off in ms.
   * Default: 1_000
   */
  retryBaseDelayMs?: number;
  /**
   * Maximum number of events to keep in the in-memory queue.
   * Events beyond this limit are dropped (oldest first).
   * Default: 1_000
   */
  maxQueueSize?: number;
  /**
   * Enable verbose console output for debugging.
   * Must be false / absent in production builds.
   * Default: false
   */
  debug?: boolean;
  /**
   * Called when a batch fails permanently (after all retries).
   * Use to surface errors in monitoring or to persist events locally.
   */
  onDroppedBatch?: (batch: EventBatch, reason: string) => void;
}

export type ResolvedConfig = Required<Omit<SdkConfig, 'onDroppedBatch'>> & {
  onDroppedBatch?: SdkConfig['onDroppedBatch'];
};

export interface PlaybackMetrics {
  bufferLengthS?: number;
  bandwidthEstimateKbps?: number;
  decodedVideoFrames?: number;
  droppedVideoFrames?: number;
  playbackRate?: number;
  liveLatencyS?: number;
}

// ---------------------------------------------------------------------------
// Session state — tracked in memory during a playback session
// ---------------------------------------------------------------------------

export interface SessionState {
  sessionId: string;
  seq: number;
  /** epoch ms when PLAY_REQUEST was fired */
  playRequestAt: number | null;
  /** epoch ms when FIRST_FRAME was fired */
  firstFrameAt: number | null;
  /** play request to first-frame duration */
  startupTimeMs: number;
  /** epoch ms of most recent HEARTBEAT or playback event */
  lastActivityAt: number;
  /** epoch ms when the current buffering event started */
  bufferingStartAt: number | null;
  /** Cause associated with the current buffering interval */
  bufferingStartCause: 'initial' | 'seek' | 'bitrate_switch' | 'network' | 'unknown' | null;
  /** accumulated buffering ms in this session */
  totalBufferingMs: number;
  /** number of buffering events so far */
  bufferingCount: number;
  /** current playing bitrate kbps */
  currentBitrateKbps: number;
  /** current resolution string */
  currentResolution: string;
  /** number of bitrate changes so far */
  bitrateChangeCount: number;
  cdnRequestCount: number;
  totalCdnThroughputKbps: number;
  totalCdnTtfbMs: number;
  /** epoch ms when the current pause started */
  pauseStartAt: number | null;
  /** current playback position in seconds (updated via heartbeat) */
  playbackPositionS: number;
  /** whether FIRST_FRAME has been received */
  hasFirstFrame: boolean;
  /** content info for this session */
  content: ContentInfo;
  /** player info for this session */
  player: PlayerInfo;
  /** network info for this session */
  network: NetworkInfo;
  /** device info for this session */
  device: DeviceInfo;
  playbackMetrics: PlaybackMetrics;
}

// ---------------------------------------------------------------------------
// Queued batch — wraps a batch while in the retry queue
// ---------------------------------------------------------------------------

export interface QueuedBatch {
  batch: EventBatch;
  retries: number;
  nextRetryAt: number;
}
