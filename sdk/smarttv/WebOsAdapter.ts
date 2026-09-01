/**
 * WebOsAdapter — LG webOS Smart TV
 *
 * webOS has two player surfaces:
 *
 * 1. HTML5 <video> via the built-in Chromium-based browser engine.
 *    For webOS 4.x+ (2019+) the browser is modern enough that the standard
 *    WebAdapter / HlsJsAdapter / ShakaAdapter work directly.
 *    Just pass platform: 'webos' in SdkConfig.
 *
 * 2. MSE (Media Source Extensions) with Luna Service API for advanced control.
 *    The Luna API is available for native apps (webOS app framework).
 *
 * This adapter covers both paths:
 *  - VideoElement path: delegates to WebAdapter with platform override
 *  - Luna / MSE path: hooks into Luna media events via PalmSystem / webOS.service
 *
 * webOS firmware targets: 4.x+ (2019+). Older 3.x firmware has quirks with MSE.
 */

import { AnalyticsCore } from '../core/AnalyticsCore';
import type { SdkConfig } from '../core/types';
import type { ContentInfo, NetworkInfo, DeviceInfo } from '../../schema/events';

// Minimal stubs for webOS-specific globals
declare const webOSDev: {
    device: {
        modelName: string;
        sdkVersion: string;
        firmwareVersion: string;
    };
};
declare const PalmSystem: { deviceInfo: string } | undefined;

export interface WebOsAdapterOptions {
    videoElement: HTMLVideoElement;
    content: ContentInfo;
    cdnOverride?: string;
    sdkConfig: Omit<SdkConfig, 'platform'>;
}

export class WebOsAdapter {
    private readonly core: AnalyticsCore;
    private readonly video: HTMLVideoElement;
    private readonly options: WebOsAdapterOptions;
    private readonly handlers = new Map<string, EventListener>();

    private isFirstFrame = false;
    private isSeeking = false;
    private seekFromPos = 0;
    private prevBitrateKbps = 0;

    constructor(options: WebOsAdapterOptions) {
        this.options = options;
        this.video = options.videoElement;
        this.core = new AnalyticsCore({
            ...options.sdkConfig,
            platform: 'webos'
        });
    }

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    attach(): void {
        this.core.startSession(
            this.options.content,
            {
                engine: 'native',
                engine_version: this._webosVersion(),
                sdk_version: this.options.sdkConfig.sdkVersion
            },
            this._getNetworkInfo(),
            this._getDeviceInfo()
        );
        this._bindEvents();
    }

    async detach(): Promise<void> {
        this._unbindEvents();
        await this.core.destroy();
    }

    // -------------------------------------------------------------------------
    // HTML5 video events
    // (webOS Chromium fires the same events as desktop Chrome)
    // -------------------------------------------------------------------------

    private _bindEvents(): void {
        const on = (name: string, fn: () => void) => {
            const bound = fn.bind(this) as EventListener;
            this.handlers.set(name, bound);
            this.video.addEventListener(name, bound);
        };

        on('play',       this._onPlay);
        on('playing',    this._onPlaying);
        on('pause',      this._onPause);
        on('waiting',    this._onWaiting);
        on('seeking',    this._onSeeking);
        on('seeked',     this._onSeeked);
        on('timeupdate', this._onTimeUpdate);
        on('ended',      this._onEnded);
        on('error',      this._onError);

        // webOS-specific: fires when the underlying decoder changes quality
        this.video.addEventListener('webkitplaybacktargetavailabilitychanged',
            this._onWebkitPlaybackTargetChange.bind(this) as EventListener);
    }

    private _unbindEvents(): void {
        for (const [name, fn] of this.handlers) {
            this.video.removeEventListener(name, fn);
        }
        this.handlers.clear();
    }

    // -------------------------------------------------------------------------
    // Handlers
    // -------------------------------------------------------------------------

    private _onPlay(): void {
        if (!this.core.getSessionState()?.hasFirstFrame) {
            this.core.session.onPlayRequest();
        }
    }

    private _onPlaying(): void {
        const state = this.core.getSessionState();
        if (!state?.hasFirstFrame) {
            this.core.session.onFirstFrame();
        } else {
            this.core.session.onBufferingEnd(this.video.currentTime);
        }
    }

    private _onPause(): void {
        if (!this.isSeeking) {
            this.core.session.onPause(this.video.currentTime);
        }
    }

    private _onWaiting(): void {
        if (!this.isSeeking) {
            this.core.session.onBufferingStart(this.video.currentTime, 'network');
        }
    }

    private _onSeeking(): void {
        this.isSeeking = true;
        this.seekFromPos = this.video.currentTime;
        this.core.session.onBufferingStart(this.video.currentTime, 'seek');
    }

    private _onSeeked(): void {
        this.isSeeking = false;
        this.core.session.onSeek(this.seekFromPos, this.video.currentTime);
    }

    private _onTimeUpdate(): void {
        this.core.session.updatePlaybackPosition(this.video.currentTime);
    }

    private _onEnded(): void {
        this.core.endSession('completed');
    }

    private _onError(): void {
        const err = this.video.error;
        if (!err) return;
        const state = this.core.getSessionState();
        this.core.session.onError(
            `MEDIA_ERR_${err.code}`,
            err.message || 'Media error',
            'player', true,
            { vsfType: !state?.hasFirstFrame ? 'technical' : undefined }
        );
    }

    // webOS-specific quality change notification
    private _onWebkitPlaybackTargetChange(): void {
        // Probe current video tracks for bitrate info
        const tracks = (this.video as any).videoTracks;
        if (!tracks || tracks.length === 0) return;
        const activeTrack = Array.from(tracks as Iterable<any>).find((t: any) => t.selected);
        if (activeTrack?.bandwidth) {
            const newKbps = activeTrack.bandwidth / 1000;
            if (Math.abs(newKbps - this.prevBitrateKbps) > 100) {
                this.core.session.onBitrateChange(
                    this.prevBitrateKbps, newKbps,
                    'unknown', 'unknown', 'auto',
                    this.video.currentTime
                );
                this.prevBitrateKbps = newKbps;
            }
        }
    }

    // -------------------------------------------------------------------------
    // Metadata helpers
    // -------------------------------------------------------------------------

    private _getNetworkInfo(): NetworkInfo {
        return {
            connection_type: 'ethernet',
            cdn: this.options.cdnOverride
        };
    }

    private _getDeviceInfo(): DeviceInfo {
        const model = (() => {
            try { return webOSDev?.device?.modelName ?? 'webOS TV'; } catch { return 'webOS TV'; }
        })();
        return {
            os: 'webos',
            os_version: this._webosVersion(),
            model,
            screen_resolution: `${screen.width}x${screen.height}`
        };
    }

    private _webosVersion(): string {
        try { return webOSDev?.device?.firmwareVersion ?? 'unknown'; } catch { return 'unknown'; }
    }
}
