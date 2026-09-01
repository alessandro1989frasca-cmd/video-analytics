/**
 * TizenAdapter — Samsung Tizen Smart TV
 *
 * Tizen supports two player surfaces:
 *
 * 1. AVPlay (webapis.avplay) — the native Tizen media player exposed to web apps.
 *    Event model is callback-based (setListener), not EventTarget.
 *    Bitrate info comes from getStreamingProperty('CURRENT_BANDWIDTH').
 *
 * 2. HTML5 <video> in a WebView (Samsung Tizen 5+)
 *    If the app uses a WebView player (hls.js / Shaka inside Tizen Browser),
 *    the standard WebAdapter / HlsJsAdapter from sdk/web/ work directly.
 *    Just set platform: 'tizen' in the SdkConfig.
 *
 * This file covers path 1: AVPlay.
 *
 * Tizen firmware versions targeted: 3.0+ (2017+), 6.x+ recommended.
 * All APIs are available under the global `webapis` namespace (injected by Tizen).
 */

import { AnalyticsCore } from '../core/AnalyticsCore';
import type { SdkConfig } from '../core/types';
import type { ContentInfo, NetworkInfo, DeviceInfo } from '../../schema/events';

// Minimal type stubs for the Tizen AVPlay API (not in @types/tizen-common-web)
declare namespace webapis {
    namespace avplay {
        function open(url: string): void;
        function setDisplayRect(x: number, y: number, w: number, h: number): void;
        function prepareAsync(successCb: () => void, errorCb: (e: any) => void): void;
        function play(): void;
        function pause(): void;
        function stop(): void;
        function seekTo(ms: number, successCb?: () => void, errorCb?: (e: any) => void): void;
        function setListener(listener: AVPlayListener): void;
        function getStreamingProperty(property: string): string;
        function getCurrentTime(): number;   // ms
        function getDuration(): number;      // ms
        function getState(): string;         // 'NONE'|'IDLE'|'READY'|'PLAYING'|'PAUSED'
    }
    namespace productinfo {
        function getModel(): string;
        function getFirmwareVersion(): string;
    }
}

interface AVPlayListener {
    onbufferingstart(): void;
    onbufferingprogress(percent: number): void;
    onbufferingcomplete(): void;
    oncurrentplaytime(currentTime: number): void;
    onbufferfull?(): void;
    onevent?(eventType: string, eventData: string): void;
    onerror?(errorType: string): void;
    onstreamcompleted(): void;
    ondrmevent?(drmEvent: string, drmData: string): void;
}

export interface TizenAdapterOptions {
    streamUrl: string;
    content: ContentInfo;
    cdnOverride?: string;
    sdkConfig: Omit<SdkConfig, 'platform'>;
}

export class TizenAdapter {
    private readonly core: AnalyticsCore;
    private readonly options: TizenAdapterOptions;
    private prevBitrateKbps = 0;
    private isSeeking = false;
    private seekFromMs = 0;
    /** Polled every 5s to detect bitrate changes via getStreamingProperty */
    private bitratePoller: ReturnType<typeof setInterval> | null = null;

    constructor(options: TizenAdapterOptions) {
        this.options = options;
        this.core = new AnalyticsCore({
            ...options.sdkConfig,
            platform: 'tizen'
        });
    }

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    async attach(): Promise<void> {
        this.core.startSession(
            this.options.content,
            {
                engine: 'native',
                engine_version: this._firmwareVersion(),
                sdk_version: this.options.sdkConfig.sdkVersion
            },
            this._getNetworkInfo(),
            this._getDeviceInfo()
        );

        webapis.avplay.open(this.options.streamUrl);
        webapis.avplay.setDisplayRect(0, 0, 1920, 1080);
        webapis.avplay.setListener(this._buildListener());

        await new Promise<void>((resolve, reject) =>
            webapis.avplay.prepareAsync(resolve, reject)
        );

        this.core.session.onPlayRequest();
        webapis.avplay.play();

        this._startBitratePoller();
    }

    detach(): void {
        this._stopBitratePoller();
        try { webapis.avplay.stop(); } catch { /* ignore if already stopped */ }
        this.core.endSession('user_stop');
        this.core.destroy();
    }

    // -------------------------------------------------------------------------
    // AVPlay listener
    // -------------------------------------------------------------------------

    private _buildListener(): AVPlayListener {
        return {
            onbufferingstart: () => {
                const posS = webapis.avplay.getCurrentTime() / 1000;
                this.core.session.onBufferingStart(posS, 'network');
            },

            onbufferingprogress: (_percent: number) => { /* no-op */ },

            onbufferingcomplete: () => {
                const posS = webapis.avplay.getCurrentTime() / 1000;

                if (!this.core.getSessionState()?.hasFirstFrame) {
                    this.core.session.onFirstFrame();
                }
                this.core.session.onBufferingEnd(posS);
            },

            oncurrentplaytime: (currentTimeMs: number) => {
                const posS = currentTimeMs / 1000;
                this.core.session.updatePlaybackPosition(posS);
            },

            onstreamcompleted: () => {
                this.core.endSession('completed');
            },

            onerror: (errorType: string) => {
                const state = this.core.getSessionState();
                this.core.session.onError(
                    `AVPLAY_${errorType}`,
                    `AVPlay error: ${errorType}`,
                    'player',
                    true,
                    { vsfType: !state?.hasFirstFrame ? 'technical' : undefined }
                );
            },

            onevent: (eventType: string, eventData: string) => {
                if (eventType === 'PLAYER_MSG_BITRATE_INFO') {
                    // eventData format: "video={kbps}kbps audio={kbps}kbps"
                    this._handleBitrateEvent(eventData);
                }
                if (eventType === 'PLAYER_MSG_FRAGMENT_INFO') {
                    this._handleFragmentEvent(eventData);
                }
            },

            ondrmevent: (_drmEvent: string, _drmData: string) => {
                this.core.session.onError('DRM_EVENT', 'DRM event received', 'drm', false);
            }
        };
    }

    // -------------------------------------------------------------------------
    // Bitrate polling (fallback for firmware that doesn't fire PLAYER_MSG_BITRATE_INFO)
    // -------------------------------------------------------------------------

    private _startBitratePoller(): void {
        this.bitratePoller = setInterval(() => {
            try {
                const raw = webapis.avplay.getStreamingProperty('CURRENT_BANDWIDTH');
                // raw = "1500000" (bps)
                const bps = parseInt(raw, 10);
                if (!isNaN(bps)) {
                    const kbps = bps / 1000;
                    if (Math.abs(kbps - this.prevBitrateKbps) > 100) {
                        const posS = webapis.avplay.getCurrentTime() / 1000;
                        this.core.session.onBitrateChange(
                            this.prevBitrateKbps, kbps,
                            'unknown', 'unknown',
                            'auto', posS
                        );
                        this.prevBitrateKbps = kbps;
                    }
                }
            } catch { /* getStreamingProperty may throw on some firmware */ }
        }, 5_000);
    }

    private _stopBitratePoller(): void {
        if (this.bitratePoller !== null) {
            clearInterval(this.bitratePoller);
            this.bitratePoller = null;
        }
    }

    // -------------------------------------------------------------------------
    // Event data parsers
    // -------------------------------------------------------------------------

    private _handleBitrateEvent(data: string): void {
        // "video=2500kbps audio=128kbps"
        const match = data.match(/video=(\d+)kbps/);
        if (!match) return;
        const newKbps = parseInt(match[1], 10);
        if (Math.abs(newKbps - this.prevBitrateKbps) > 50) {
            const posS = webapis.avplay.getCurrentTime() / 1000;
            this.core.session.onBitrateChange(
                this.prevBitrateKbps, newKbps,
                'unknown', 'unknown', 'auto', posS
            );
            this.prevBitrateKbps = newKbps;
        }
    }

    private _handleFragmentEvent(data: string): void {
        // "url={url} downloadTime={ms} fileSize={bytes}"
        try {
            const urlMatch = data.match(/url=([^\s]+)/);
            const timeMatch = data.match(/downloadTime=(\d+)/);
            const sizeMatch = data.match(/fileSize=(\d+)/);
            if (!urlMatch || !timeMatch || !sizeMatch) return;

            const url = urlMatch[1];
            const durationMs = parseInt(timeMatch[1], 10);
            const bytes = parseInt(sizeMatch[1], 10);
            const throughputKbps = durationMs > 0 ? (bytes * 8) / durationMs : 0;
            const cdnName = this.options.cdnOverride ?? this._guessCdn(url) ?? 'unknown';

            this.core.session.onCdnRequest({
                cdnName, requestType: 'segment',
                httpStatus: 200, ttfbMs: 0,
                durationMs, bytes, throughputKbps
            });
        } catch { /* parse failure — ignore */ }
    }

    // -------------------------------------------------------------------------
    // Metadata helpers
    // -------------------------------------------------------------------------

    private _getNetworkInfo(): NetworkInfo {
        return {
            connection_type: 'ethernet',   // Smart TVs are almost always wired
            cdn: this.options.cdnOverride
        };
    }

    private _getDeviceInfo(): DeviceInfo {
        const model = (() => {
            try { return webapis.productinfo.getModel(); } catch { return 'Tizen TV'; }
        })();
        return {
            os: 'tizen',
            os_version: this._firmwareVersion(),
            model,
            screen_resolution: '1920x1080'
        };
    }

    private _firmwareVersion(): string {
        try { return webapis.productinfo.getFirmwareVersion(); } catch { return 'unknown'; }
    }

    private _guessCdn(url: string): string | undefined {
        try {
            const host = new URL(url).hostname.toLowerCase();
            if (host.includes('msvdn')) return 'mainstreaming';
            if (host.includes('netrw')) return 'raiway';
            if (host.includes('akamai') || host.includes('akamaized')) return 'akamai';
            if (host.includes('cloudfront')) return 'cloudfront';
            if (host.includes('fastly'))     return 'fastly';
            return host;
        } catch { return undefined; }
    }
}
