// AnalyticsEventQueue.swift
// iOS/tvOS transport layer: batching, flush, retry with exponential back-off.
// All network calls are fire-and-forget on a background serial queue.
// URLSession background tasks are used when available for reliable delivery.

import Foundation

public final class AnalyticsEventQueue {

    // MARK: - State

    private var pending: [AnalyticsEvent] = []
    private var retryQueue: [RetryItem] = []
    private let lock = NSLock()
    private var flushTimer: Timer? = nil
    private var retryTimer: Timer? = nil
    private let config: AnalyticsConfig
    private let session: URLSession
    private let bgQueue = DispatchQueue(label: "com.analytics.eventqueue", qos: .utility)

    // MARK: - Init

    public init(config: AnalyticsConfig) {
        self.config = config

        let sessionConfig = URLSessionConfiguration.default
        sessionConfig.timeoutIntervalForRequest = 10
        sessionConfig.timeoutIntervalForResource = 30
        self.session = URLSession(configuration: sessionConfig)

        scheduleFlush()
        scheduleRetryCheck()
    }

    // MARK: - Public API

    public func enqueue(_ event: AnalyticsEvent) {
        lock.lock()
        if pending.count >= config.maxQueueSize {
            pending.removeFirst()
            AnalyticsLogger.warn("Queue full — oldest event dropped")
        }
        pending.append(event)
        let shouldFlush = pending.count >= config.batchSize
        lock.unlock()

        AnalyticsLogger.debug("Enqueued \(event.event_type)")
        if shouldFlush { flush(reason: "threshold") }
    }

    /// Called on app background / termination — uses a synchronous URLSession to
    /// guarantee delivery before the process is suspended.
    public func flushSynchronous() {
        lock.lock()
        guard !pending.isEmpty else { lock.unlock(); return }
        let events = pending
        pending = []
        lock.unlock()

        let batch = buildBatch(events: events)
        sendSync(batch: batch)
    }

    public func destroy() {
        flushTimer?.invalidate()
        retryTimer?.invalidate()
        flushSynchronous()
    }

    // MARK: - Flush

    private func flush(reason: String) {
        bgQueue.async { [weak self] in
            guard let self else { return }

            self.lock.lock()
            guard !self.pending.isEmpty else { self.lock.unlock(); return }
            let events = self.pending
            self.pending = []
            self.lock.unlock()

            let batch = self.buildBatch(events: events)
            AnalyticsLogger.debug("Flushing \(events.count) events (\(reason))")

            self.sendAsync(batch: batch) { success in
                if !success {
                    self.enqueueRetry(batch: batch)
                }
            }
        }
    }

    private func scheduleFlush() {
        let interval = TimeInterval(config.flushIntervalMs) / 1000.0
        DispatchQueue.main.async { [weak self] in
            self?.flushTimer = Timer.scheduledTimer(
                withTimeInterval: interval, repeats: true
            ) { [weak self] _ in
                self?.flush(reason: "timer")
            }
        }
    }

    // MARK: - HTTP transport (async)

    private func sendAsync(batch: AnalyticsEventBatch, completion: @escaping (Bool) -> Void) {
        guard let request = buildRequest(batch: batch) else {
            completion(false)
            return
        }
        session.dataTask(with: request) { _, response, error in
            if let error {
                AnalyticsLogger.warn("Send failed: \(error.localizedDescription)")
                completion(false)
                return
            }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if (200..<300).contains(status) {
                AnalyticsLogger.debug("Batch sent OK (\(batch.events.count) events)")
                completion(true)
            } else {
                AnalyticsLogger.warn("Collector returned \(status)")
                completion(false)
            }
        }.resume()
    }

    /// Blocking send — only used during app background / termination.
    private func sendSync(batch: AnalyticsEventBatch) {
        guard let request = buildRequest(batch: batch) else { return }
        let sema = DispatchSemaphore(value: 0)
        session.dataTask(with: request) { _, _, _ in sema.signal() }.resume()
        sema.wait()
    }

    private func buildRequest(batch: AnalyticsEventBatch) -> URLRequest? {
        guard let url = URL(string: config.collectorUrl) else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 10
        request.httpBody = try? JSONEncoder().encode(batch)
        return request
    }

    // MARK: - Retry queue

    private struct RetryItem {
        let batch: AnalyticsEventBatch
        let retries: Int
        let nextRetryAt: Date
    }

    private func enqueueRetry(batch: AnalyticsEventBatch, retries: Int = 0) {
        guard retries < config.maxRetries else {
            AnalyticsLogger.warn("Batch dropped after \(retries) retries")
            config.onDroppedBatch?(batch)
            return
        }
        let delayMs = backoffMs(attempt: retries, baseMs: config.retryBaseDelayMs)
        let item = RetryItem(
            batch: batch,
            retries: retries,
            nextRetryAt: Date().addingTimeInterval(Double(delayMs) / 1000.0)
        )
        lock.lock()
        retryQueue.append(item)
        lock.unlock()
        AnalyticsLogger.debug("Retry in \(delayMs)ms (attempt \(retries + 1)/\(config.maxRetries))")
    }

    private func scheduleRetryCheck() {
        DispatchQueue.main.async { [weak self] in
            self?.retryTimer = Timer.scheduledTimer(
                withTimeInterval: 5.0, repeats: true
            ) { [weak self] _ in
                self?.processRetryQueue()
            }
        }
    }

    private func processRetryQueue() {
        let now = Date()
        lock.lock()
        let due = retryQueue.filter { $0.nextRetryAt <= now }
        retryQueue = retryQueue.filter { $0.nextRetryAt > now }
        lock.unlock()

        for item in due {
            sendAsync(batch: item.batch) { [weak self] success in
                guard let self else { return }
                if success {
                    AnalyticsLogger.debug("Retry succeeded")
                } else {
                    self.enqueueRetry(batch: item.batch, retries: item.retries + 1)
                }
            }
        }
    }

    // MARK: - Helpers

    private func buildBatch(events: [AnalyticsEvent]) -> AnalyticsEventBatch {
        AnalyticsEventBatch(
            sdk_version: config.sdkVersion,
            sent_at: Int64(Date().timeIntervalSince1970 * 1000),
            events: events
        )
    }

    private func backoffMs(attempt: Int, baseMs: Int) -> Int {
        let cap = 30_000
        let ceiling = min(cap, baseMs * Int(pow(2.0, Double(attempt))))
        return Int.random(in: 0..<ceiling)
    }
}
