/**
 * SessionManager — owns the playback session lifecycle and all derived metrics.
 *
 * Responsibilities:
 *  - Create / close sessions with unique IDs
 *  - Maintain running metrics: startup time, rebuffering ratio, bitrate average
 *  - Emit heartbeat events on a fixed interval
 *  - Detect "zombie" sessions (client crashed without sending STOP/SESSION_END)
 *    → after (2 × heartbeatInterval) of silence the session is auto-closed
 *
 * The SessionManager does NOT send events itself — it delegates to the EventQueue
 * via the `emit` callback, keeping transport concerns separate.
 */

import type {
  SessionState,
  ResolvedConfig,
  AnalyticsEvent,
  ContentInfo,
  PlayerInfo,
  NetworkInfo,
  DeviceInfo
} from './types';
import type { PlaybackMetrics } from './types';
import type {
  PayloadSessionStart,
  PayloadHeartbeat,
  PayloadSessionEnd,
  EventPayload
} from '../../schema/events';
import { generateUUID, now, log, warn } from './utils';

type EmitFn = (event: AnalyticsEvent) => void;

export class SessionManager {
  private state: SessionState | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private zombieTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly cfg: ResolvedConfig;
  private readonly emit: EmitFn;

  constructor(config: ResolvedConfig, emit: EmitFn) {
    this.cfg = config;
    this.emit = emit;
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  /** Call when the user or autoplay initiates a new video. */
  startSession(
    content: ContentInfo,
    player: PlayerInfo,
    network: NetworkInfo,
    device: DeviceInfo,
    payload: PayloadSessionStart
  ): string {
    if (this.state) {
      warn('startSession called while a session is already active — auto-closing previous session');
      this.endSession('unknown');
    }

    const sessionId = generateUUID();
    this.state = {
      sessionId,
      seq: 0,
      playRequestAt: null,
      firstFrameAt: null,
      startupTimeMs: 0,
      lastActivityAt: now(),
      bufferingStartAt: null,
      bufferingStartCause: null,
      totalBufferingMs: 0,
      bufferingCount: 0,
      currentBitrateKbps: 0,
      currentResolution: 'unknown',
      bitrateChangeCount: 0,
      cdnRequestCount: 0,
      totalCdnThroughputKbps: 0,
      totalCdnTtfbMs: 0,
      pauseStartAt: null,
      playbackPositionS: 0,
      hasFirstFrame: false,
      content,
      player,
      network,
      device,
      playbackMetrics: {}
    };

    this._emitEvent('SESSION_START', payload);
    this._startZombieTimer();
    log(`Session started: ${sessionId}`);
    return sessionId;
  }

  /** Call on play button press / autoplay trigger. */
  onPlayRequest(startPositionS?: number): void {
    if (!this.state) return;
    this.state.playRequestAt = now();
    this._emitEvent('PLAY_REQUEST', { start_position_s: startPositionS });
    this._resetZombieTimer();
  }

  /** Call when the first video frame is rendered on screen. */
  onFirstFrame(): void {
    if (!this.state || this.state.hasFirstFrame) return;

    const startupTimeMs = this.state.playRequestAt
      ? now() - this.state.playRequestAt
      : 0;

    this.state.firstFrameAt = now();
    this.state.hasFirstFrame = true;
    this.state.startupTimeMs = startupTimeMs;
    this._emitEvent('FIRST_FRAME', { startup_time_ms: startupTimeMs });
    this._startHeartbeat();
    this._resetZombieTimer();
    log(`First frame — startup: ${startupTimeMs}ms`);
  }

  /** Call on PAUSE event. */
  onPause(positionS: number): void {
    if (!this.state) return;
    this.state.playbackPositionS = positionS;
    this.state.pauseStartAt = now();
    this._emitEvent('PAUSE', { playback_position_s: positionS });
    this._resetZombieTimer();
  }

  /** Call on RESUME event. */
  onResume(positionS: number): void {
    if (!this.state) return;
    const pauseDurationMs = this.state.pauseStartAt ? now() - this.state.pauseStartAt : 0;
    this.state.pauseStartAt = null;
    this.state.playbackPositionS = positionS;
    this._emitEvent('RESUME', { playback_position_s: positionS, pause_duration_ms: pauseDurationMs });
    this._resetZombieTimer();
  }

  /** Call on seek start (VOD). */
  onSeek(fromPositionS: number, toPositionS: number): void {
    if (!this.state) return;
    this.state.playbackPositionS = toPositionS;
    this._emitEvent('SEEK', { from_position_s: fromPositionS, to_position_s: toPositionS });
    this._resetZombieTimer();
  }

  /** Call when playback stalls (rebuffering). */
  onBufferingStart(positionS: number, cause?: string): void {
    if (!this.state || this.state.bufferingStartAt !== null) return;
    const effectiveCause =
      !this.state.hasFirstFrame && (cause === undefined || cause === 'network')
        ? 'initial'
        : cause ?? 'unknown';
    this.state.bufferingStartAt = now();
    this.state.bufferingStartCause = effectiveCause as SessionState['bufferingStartCause'];
    this._emitEvent('BUFFERING_START', {
      playback_position_s: positionS,
      cause: effectiveCause as any
    });
    this._resetZombieTimer();
  }

  /** Call when playback resumes after a stall. */
  onBufferingEnd(positionS: number): void {
    if (!this.state || this.state.bufferingStartAt === null) return;
    const durationMs = now() - this.state.bufferingStartAt;
    const countsAsRebuffer =
      this.state.bufferingStartCause !== 'initial' &&
      this.state.bufferingStartCause !== 'seek';
    if (countsAsRebuffer) {
      this.state.totalBufferingMs += durationMs;
      this.state.bufferingCount++;
    }
    this.state.bufferingStartAt = null;
    this.state.bufferingStartCause = null;
    this._emitEvent('BUFFERING_END', {
      playback_position_s: positionS,
      buffering_duration_ms: durationMs
    });
    this._resetZombieTimer();
    log(`Buffering ended — duration: ${durationMs}ms, total: ${this.state.totalBufferingMs}ms`);
  }

  /** Call whenever the ABR algorithm or user changes the quality level. */
  onBitrateChange(
    prevBitrateKbps: number,
    newBitrateKbps: number,
    prevResolution: string,
    newResolution: string,
    reason: 'auto' | 'user',
    positionS: number,
    codec?: string
  ): void {
    if (!this.state) return;
    this.state.currentBitrateKbps = newBitrateKbps;
    this.state.currentResolution = newResolution;
    this.state.bitrateChangeCount++;
    this._emitEvent('BITRATE_CHANGE', {
      previous_bitrate_kbps: prevBitrateKbps,
      new_bitrate_kbps: newBitrateKbps,
      previous_resolution: prevResolution,
      new_resolution: newResolution,
      codec,
      reason,
      playback_position_s: positionS
    });
    this._resetZombieTimer();
  }

  /** Call on any player/network/DRM error. */
  onError(
    errorCode: string,
    errorMessage: string,
    source: string,
    fatal: boolean,
    options?: {
      vsfType?: 'technical' | 'business';
      isEbvs?: boolean;
      positionS?: number;
      httpStatus?: number;
    }
  ): void {
    if (!this.state) return;
    this._emitEvent('ERROR', {
      error_code: errorCode,
      error_message: errorMessage,
      source: source as any,
      fatal,
      vsf_type: options?.vsfType,
      is_ebvs: options?.isEbvs,
      playback_position_s: options?.positionS,
      http_status: options?.httpStatus
    });
    this._resetZombieTimer();

    if (fatal) {
      this.endSession('error');
    }
  }

  /** Call for every CDN segment/manifest request (used in multi-CDN instrumented players). */
  onCdnRequest(data: {
    cdnName: string;
    requestType: 'manifest' | 'segment' | 'key';
    httpStatus: number;
    ttfbMs: number;
    durationMs: number;
    bytes: number;
    throughputKbps: number;
    url?: string;
    sequenceNumber?: number;
    mediaType?: 'video' | 'audio' | 'subtitle' | 'muxed';
  }): void {
    if (!this.state) return;
    if (Number.isFinite(data.throughputKbps) && Number.isFinite(data.ttfbMs)) {
      this.state.cdnRequestCount++;
      this.state.totalCdnThroughputKbps += Math.max(0, data.throughputKbps);
      this.state.totalCdnTtfbMs += Math.max(0, data.ttfbMs);
    }
    this._emitEvent('CDN_REQUEST', {
      cdn_name: data.cdnName,
      request_type: data.requestType,
      http_status: data.httpStatus,
      ttfb_ms: data.ttfbMs,
      duration_ms: data.durationMs,
      bytes: data.bytes,
      throughput_kbps: data.throughputKbps,
      url: data.url,
      sequence_number: data.sequenceNumber,
      media_type: data.mediaType
    });
  }

  /** Call when the player fails over to a different CDN. */
  onCdnSwitch(
    cdnFrom: string,
    cdnTo: string,
    reason: 'error' | 'policy' | 'latency' | 'manual' | 'unknown',
    positionS: number,
    triggerHttpStatus?: number
  ): void {
    if (!this.state) return;
    this._emitEvent('CDN_SWITCH', {
      cdn_from: cdnFrom,
      cdn_to: cdnTo,
      reason,
      playback_position_s: positionS,
      trigger_http_status: triggerHttpStatus
    });
  }

  /** Call for live streams to report measured end-to-end latency. */
  onLiveLatency(latencyS: number, positionS: number, targetLatencyS?: number): void {
    if (!this.state) return;
    this._emitEvent('LIVE_LATENCY', {
      latency_s: latencyS,
      playback_position_s: positionS,
      target_latency_s: targetLatencyS
    });
  }

  /** Call for live join time (channel selection → first frame). */
  onJoinTime(joinTimeMs: number): void {
    if (!this.state) return;
    this._emitEvent('JOIN_TIME', { join_time_ms: joinTimeMs });
  }

  /** Call when a manifest refresh fails. */
  onManifestError(httpStatus: number, retryCount: number, fatal: boolean, url?: string): void {
    if (!this.state) return;
    this._emitEvent('MANIFEST_ERROR', { http_status: httpStatus, retry_count: retryCount, fatal, url });
  }

  // ---------------------------------------------------------------------------
  // Ad events
  // ---------------------------------------------------------------------------

  onAdBreakStart(adId: string, position: 'pre' | 'mid' | 'post', durationS: number, adCount: number): void {
    if (!this.state) return;
    this._emitEvent('AD_BREAK_START', { ad_id: adId, position, duration_s: durationS, ad_count: adCount });
  }

  onAdBreakEnd(adId: string, position: 'pre' | 'mid' | 'post', watchedS: number, skipped: boolean): void {
    if (!this.state) return;
    this._emitEvent('AD_BREAK_END', { ad_id: adId, position, watched_s: watchedS, skipped });
  }

  onAdQuartile(adId: string, quartile: 0 | 25 | 50 | 75 | 100, position: 'pre' | 'mid' | 'post'): void {
    if (!this.state) return;
    this._emitEvent('AD_QUARTILE', { ad_id: adId, quartile, position });
  }

  onAdError(errorCode: string, errorMessage: string, fatal: boolean, adId?: string): void {
    if (!this.state) return;
    this._emitEvent('AD_ERROR', { ad_id: adId, error_code: errorCode, error_message: errorMessage, fatal });
  }

  // ---------------------------------------------------------------------------
  // Session close
  // ---------------------------------------------------------------------------

  /** Call on explicit user stop, content completion, or fatal error. */
  endSession(reason: 'completed' | 'user_stop' | 'error' | 'unknown'): void {
    if (!this.state) return;

    this._stopHeartbeat();
    this._cancelZombieTimer();

    // Close any open buffering interval
    if (this.state.bufferingStartAt !== null) {
      this.onBufferingEnd(this.state.playbackPositionS);
    }

    const watchTimeS = this.state.firstFrameAt
      ? (now() - this.state.firstFrameAt) / 1000
      : 0;

    const completionPct = (this.state.content.type === 'vod' && this.state.content.duration_s)
      ? Math.min(100, (this.state.playbackPositionS / this.state.content.duration_s) * 100)
      : null;

    const sessionEndPayload: PayloadSessionEnd = {
      watch_time_s: watchTimeS,
      completion_pct: completionPct,
      reason,
      rebuffer_count: this.state.bufferingCount,
      rebuffer_time_s: this.state.totalBufferingMs / 1000,
      bitrate_change_count: this.state.bitrateChangeCount,
      startup_time_ms: this.state.startupTimeMs,
      avg_throughput_kbps: this.state.cdnRequestCount > 0
        ? this.state.totalCdnThroughputKbps / this.state.cdnRequestCount
        : 0,
      avg_ttfb_ms: this.state.cdnRequestCount > 0
        ? this.state.totalCdnTtfbMs / this.state.cdnRequestCount
        : 0
    };

    this._emitEvent('SESSION_END', sessionEndPayload);
    log(`Session ended: ${this.state.sessionId} (reason: ${reason}, watch: ${watchTimeS.toFixed(1)}s)`);
    this.state = null;
  }

  /** Returns current session state (read-only snapshot), or null if no active session. */
  getState(): Readonly<SessionState> | null {
    return this.state;
  }

  // ---------------------------------------------------------------------------
  // Heartbeat
  // ---------------------------------------------------------------------------

  private _startHeartbeat(): void {
    if (this.cfg.heartbeatIntervalMs === 0 || this.heartbeatTimer !== null) return;

    this.heartbeatTimer = setInterval(() => {
      this._emitHeartbeat();
    }, this.cfg.heartbeatIntervalMs);
  }

  private _stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private _emitHeartbeat(): void {
    if (!this.state) return;
    const payload: PayloadHeartbeat = {
      playback_position_s: this.state.playbackPositionS,
      current_bitrate_kbps: this.state.currentBitrateKbps,
      current_resolution: this.state.currentResolution,
      is_buffering: this.state.bufferingStartAt !== null,
      rebuffer_time_ms: this.state.totalBufferingMs,
      buffer_length_s: this.state.playbackMetrics.bufferLengthS,
      bandwidth_estimate_kbps: this.state.playbackMetrics.bandwidthEstimateKbps,
      decoded_video_frames: this.state.playbackMetrics.decodedVideoFrames,
      dropped_video_frames: this.state.playbackMetrics.droppedVideoFrames,
      playback_rate: this.state.playbackMetrics.playbackRate,
      live_latency_s: this.state.playbackMetrics.liveLatencyS
    };
    this._emitEvent('HEARTBEAT', payload);
    this.state.lastActivityAt = now();
  }

  /** Called by the adapter to update the playback position for heartbeats. */
  updatePlaybackPosition(positionS: number, bitrateKbps?: number, resolution?: string): void {
    if (!this.state) return;
    this.state.playbackPositionS = positionS;
    if (bitrateKbps !== undefined) this.state.currentBitrateKbps = bitrateKbps;
    if (resolution !== undefined) this.state.currentResolution = resolution;
    this.state.lastActivityAt = now();
  }

  /** Update optional playback-quality signals used by heartbeat snapshots. */
  updatePlaybackMetrics(metrics: PlaybackMetrics): void {
    if (!this.state) return;
    const current = this.state.playbackMetrics;
    const finite = (value: unknown): value is number =>
      typeof value === 'number' && Number.isFinite(value);
    if (finite(metrics.bufferLengthS)) current.bufferLengthS = metrics.bufferLengthS;
    if (finite(metrics.bandwidthEstimateKbps)) current.bandwidthEstimateKbps = metrics.bandwidthEstimateKbps;
    if (finite(metrics.decodedVideoFrames)) current.decodedVideoFrames = metrics.decodedVideoFrames;
    if (finite(metrics.droppedVideoFrames)) current.droppedVideoFrames = metrics.droppedVideoFrames;
    if (finite(metrics.playbackRate)) current.playbackRate = metrics.playbackRate;
    if (finite(metrics.liveLatencyS)) current.liveLatencyS = metrics.liveLatencyS;
    this.state.lastActivityAt = now();
  }

  // ---------------------------------------------------------------------------
  // Zombie session detection
  // ---------------------------------------------------------------------------

  /** Starts the zombie watchdog — fires if no activity for 2× heartbeat interval. */
  private _startZombieTimer(): void {
    this._cancelZombieTimer();
    const timeout = this.cfg.heartbeatIntervalMs * 2 + 5_000;
    this.zombieTimer = setTimeout(() => {
      warn('Zombie session detected — auto-closing');
      this.endSession('unknown');
    }, timeout);
  }

  private _resetZombieTimer(): void {
    this._startZombieTimer();
  }

  private _cancelZombieTimer(): void {
    if (this.zombieTimer !== null) {
      clearTimeout(this.zombieTimer);
      this.zombieTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal emit helper — builds the full envelope and delegates to emit()
  // ---------------------------------------------------------------------------

  private _emitEvent(eventType: string, payload: object): void {
    if (!this.state) return;

    this.state.seq++;

    const event: AnalyticsEvent = {
      session_id: this.state.sessionId,
      viewer_id: this.cfg.viewerId,
      event_type: eventType as any,
      timestamp: now(),
      platform: this.cfg.platform,
      content: this.state.content,
      player: this.state.player,
      network: this.state.network,
      device: this.state.device,
      seq: this.state.seq,
      payload: payload as any
    } as AnalyticsEvent;

    this.emit(event);
  }
}
