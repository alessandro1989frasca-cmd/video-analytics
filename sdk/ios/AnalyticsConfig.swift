// AnalyticsConfig.swift
// Configuration struct for the iOS/tvOS SDK.

import Foundation

public struct AnalyticsConfig {
    /// Collector endpoint URL
    public let collectorUrl: String

    /// SDK version string (set to your release version)
    public let sdkVersion: String

    /// Platform: .ios for iPhone/iPad, .tvos for Apple TV
    public let platform: AnalyticsPlatform

    /// Events to accumulate before auto-flushing. Default: 20
    public var batchSize: Int = 20

    /// Max milliseconds to hold events before flushing. Default: 10_000
    public var flushIntervalMs: Int = 10_000

    /// Heartbeat interval in ms. 0 to disable. Default: 15_000
    public var heartbeatIntervalMs: Int = 15_000

    /// Max retries for a failed batch. Default: 3
    public var maxRetries: Int = 3

    /// Base delay (ms) for exponential back-off. Default: 1_000
    public var retryBaseDelayMs: Int = 1_000

    /// Max in-memory queue size. Default: 1_000
    public var maxQueueSize: Int = 1_000

    /// Verbose logging. Must be false in production. Default: false
    public var debug: Bool = false

    /// Called when a batch is permanently dropped after all retries
    public var onDroppedBatch: ((AnalyticsEventBatch) -> Void)? = nil

    public init(collectorUrl: String, sdkVersion: String,
                platform: AnalyticsPlatform = .ios) {
        self.collectorUrl = collectorUrl
        self.sdkVersion = sdkVersion
        self.platform = platform
    }
}
