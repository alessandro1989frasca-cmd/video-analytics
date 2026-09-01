/**
 * AnalyticsCore — the single public entry point for all platform adapters.
 *
 * Adapters (Web, iOS bridge, Android bridge, SmartTV) should:
 *   1. Instantiate AnalyticsCore with a ResolvedConfig
 *   2. Call core.session.* methods in response to native player events
 *   3. Call core.destroy() on player teardown / app background
 *
 * This class wires together EventQueue + SessionManager and exposes a clean API
 * without leaking internal details to adapters.
 */

import type { SdkConfig, ResolvedConfig, SessionState } from './types';
import type { ContentInfo, PlayerInfo, NetworkInfo, DeviceInfo } from '../../schema/events';
import { EventQueue } from './EventQueue';
import { SessionManager } from './SessionManager';
import { setDebug, log } from './utils';

// ---------------------------------------------------------------------------
// Default configuration values
// ---------------------------------------------------------------------------

const DEFAULTS = {
  batchSize: 20,
  flushIntervalMs: 10_000,
  heartbeatIntervalMs: 15_000,
  maxRetries: 3,
  retryBaseDelayMs: 1_000,
  maxQueueSize: 1_000,
  debug: false
} as const;

export class AnalyticsCore {
  private readonly queue: EventQueue;
  readonly session: SessionManager;
  private readonly cfg: ResolvedConfig;

  constructor(config: SdkConfig) {
    this.cfg = {
      ...DEFAULTS,
      ...config
    } as ResolvedConfig;

    setDebug(this.cfg.debug);
    log('AnalyticsCore initialised', { collectorUrl: this.cfg.collectorUrl, platform: this.cfg.platform });

    this.queue = new EventQueue(this.cfg);
    this.session = new SessionManager(this.cfg, event => this.queue.enqueue(event));

    // Register page-unload handler for web environments
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', this._onPageHide, { capture: true });
      // visibilitychange covers tab-switch / mobile browser background
      document.addEventListener('visibilitychange', this._onVisibilityChange);
    }
  }

  // ---------------------------------------------------------------------------
  // Convenience helpers that delegate to SessionManager
  // Adapters can call these directly without holding a reference to session.
  // ---------------------------------------------------------------------------

  startSession(
    content: ContentInfo,
    player: PlayerInfo,
    network: NetworkInfo,
    device: DeviceInfo,
    options?: { autoplay?: boolean; userIdHash?: string; pageUrl?: string }
  ): string {
    return this.session.startSession(content, player, network, device, {
      autoplay: options?.autoplay ?? false,
      user_id_hash: options?.userIdHash,
      page_url: options?.pageUrl
    });
  }

  endSession(reason: 'completed' | 'user_stop' | 'error' | 'unknown' = 'unknown'): void {
    this.session.endSession(reason);
  }

  getSessionState(): Readonly<SessionState> | null {
    return this.session.getState();
  }

  /** Force an immediate flush — useful before app goes to background. */
  async flush(): Promise<void> {
    await this.queue.destroy();
  }

  /** Tear down all timers, flush remaining events. */
  async destroy(): Promise<void> {
    this.session.endSession('unknown');

    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this._onPageHide, { capture: true });
      document.removeEventListener('visibilitychange', this._onVisibilityChange);
    }

    await this.queue.destroy();
    log('AnalyticsCore destroyed');
  }

  // ---------------------------------------------------------------------------
  // Page lifecycle handlers (web)
  // ---------------------------------------------------------------------------

  private readonly _onPageHide = (): void => {
    log('pagehide — flushing via beacon');
    this.session.endSession('user_stop');
    this.queue.flushSync();
  };

  private readonly _onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      log('visibilitychange hidden — flushing via beacon');
      this.queue.flushSync();
    }
  };
}
