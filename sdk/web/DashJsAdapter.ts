/**
 * DashJsAdapter — adapter for dash.js (https://github.com/Dash-Industry-Forum/dash.js)
 *
 * Hooks into dash.js MediaPlayer events to capture:
 *  - Quality changes (audio + video)
 *  - Fragment load metrics (CDN analytics per segment)
 *  - Stream initialized (maps to PLAY_REQUEST / FIRST_FRAME context)
 *  - Errors (player, network, DRM)
 *  - Buffer stalls
 *
 * Usage:
 *   const adapter = new DashJsAdapter({ videoElement, dashPlayer, content, sdkConfig });
 *   await adapter.attach();
 */

import type { MediaPlayerClass } from 'dashjs';
import { WebAdapter } from './WebAdapter';
import type { WebAdapterOptions } from './WebAdapter';

export interface DashJsAdapterOptions extends WebAdapterOptions {
  dashPlayer: MediaPlayerClass;
}

export class DashJsAdapter extends WebAdapter {
  private readonly dash: MediaPlayerClass;
  private dashHandlers: Array<{ event: string; fn: (...args: any[]) => void }> = [];

  private prevVideoBitrateKbps = 0;
  private prevVideoResolution = 'unknown';

  constructor(options: DashJsAdapterOptions) {
    super(options);
    this.dash = options.dashPlayer;
  }

  override async attach(): Promise<void> {
    await super.attach();
    this._bindDashEvents();
  }

  override async detach(): Promise<void> {
    this._unbindDashEvents();
    await super.detach();
  }

  protected override _getPlayerInfo() {
    const version = (this.dash as any).getVersion?.() ?? 'unknown';
    return {
      engine: 'dash.js' as const,
      engine_version: version,
      sdk_version: this.options.sdkConfig.sdkVersion
    };
  }

  // ---------------------------------------------------------------------------
  // dash.js event bindings
  // ---------------------------------------------------------------------------

  private _bindDashEvents(): void {
    // Import dashjs only when available (tree-shaking friendly)
    const dashjs = require('dashjs') as typeof import('dashjs');
    const E = dashjs.MediaPlayer.events;

    const on = (event: string, fn: (...args: any[]) => void) => {
      const bound = fn.bind(this);
      this.dash.on(event, bound);
      this.dashHandlers.push({ event, fn: bound });
    };

    on(E.STREAM_INITIALIZED,           this._onStreamInitialized);
    on(E.QUALITY_CHANGE_RENDERED,      this._onQualityChangeRendered);
    on(E.FRAGMENT_LOADING_COMPLETED,   this._onFragmentLoadingCompleted);
    on(E.ERROR,                        this._onDashError);
    on(E.BUFFER_EMPTY,                 this._onBufferEmpty);
    on(E.BUFFER_LOADED,                this._onBufferLoaded);
    on(E.PLAYBACK_STALLED,             this._onPlaybackStalled);
    on(E.MANIFEST_LOADED,              this._onManifestLoaded);
  }

  private _unbindDashEvents(): void {
    for (const { event, fn } of this.dashHandlers) {
      this.dash.off(event, fn);
    }
    this.dashHandlers = [];
  }

  // ---------------------------------------------------------------------------
  // Handler implementations
  // ---------------------------------------------------------------------------

  private _onStreamInitialized(): void {
    this.core.session.onPlayRequest();
  }

  private _onManifestLoaded(_data: any): void {
    // Manifest fetched — nothing to record beyond what onPlayRequest already does
  }

  private _onQualityChangeRendered(_event: string, data: any): void {
    if (data.mediaType !== 'video') return; // skip audio track switches

    const bitrateInfo = this.dash.getBitrateInfoListFor?.('video') ?? [];
    const current = bitrateInfo[data.newQuality];
    const prev = bitrateInfo[data.oldQuality];

    if (!current) return;

    const newBitrateKbps = Math.round((current.bitrate ?? 0) / 1000);
    const newRes = `${current.width ?? 0}x${current.height ?? 0}`;
    const prevBitrateKbps = prev ? Math.round((prev.bitrate ?? 0) / 1000) : this.prevVideoBitrateKbps;
    const prevRes = prev ? `${prev.width ?? 0}x${prev.height ?? 0}` : this.prevVideoResolution;

    this.core.session.onBitrateChange(
      prevBitrateKbps,
      newBitrateKbps,
      prevRes,
      newRes,
      'auto',
      this.video.currentTime,
      current.codec
    );

    this.prevVideoBitrateKbps = newBitrateKbps;
    this.prevVideoResolution = newRes;
  }

  private _onFragmentLoadingCompleted(_event: string, data: any): void {
    const req = data.request;
    const resp = data.response;
    if (!req || !resp) return;

    const bytes = (resp as ArrayBuffer).byteLength ?? 0;
    const durationMs = (req.requestEndDate?.getTime() ?? 0) - (req.requestStartDate?.getTime() ?? 0);
    const ttfbMs = (req.firstByteDate?.getTime() ?? 0) - (req.requestStartDate?.getTime() ?? 0);
    const throughputKbps = durationMs > 0 ? Math.round((bytes * 8) / durationMs) : 0;
    const cdnName = this._extractCdnFromUrl(req.url) ?? this.options.cdnName ?? 'unknown';

    this.core.session.onCdnRequest({
      cdnName,
      requestType: req.type === 'InitializationSegment' ? 'manifest' : 'segment',
      httpStatus: req.response?.status ?? 200,
      ttfbMs,
      durationMs,
      bytes,
      throughputKbps
    });
  }

  private _onDashError(_event: string, data: any): void {
    const errorCode = data.error?.code ?? 'DASH_ERROR';
    const isFatal = data.error?.level === 'fatal';

    const sourceMap: Record<string, string> = {
      download: 'network',
      manifestError: 'network',
      mediasource: 'player',
      key_session: 'drm',
      key_message: 'drm'
    };

    const source = sourceMap[data.error?.group ?? ''] ?? 'player';
    const state = this.core.getSessionState();

    this.core.session.onError(
      String(errorCode),
      data.error?.message ?? 'dash.js error',
      source,
      isFatal,
      { vsfType: !state?.hasFirstFrame ? 'technical' : undefined }
    );
  }

  private _onBufferEmpty(): void {
    this.core.session.onBufferingStart(this.video.currentTime, 'network');
  }

  private _onBufferLoaded(): void {
    // dash.js BufferLoaded = buffer has enough data to play.
    // Actual recovery is signalled by the native `playing` event in the base class.
  }

  private _onPlaybackStalled(): void {
    this.core.session.onBufferingStart(this.video.currentTime, 'network');
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
      return hostname;
    } catch {
      return undefined;
    }
  }
}
