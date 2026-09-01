/**
 * WebAdapter — base adapter for HTML5 <video> element events.
 *
 * This class hooks into the native HTMLVideoElement event API and translates
 * each event into the corresponding SessionManager call.
 *
 * Engine-specific adapters (HlsJsAdapter, DashJsAdapter, ShakaAdapter) extend
 * this class and override / augment only what they need.
 *
 * Design constraints:
 *  - Zero impact on playback: all handlers are async fire-and-forget
 *  - No polling: uses native events only (except position tracking in heartbeat,
 *    which is driven by SessionManager's own timer)
 *  - Cleans up all event listeners on destroy()
 */

import { AnalyticsCore } from '../core/AnalyticsCore';
import type { SdkConfig } from '../core/types';
import type { ContentInfo, NetworkInfo, DeviceInfo } from '../../schema/events';

export interface WebAdapterOptions {
  /** The HTMLVideoElement being tracked */
  videoElement: HTMLVideoElement;
  /** Content metadata */
  content: ContentInfo;
  /**
   * Optional: override CDN name. If omitted the adapter will attempt to
   * detect it from the manifest URL hostname.
   */
  cdnName?: string;
  /** User ID — will be SHA-256 hashed before being sent */
  userId?: string;
  /** Analytics SDK configuration */
  sdkConfig: Omit<SdkConfig, 'platform'>;
}

export class WebAdapter {
  protected readonly core: AnalyticsCore;
  protected readonly video: HTMLVideoElement;
  protected readonly options: WebAdapterOptions;

  /** epoch ms of the most recent PLAY_REQUEST — used to compute startup time */
  private playRequestAt = 0;
  /** whether we're currently in a seeking state */
  private isSeeking = false;
  private seekFromPosition = 0;
  /** last known playback position — for heartbeat position updates */
  private lastPosition = 0;

  // Map of event name → bound handler, so we can removeEventListener cleanly
  private readonly handlers = new Map<string, EventListener>();

  constructor(options: WebAdapterOptions) {
    this.options = options;
    this.video = options.videoElement;

    this.core = new AnalyticsCore({
      ...options.sdkConfig,
      platform: 'web'
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Attach all event listeners and start a session.
   * Call this after the player is ready but before play() is called.
   */
  async attach(): Promise<void> {
    const network = this._getNetworkInfo();
    const device = this._getDeviceInfo();

    let userIdHash: string | undefined;
    if (this.options.userId) {
      const { sha256Hex } = await import('../core/utils');
      userIdHash = await sha256Hex(this.options.userId);
    }

    this.core.startSession(
      this.options.content,
      this._getPlayerInfo(),
      network,
      device,
      {
        autoplay: this.video.autoplay,
        userIdHash,
        pageUrl: this._sanitiseUrl(window.location.href)
      }
    );

    this._bindEvents();
  }

  /** Remove all listeners and tear down the core. */
  async detach(): Promise<void> {
    this._unbindEvents();
    await this.core.destroy();
  }

  // ---------------------------------------------------------------------------
  // Native <video> event handlers
  // ---------------------------------------------------------------------------

  private _bindEvents(): void {
    const on = (name: string, fn: () => void) => {
      const bound = fn.bind(this) as EventListener;
      this.handlers.set(name, bound);
      this.video.addEventListener(name, bound);
    };

    on('play',           this._onPlay);
    on('playing',        this._onPlaying);
    on('pause',          this._onPause);
    on('seeking',        this._onSeeking);
    on('seeked',         this._onSeeked);
    on('waiting',        this._onWaiting);
    on('stalled',        this._onStalled);
    on('timeupdate',     this._onTimeUpdate);
    on('ended',          this._onEnded);
    on('error',          this._onError);
    on('ratechange',     this._onRateChange);
  }

  private _unbindEvents(): void {
    for (const [name, fn] of this.handlers) {
      this.video.removeEventListener(name, fn);
    }
    this.handlers.clear();
  }

  // ---------------------------------------------------------------------------
  // Event handler implementations
  // ---------------------------------------------------------------------------

  protected _onPlay(): void {
    // `play` fires on the initial play() call AND after every un-pause.
    // We only want PLAY_REQUEST for the initial load (before first frame).
    if (!this.core.getSessionState()?.hasFirstFrame) {
      this.playRequestAt = Date.now();
      this.core.session.onPlayRequest(this.video.currentTime || undefined);
    }
  }

  protected _onPlaying(): void {
    const state = this.core.getSessionState();
    if (!state) return;

    if (!state.hasFirstFrame) {
      // First `playing` event = first frame rendered
      this.core.session.onFirstFrame();
    } else {
      // Recover from a buffering stall
      this.core.session.onBufferingEnd(this.video.currentTime);
    }
  }

  protected _onPause(): void {
    if (this.isSeeking) return; // seeking triggers pause+seeking — ignore the pause
    this.core.session.onPause(this.video.currentTime);
  }

  protected _onSeeking(): void {
    this.isSeeking = true;
    this.seekFromPosition = this.lastPosition;
    // A seek also causes a buffering stall; track it
    this.core.session.onBufferingStart(this.video.currentTime, 'seek');
  }

  protected _onSeeked(): void {
    if (!this.isSeeking) return;
    this.isSeeking = false;
    this.core.session.onSeek(this.seekFromPosition, this.video.currentTime);
    // Buffering will end when `playing` fires
  }

  protected _onWaiting(): void {
    if (!this.isSeeking) {
      this.core.session.onBufferingStart(this.video.currentTime, 'network');
    }
  }

  protected _onStalled(): void {
    // `stalled` means the browser hasn't received data for ~3s
    if (!this.isSeeking) {
      this.core.session.onBufferingStart(this.video.currentTime, 'network');
    }
  }

  protected _onTimeUpdate(): void {
    const pos = this.video.currentTime;
    this.lastPosition = pos;
    this.core.session.updatePlaybackPosition(pos);
  }

  protected _onEnded(): void {
    this.core.session.onBufferingEnd(this.video.currentTime);
    this.core.endSession('completed');
  }

  protected _onError(): void {
    const err = this.video.error;
    if (!err) return;

    const errorMap: Record<number, string> = {
      1: 'MEDIA_ERR_ABORTED',
      2: 'MEDIA_ERR_NETWORK',
      3: 'MEDIA_ERR_DECODE',
      4: 'MEDIA_ERR_SRC_NOT_SUPPORTED'
    };

    const state = this.core.getSessionState();
    const isVsf = !state?.hasFirstFrame;

    this.core.session.onError(
      errorMap[err.code] ?? `MEDIA_ERR_${err.code}`,
      err.message ?? 'Unknown media error',
      'player',
      true,
      { vsfType: isVsf ? 'technical' : undefined }
    );
  }

  protected _onRateChange(): void {
    // Playback rate change doesn't map to an analytics event but we log it for debugging
  }

  // ---------------------------------------------------------------------------
  // Helper: derive metadata from the browser environment
  // ---------------------------------------------------------------------------

  protected _getNetworkInfo(): NetworkInfo {
    let connectionType: NetworkInfo['connection_type'] = 'unknown';

    if ('connection' in navigator) {
      const conn = (navigator as any).connection;
      if (conn) {
        if (conn.type === 'wifi') connectionType = 'wifi';
        else if (conn.type === 'cellular') connectionType = 'cellular';
        else if (conn.type === 'ethernet') connectionType = 'ethernet';
      }
    }

    const cdn = this.options.cdnName ?? this._guessCdnFromVideoSrc();

    return { connection_type: connectionType, cdn };
  }

  protected _getDeviceInfo(): DeviceInfo {
    const ua = navigator.userAgent;
    return {
      os: this._detectOS(ua),
      os_version: this._detectOsVersion(ua),
      model: 'browser',
      screen_resolution: `${screen.width}x${screen.height}`,
      player_resolution: `${this.video.videoWidth}x${this.video.videoHeight}`
    };
  }

  protected _getPlayerInfo() {
    return {
      engine: 'native' as const,
      engine_version: 'html5',
      sdk_version: this.options.sdkConfig.sdkVersion
    };
  }

  /** Best-effort CDN detection from the video src hostname. */
  private _guessCdnFromVideoSrc(): string | undefined {
    try {
      const src = this.video.src || this.video.currentSrc;
      if (!src) return undefined;
      const hostname = new URL(src).hostname.toLowerCase();
      if (hostname.includes('akamai') || hostname.includes('akamaized')) return 'akamai';
      if (hostname.includes('cloudfront')) return 'cloudfront';
      if (hostname.includes('fastly')) return 'fastly';
      if (hostname.includes('cloudflare')) return 'cloudflare';
      if (hostname.includes('cdn77')) return 'cdn77';
      if (hostname.includes('limelight') || hostname.includes('llnwd')) return 'limelight';
      return hostname; // fallback: use the hostname itself
    } catch {
      return undefined;
    }
  }

  /** Strip query params and hashes that might contain tokens / PII. */
  private _sanitiseUrl(url: string): string {
    try {
      const u = new URL(url);
      return `${u.origin}${u.pathname}`;
    } catch {
      return url.split('?')[0];
    }
  }

  private _detectOS(ua: string): string {
    if (/Windows/i.test(ua)) return 'windows';
    if (/Mac OS X/i.test(ua)) return 'macos';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
    if (/Android/i.test(ua)) return 'android';
    if (/Linux/i.test(ua)) return 'linux';
    return 'unknown';
  }

  private _detectOsVersion(ua: string): string {
    const patterns = [
      /Windows NT ([\d.]+)/,
      /Mac OS X ([\d_]+)/,
      /Android ([\d.]+)/,
      /OS ([\d_]+) like Mac OS/  // iOS
    ];
    for (const p of patterns) {
      const m = ua.match(p);
      if (m) return m[1].replace(/_/g, '.');
    }
    return 'unknown';
  }
}
