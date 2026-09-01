/**
 * Web SDK — integration examples (not shipped in production bundle).
 *
 * Shows how to attach each adapter to a player.
 * Import only the adapter you need — tree-shaking removes the others.
 */

import Hls from 'hls.js';
import { HlsJsAdapter } from './HlsJsAdapter';
import { DashJsAdapter } from './DashJsAdapter';
import { ShakaAdapter }  from './ShakaAdapter';

const SDK_CONFIG = {
  collectorUrl: 'https://analytics.yourcompany.com/v1/collect',
  sdkVersion: '1.0.0',
  debug: false                        // set true during development
} as const;

// ---------------------------------------------------------------------------
// Example 1: hls.js
// ---------------------------------------------------------------------------

async function setupHlsPlayer(videoEl: HTMLVideoElement, streamUrl: string): Promise<void> {
  const hls = new Hls();
  hls.loadSource(streamUrl);
  hls.attachMedia(videoEl);

  const adapter = new HlsJsAdapter({
    videoElement: videoEl,
    hlsInstance: hls,
    content: {
      content_id: 'live-rai1',
      type: 'live',
      title: 'RAI 1',
      duration_s: null
    },
    sdkConfig: SDK_CONFIG
  });

  await adapter.attach();

  // On page/SPA navigation, clean up
  window.addEventListener('beforeunload', () => adapter.detach(), { once: true });
}

// ---------------------------------------------------------------------------
// Example 2: dash.js
// ---------------------------------------------------------------------------

async function setupDashPlayer(videoEl: HTMLVideoElement, mpdUrl: string): Promise<void> {
  const dashjs = await import('dashjs');
  const dash = dashjs.MediaPlayer().create();
  dash.initialize(videoEl, mpdUrl, true);

  const adapter = new DashJsAdapter({
    videoElement: videoEl,
    dashPlayer: dash,
    content: {
      content_id: 'vod-123',
      type: 'vod',
      title: 'Il Commissario Montalbano — S01E01',
      duration_s: 5400
    },
    sdkConfig: SDK_CONFIG,
    userId: 'user@example.com'        // will be SHA-256 hashed, never sent in clear
  });

  await adapter.attach();

  videoEl.addEventListener('ended', () => adapter.detach(), { once: true });
}

// ---------------------------------------------------------------------------
// Example 3: Shaka Player
// ---------------------------------------------------------------------------

async function setupShakaPlayer(videoEl: HTMLVideoElement, manifestUrl: string): Promise<void> {
  // @ts-ignore – global shaka loaded via CDN or bundled separately
  const player = new shaka.Player(videoEl);
  await player.load(manifestUrl);

  const adapter = new ShakaAdapter({
    videoElement: videoEl,
    shakaPlayer: player,
    content: {
      content_id: 'vod-456',
      type: 'vod',
      title: 'Festival di Sanremo 2026',
      duration_s: 10800
    },
    sdkConfig: SDK_CONFIG
  });

  await adapter.attach();
}
