/**
 * HlsJsAdapter — adapter for hls.js (https://github.com/video-dev/hls.js)
 *
 * Extends WebAdapter and hooks into hls.js-specific events that give us
 * richer data than the native <video> element alone:
 *  - Level switches (actual bitrate/resolution from the manifest)
 *  - Fragment load stats (CDN throughput, TTFB, bytes — per-segment CDN analytics)
 *  - Manifest parsing errors
 *  - Buffer stall events with cause
 *
 * Usage:
 *   const adapter = new HlsJsAdapter({ videoElement, hlsInstance, content, sdkConfig });
 *   await adapter.attach();
 *   // ... player runs ...
 *   await adapter.detach();
 */

import Hls from 'hls.js';
import { WebAdapter } from './WebAdapter';
import type { WebAdapterOptions } from './WebAdapter';

export interface HlsJsAdapterOptions extends WebAdapterOptions {
  hlsInstance: Hls;
}

export class HlsJsAdapter extends WebAdapter {
  private readonly hls: Hls;
  private hlsHandlers: Array<{ event: string; fn: (...args: any[]) => void }> = [];

  /** Track the current level index to detect direction of bitrate switches */
  private currentLevelIndex = -1;

  constructor(options: HlsJsAdapterOptions) {
    super(options);
    this.hls = options.hlsInstance;
  }

  // ---------------------------------------------------------------------------
  // Override attach / detach to add hls.js event hooks
  // ---------------------------------------------------------------------------

  override async attach(): Promise<void> {
    await super.attach();
    this._bindHlsEvents();
  }

  override async detach(): Promise<void> {
    this._unbindHlsEvents();
    await super.detach();
  }

  // ---------------------------------------------------------------------------
  // Override player info to reflect hls.js engine
  // ---------------------------------------------------------------------------

  protected override _getPlayerInfo() {
    return {
      engine: 'hls.js' as const,
      engine_version: Hls.version,
      sdk_version: this.options.sdkConfig.sdkVersion
    };
  }

  // ---------------------------------------------------------------------------
  // hls.js event bindings
  // ---------------------------------------------------------------------------

  private _bindHlsEvents(): void {
    const on = (event: string, fn: (...args: any[]) => void) => {
      const bound = fn.bind(this);
      this.hls.on(event as any, bound);
      this.hlsHandlers.push({ event, fn: bound });
    };

    // Level / bitrate switch
    on(Hls.Events.LEVEL_SWITCHED,          this._onLevelSwitched);
    on(Hls.Events.LEVEL_SWITCHING,         this._onLevelSwitching);

    // Fragment loaded — per-segment CDN analytics
    on(Hls.Events.FRAG_LOADED,             this._onFragLoaded);

    // Manifest loaded / parsed
    on(Hls.Events.MANIFEST_PARSED,         this._onManifestParsed);
    on(Hls.Events.ERROR,                   this._onHlsError);

    // Buffer events — override native waiting/stalled with hls.js specifics
    on(Hls.Events.BUFFER_STALLED_DATA,     this._onBufferStalled);
    on(Hls.Events.BUFFER_FLUSHED,          this._onBufferFlushed);

    // Media attaching → marks play request
    on(Hls.Events.MEDIA_ATTACHING,         this._onMediaAttaching);
  }

  private _unbindHlsEvents(): void {
    for (const { event, fn } of this.hlsHandlers) {
      this.hls.off(event as any, fn);
    }
    this.hlsHandlers = [];
  }

  // ---------------------------------------------------------------------------
  // Handler implementations
  // ---------------------------------------------------------------------------

  private _onMediaAttaching(): void {
    // The player is about to bind to the video element — good proxy for play intent
    this.core.session.onPlayRequest();
  }

  private _onManifestParsed(_event: string, data: any): void {
    // After the manifest is parsed we have the full level list.
    // Record the initial level bitrate in the network info if possible.
    const startLevel = data.levels?.[data.firstLevel];
    if (startLevel) {
      this.core.session.updatePlaybackPosition(
        0,
        Math.round(startLevel.bitrate / 1000), // bps → kbps
        `${startLevel.width}x${startLevel.height}`
      );
    }
  }

  private _onLevelSwitching(_event: string, data: { level: number }): void {
    // `LEVEL_SWITCHING` fires before the switch happens — we only track SWITCHED
    this.currentLevelIndex = data.level;
  }

  private _onLevelSwitched(_event: string, data: { level: number }): void {
    const levels = this.hls.levels;
    if (!levels || levels.length === 0) return;

    const newLevel = levels[data.level];
    const oldLevel = this.currentLevelIndex >= 0 ? levels[this.currentLevelIndex] : null;

    if (!newLevel) return;

    const newBitrate = Math.round(newLevel.bitrate / 1000);
    const newRes = `${newLevel.width}x${newLevel.height}`;
    const prevBitrate = oldLevel ? Math.round(oldLevel.bitrate / 1000) : 0;
    const prevRes = oldLevel ? `${oldLevel.width}x${oldLevel.height}` : 'unknown';

    this.core.session.onBitrateChange(
      prevBitrate,
      newBitrate,
      prevRes,
      newRes,
      'auto',
      this.video.currentTime,
      newLevel.attrs?.CODECS
    );
  }

  private _onFragLoaded(_event: string, data: any): void {
    const stats = data.frag?.stats;
    if (!stats) return;

    const bytes = stats.total ?? 0;
    const durationMs = (stats.loading.end - stats.loading.start) ?? 0;
    const ttfbMs = (stats.loading.first - stats.loading.start) ?? 0;
    const throughputKbps = durationMs > 0 ? Math.round((bytes * 8) / durationMs) : 0;

    // Derive CDN name from the fragment URL
    const cdnName = this._extractCdnFromUrl(data.frag?.url) ?? this.options.cdnName ?? 'unknown';

    this.core.session.onCdnRequest({
      cdnName,
      requestType: 'segment',
      httpStatus: data.networkDetails?.status ?? 200,
      ttfbMs,
      durationMs,
      bytes,
      throughputKbps,
      sequenceNumber: data.frag?.sn
    });
  }

  private _onHlsError(_event: string, data: any): void {
    if (!data.fatal && data.type !== Hls.ErrorTypes.NETWORK_ERROR) return;

    const errorCode = data.details ?? 'HLS_ERROR';
    const source = data.type === Hls.ErrorTypes.NETWORK_ERROR ? 'network'
                 : data.type === Hls.ErrorTypes.MEDIA_ERROR   ? 'player'
                 : 'player';

    // Manifest errors get their own event type
    if (
      errorCode === Hls.ErrorDetails.MANIFEST_LOAD_ERROR ||
      errorCode === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT ||
      errorCode === Hls.ErrorDetails.MANIFEST_PARSING_ERROR
    ) {
      const httpStatus = data.response?.code ?? 0;
      this.core.session.onManifestError(httpStatus, 0, data.fatal, data.url);
      return;
    }

    const state = this.core.getSessionState();
    this.core.session.onError(
      errorCode,
      data.reason ?? errorCode,
      source,
      data.fatal,
      {
        vsfType: !state?.hasFirstFrame ? 'technical' : undefined,
        httpStatus: data.response?.code
      }
    );
  }

  private _onBufferStalled(): void {
    this.core.session.onBufferingStart(this.video.currentTime, 'network');
  }

  private _onBufferFlushed(): void {
    // Buffer flush often precedes a level switch; don't close buffering here —
    // the `playing` event from the base class handles that.
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private _extractCdnFromUrl(url?: string): string | undefined {
    if (!url) return undefined;
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      if (hostname.includes('akamai') || hostname.includes('akamaized')) return 'akamai';
      if (hostname.includes('cloudfront'))  return 'cloudfront';
      if (hostname.includes('fastly'))      return 'fastly';
      if (hostname.includes('cloudflare'))  return 'cloudflare';
      if (hostname.includes('cdn77'))       return 'cdn77';
      if (hostname.includes('limelight') || hostname.includes('llnwd')) return 'limelight';
      return hostname;
    } catch {
      return undefined;
    }
  }
}
