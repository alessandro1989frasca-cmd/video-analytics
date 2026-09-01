package com.analytics.sdk

/**
 * Configuration for the Android analytics SDK.
 * Pass an instance to [ExoPlayerAdapter] at construction time.
 */
data class AnalyticsConfig(
    /** Collector endpoint URL */
    val collectorUrl: String,
    /** Your SDK release version string */
    val sdkVersion: String,
    /** ANDROID for phones/tablets, ANDROIDTV for leanback devices */
    val platform: AnalyticsPlatform = AnalyticsPlatform.ANDROID,
    /** Events to accumulate before auto-flushing. Default: 20 */
    val batchSize: Int = 20,
    /** Max ms to hold events before flushing. Default: 10_000 */
    val flushIntervalMs: Long = 10_000L,
    /** Heartbeat interval ms. 0 to disable. Default: 15_000 */
    val heartbeatIntervalMs: Long = 15_000L,
    /** Max retries per failed batch. Default: 3 */
    val maxRetries: Int = 3,
    /** Base delay (ms) for exponential back-off. Default: 1_000 */
    val retryBaseDelayMs: Long = 1_000L,
    /** Max in-memory event queue size. Default: 1_000 */
    val maxQueueSize: Int = 1_000,
    /** Verbose logging — must be false in production. Default: false */
    val debug: Boolean = false,
    /** Called when a batch is permanently dropped after all retries */
    val onDroppedBatch: ((AnalyticsEventBatch) -> Unit)? = null
)
