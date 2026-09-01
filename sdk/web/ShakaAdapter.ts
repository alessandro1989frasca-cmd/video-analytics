/**
 * ShakaAdapter — adapter for Shaka Player (https://github.com/shaka-project/shaka-player)
 *
 * Shaka exposes a rich event set and a detailed stats API.
 * Key hooks:
 *  - 'adaptation'   → ABR quality switch
 *  - 'buffering'    → unified buffering state change (start + end in one event)
 *  - 'error'        → shaka.util.Error with code, category, severity
 *  - Network request/response filters → per-segment CDN analytics
 *  - 'streaming'    → stream initialised (play request context)
 *
 * Usage:
 *   const adapter = new ShakaAdapter({ videoElement, shakaPlayer, content, sdkConfig });
 *   await adapter.attach();
 */

import type * as ShakaTypes from 'shaka-player';
import { WebAdapter } from './WebAdapter';
import type { WebAdapterOptions } from './WebAdapter';

// Shaka is a global (`shaka`) in non-module environments; import type-only here.
declare const shaka: typeof ShakaTypes;

export interface ShakaAdapterOptions extends WebAdapterOptions {
  shakaPlayer: ShakaTypes.Player;
}

export class ShakaAdapter extends WebAdapter {
  private readonly player: ShakaTypes.Player;
  private shakaHandlers: Array<{ event: string; fn: (...args: any[]) => void }> = [];
  /** Track the time each segment request started (keyed by request ID / URL) */
  private segmentRequestStart = new Map<string, number>();

  private prevBitrateKbps = 0;
  private prevResolution = 'unknown';

  constructor(options: ShakaAdapterOptions) {
    super(options);
    this.player = options.shakaPlayer;
  }

  override async attach(): Promise<void> {
    await super.attach();
    this._bindShakaEvents();
    this._registerNetworkFilters();
  }

  override async detach(): Promise<void> {
    this._unbindShakaEvents();
    // Note: Shaka doesn't have a public API to remove network filters after the fact.
    // The player instance should be destroyed after detach() anyway.
    await super.detach();
  }

  protected override _getPlayerInfo() {
    return {
      engine: 'shaka' as const,
      engine_version: shaka?.Player?.version ?? 'unknown',
      sdk_version: this.options.sdkConfig.sdkVersion
    };
  }

  // ---------------------------------------------------------------------------
  // Shaka event bindings
  // ---------------------------------------------------------------------------

  private _bindShakaEvents(): void {
    const on = (event: string, fn: (...args: any[]) => void) => {
      const bound = fn.bind(this);
      this.player.addEventListener(event, bound);
      this.shakaHandlers.push({ event, fn: bound });
    };

    on('adaptation',   this._onAdaptation);
    on('buffering',    this._onBuffering);
    on('error',        this._onShakaError);
    on('streaming',    this._onStreaming);
    on('loaded',       this._onLoaded);
  }

  private _unbindShakaEvents(): void {
    for (const { event, fn } of this.shakaHandlers) {
      this.player.removeEventListener(event, fn);
    }
    this.shakaHandlers = [];
  }

  // ---------------------------------------------------------------------------
  // Network filters — per-segment CDN analytics
  // ---------------------------------------------------------------------------

  private _registerNetworkFilters(): void {
    const nm = this.player.getNetworkingEngine();
    if (!nm) return;

    nm.registerRequestFilter((_type: number, request: any) => {
      // Tag request with start time using URL as key
      const url = request.uris?.[0] ?? '';
      this.segmentRequestStart.set(url, Date.now());
    });

    nm.registerResponseFilter((type: number, response: any) => {
      const url = response.uri ?? '';
      const startMs = this.segmentRequestStart.get(url) ?? Date.now();
      this.segmentRequestStart.delete(url);

      const durationMs = Date.now() - startMs;
      const bytes = response.data?.byteLength ?? 0;
      const throughputKbps = durationMs > 0 ? Math.round((bytes * 8) / durationMs) : 0;
      const cdnName = this._extractCdnFromUrl(url) ?? this.options.cdnName ?? 'unknown';

      // shaka.net.NetworkingEngine.RequestType: MANIFEST=0, SEGMENT=1, LICENSE=2, ...
      const requestType = type === 0 ? 'manifest' : type === 2 ? 'key' : 'segment';

      this.core.session.onCdnRequest({
        cdnName,
        requestType,
        httpStatus: response.status ?? 200,
        ttfbMs: 0, // Shaka response filter doesn't expose TTFB; 0 is acceptable
        durationMs,
        bytes,
        throughputKbps,
        url: this._truncateUrl(url)
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Handler implementations
  // ---------------------------------------------------------------------------

  private _onStreaming(): void {
    this.core.session.onPlayRequest();
  }

  private _onLoaded(): void {
    // Shaka `loaded` fires when the manifest is parsed and the stream is ready.
    // First frame is still handled by the base class `playing` event.
  }

  private _onAdaptation(event: any): void {
    // `adaptation` fires when the active track changes.
    // We can get the new track from player.getVariantTracks()
    const tracks = this.player.getVariantTracks?.() ?? [];
    const active = tracks.find((t: any) => t.active);
    if (!active) return;

    const newBitrateKbps = Math.round((active.bandwidth ?? 0) / 1000);
    const newRes = active.height ? `${active.width ?? 0}x${active.height}` : 'unknown';

    this.core.session.onBitrateChange(
      this.prevBitrateKbps,
      newBitrateKbps,
      this.prevResolution,
      newRes,
      'auto',
      this.video.currentTime,
      active.videoCodec
    );

    this.prevBitrateKbps = newBitrateKbps;
    this.prevResolution = newRes;
  }

  private _onBuffering(event: any): void {
    // Shaka's `buffering` event carries { buffering: boolean }
    const isBuffering: boolean = (event as any).buffering ?? false;
    if (isBuffering) {
      this.core.session.onBufferingStart(this.video.currentTime, 'network');
    } else {
      this.core.session.onBufferingEnd(this.video.currentTime);
    }
  }

  private _onShakaError(event: any): void {
    const err = event.detail as ShakaTypes.util.Error;
    if (!err) return;

    // shaka.util.Error.Category: NETWORK=1, TEXT=2, MEDIA=3, MANIFEST=4, DRM=6, PLAYER=7, ...
    const categoryMap: Record<number, string> = {
      1: 'network',
      3: 'player',
      4: 'network',  // manifest fetch errors
      6: 'drm',
      7: 'player'
    };

    const source = categoryMap[err.category] ?? 'player';
    const fatal = err.severity === (shaka?.util?.Error?.Severity?.CRITICAL ?? 2);
    const state = this.core.getSessionState();

    // Category 4 = MANIFEST errors
    if (err.category === 4) {
      this.core.session.onManifestError(
        (err.data?.[1] as number) ?? 0,
        0,
        fatal
      );
      return;
    }

    this.core.session.onError(
      `SHAKA_${err.category}_${err.code}`,
      `Shaka error category=${err.category} code=${err.code}`,
      source,
      fatal,
      { vsfType: !state?.hasFirstFrame ? 'technical' : undefined }
    );
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private _extractCdnFromUrl(url: string): string | undefined {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      if (hostname.includes('msvdn')) return 'mainstreaming';
      if (hostname.includes('netrw')) return 'raiway';
      if (hostname.includes('akamai') || hostname.includes('akamaized')) return 'akamai';
      if (hostname.includes('cloudfront'))  return 'cloudfront';
      if (hostname.includes('fastly'))      return 'fastly';
      if (hostname.includes('cloudflare'))  return 'cloudflare';
      return hostname;
    } catch {
      return undefined;
    }
  }

  /** Truncate URL to remove query params that may carry auth tokens */
  private _truncateUrl(url: string): string {
    try {
      const u = new URL(url);
      return `${u.origin}${u.pathname}`;
    } catch {
      return url.split('?')[0];
    }
  }
}
