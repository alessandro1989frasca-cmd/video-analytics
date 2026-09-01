/**
 * EventQueue — in-memory ring buffer with async flush and retry logic.
 *
 * Responsibilities:
 *  - Accumulate events and flush when batchSize threshold is hit or flushInterval fires
 *  - Manage a retry queue with exponential back-off for failed HTTP sends
 *  - Use navigator.sendBeacon for the final flush on page unload (web)
 *  - Never block the calling thread; every operation returns void / Promise<void>
 */

import type { AnalyticsEvent, EventBatch, QueuedBatch, ResolvedConfig } from './types';
import { now, backoffMs, log, warn } from './utils';

export class EventQueue {
  private pendingEvents: AnalyticsEvent[] = [];
  private retryQueue: QueuedBatch[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private isFlushing = false;
  private readonly cfg: ResolvedConfig;

  constructor(config: ResolvedConfig) {
    this.cfg = config;
    this._scheduleFlush();
    this._scheduleRetryCheck();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Enqueue a single event. Triggers a flush if batchSize is reached. */
  enqueue(event: AnalyticsEvent): void {
    if (this.pendingEvents.length >= this.cfg.maxQueueSize) {
      // Drop oldest to make room — prevents unbounded memory growth on long offline periods
      this.pendingEvents.shift();
      warn('Queue full — oldest event dropped');
    }
    this.pendingEvents.push(event);
    log(`Enqueued ${event.event_type} (queue size: ${this.pendingEvents.length})`);

    if (this.pendingEvents.length >= this.cfg.batchSize) {
      this._flush('threshold');
    }
  }

  /**
   * Final flush — must be called on page unload / app background.
   * Uses sendBeacon when available to guarantee delivery even during page tear-down.
   */
  flushSync(): void {
    if (this.pendingEvents.length === 0) return;
    const batch = this._buildBatch(this.pendingEvents.splice(0));
    this._sendBeaconOrFetch(batch);
  }

  /** Graceful shutdown — flush everything and cancel timers. */
  async destroy(): Promise<void> {
    this._cancelTimers();
    await this._flush('destroy');
  }

  // ---------------------------------------------------------------------------
  // Flush logic
  // ---------------------------------------------------------------------------

  private async _flush(reason: string): Promise<void> {
    if (this.isFlushing || this.pendingEvents.length === 0) {
      this._scheduleFlush(); // reschedule even if nothing to send
      return;
    }

    this.isFlushing = true;
    const events = this.pendingEvents.splice(0); // drain the queue atomically
    const batch = this._buildBatch(events);

    log(`Flushing ${events.length} events (reason: ${reason})`);

    try {
      await this._send(batch);
    } catch (err) {
      warn('Flush failed, scheduling retry', err);
      this._enqueueRetry(batch);
    } finally {
      this.isFlushing = false;
      this._scheduleFlush();
    }
  }

  private _buildBatch(events: AnalyticsEvent[]): EventBatch {
    return {
      sdk_version: this.cfg.sdkVersion,
      sent_at: now(),
      events
    };
  }

  // ---------------------------------------------------------------------------
  // HTTP transport
  // ---------------------------------------------------------------------------

  /**
   * Primary send path — fetch with JSON body.
   * Throws on non-2xx so the caller can route to retry queue.
   */
  private async _send(batch: EventBatch): Promise<void> {
    const body = JSON.stringify(batch);
    const response = await fetch(this.cfg.collectorUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      // keepalive allows the request to outlive the page — similar to sendBeacon
      keepalive: true
    });

    if (!response.ok) {
      throw new Error(`Collector returned ${response.status}`);
    }
    log(`Batch sent OK (${batch.events.length} events)`);
  }

  /**
   * Beacon send path — used on page unload where async fetch is unreliable.
   * Falls back to synchronous fetch if sendBeacon is unavailable.
   */
  private _sendBeaconOrFetch(batch: EventBatch): void {
    const body = JSON.stringify(batch);
    const url = this.cfg.collectorUrl;

    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      const ok = navigator.sendBeacon(url, blob);
      if (!ok) {
        warn('sendBeacon returned false — browser queue full, batch dropped');
        this.cfg.onDroppedBatch?.(batch, 'sendBeacon_full');
      } else {
        log(`sendBeacon OK (${batch.events.length} events)`);
      }
    } else {
      // Non-browser environment: fire-and-forget fetch
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true
      }).catch(err => {
        warn('Final fetch failed', err);
        this.cfg.onDroppedBatch?.(batch, String(err));
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Retry queue
  // ---------------------------------------------------------------------------

  private _enqueueRetry(batch: EventBatch, currentRetries = 0): void {
    if (currentRetries >= this.cfg.maxRetries) {
      warn(`Batch dropped after ${currentRetries} retries`);
      this.cfg.onDroppedBatch?.(batch, 'max_retries_exceeded');
      return;
    }
    const delay = backoffMs(currentRetries, this.cfg.retryBaseDelayMs);
    this.retryQueue.push({
      batch,
      retries: currentRetries,
      nextRetryAt: now() + delay
    });
    log(`Retry scheduled in ${delay}ms (attempt ${currentRetries + 1}/${this.cfg.maxRetries})`);
  }

  private _scheduleRetryCheck(): void {
    this.retryTimer = setTimeout(() => this._processRetryQueue(), 5_000);
  }

  private async _processRetryQueue(): Promise<void> {
    const due = this.retryQueue.filter(q => q.nextRetryAt <= now());
    // Remove due items from queue before attempting sends
    this.retryQueue = this.retryQueue.filter(q => q.nextRetryAt > now());

    for (const item of due) {
      try {
        await this._send(item.batch);
        log(`Retry succeeded for batch with ${item.batch.events.length} events`);
      } catch (err) {
        warn(`Retry ${item.retries + 1} failed`, err);
        this._enqueueRetry(item.batch, item.retries + 1);
      }
    }

    this._scheduleRetryCheck();
  }

  // ---------------------------------------------------------------------------
  // Timer management
  // ---------------------------------------------------------------------------

  private _scheduleFlush(): void {
    if (this.flushTimer !== null) return; // already scheduled
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this._flush('timer');
    }, this.cfg.flushIntervalMs);
  }

  private _cancelTimers(): void {
    if (this.flushTimer !== null) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.retryTimer !== null) { clearTimeout(this.retryTimer); this.retryTimer = null; }
  }
}
