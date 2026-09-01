package com.analytics.sdk

import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlin.math.min
import kotlin.math.pow
import kotlin.random.Random

/**
 * Android transport layer: in-memory batch queue, flush timer, retry with back-off.
 *
 * Uses OkHttp for HTTP (standard Android networking choice); all sends happen
 * on a dedicated background HandlerThread — never on the main/player thread.
 */
internal class AnalyticsEventQueue(private val config: AnalyticsConfig) {

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    private val lock = ReentrantLock()
    private val pending = mutableListOf<AnalyticsEvent>()
    private val retryQueue = mutableListOf<RetryItem>()

    private val bgThread = HandlerThread("analytics-queue").also { it.start() }
    private val bgHandler = Handler(bgThread.looper)

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .build()

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    // -------------------------------------------------------------------------
    // Flush timer — posted on bgHandler to stay off the main thread
    // -------------------------------------------------------------------------

    private val flushRunnable = object : Runnable {
        override fun run() {
            flush("timer")
            bgHandler.postDelayed(this, config.flushIntervalMs)
        }
    }

    private val retryRunnable = object : Runnable {
        override fun run() {
            processRetryQueue()
            bgHandler.postDelayed(this, 5_000L)
        }
    }

    init {
        bgHandler.postDelayed(flushRunnable, config.flushIntervalMs)
        bgHandler.postDelayed(retryRunnable, 5_000L)
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    fun enqueue(event: AnalyticsEvent) {
        val shouldFlush = lock.withLock {
            if (pending.size >= config.maxQueueSize) {
                pending.removeAt(0)
                AnalyticsLogger.warn("Queue full — oldest event dropped")
            }
            pending.add(event)
            pending.size >= config.batchSize
        }
        AnalyticsLogger.debug("Enqueued ${event.eventType.value} (queue=${pending.size})")
        if (shouldFlush) bgHandler.post { flush("threshold") }
    }

    /** Blocking flush — call from lifecycle callbacks (onStop, onDestroy) */
    fun flushBlocking() {
        val events = lock.withLock {
            if (pending.isEmpty()) return
            val snapshot = pending.toList()
            pending.clear()
            snapshot
        }
        val batch = buildBatch(events)
        sendBlocking(batch)
    }

    fun destroy() {
        bgHandler.removeCallbacks(flushRunnable)
        bgHandler.removeCallbacks(retryRunnable)
        flushBlocking()
        bgThread.quitSafely()
    }

    // -------------------------------------------------------------------------
    // Flush logic
    // -------------------------------------------------------------------------

    private fun flush(reason: String) {
        val events = lock.withLock {
            if (pending.isEmpty()) return
            val snapshot = pending.toList()
            pending.clear()
            snapshot
        }
        val batch = buildBatch(events)
        AnalyticsLogger.debug("Flushing ${events.size} events ($reason)")
        sendAsync(batch)
    }

    // -------------------------------------------------------------------------
    // HTTP transport
    // -------------------------------------------------------------------------

    private fun sendAsync(batch: AnalyticsEventBatch, retries: Int = 0) {
        bgHandler.post {
            val ok = sendBlocking(batch)
            if (!ok) enqueueRetry(batch, retries)
        }
    }

    private fun sendBlocking(batch: AnalyticsEventBatch): Boolean {
        return try {
            val body = batch.toJson().toString().toRequestBody(jsonMedia)
            val request = Request.Builder()
                .url(config.collectorUrl)
                .post(body)
                .build()

            httpClient.newCall(request).execute().use { response ->
                val ok = response.isSuccessful
                if (ok) {
                    AnalyticsLogger.debug("Batch sent OK (${batch.events.size} events)")
                } else {
                    AnalyticsLogger.warn("Collector returned ${response.code}")
                }
                ok
            }
        } catch (e: IOException) {
            AnalyticsLogger.error("Send failed: ${e.message}", e)
            false
        }
    }

    // -------------------------------------------------------------------------
    // Retry queue
    // -------------------------------------------------------------------------

    private data class RetryItem(
        val batch: AnalyticsEventBatch,
        val retries: Int,
        val nextRetryAt: Long   // System.currentTimeMillis()
    )

    private fun enqueueRetry(batch: AnalyticsEventBatch, retries: Int) {
        if (retries >= config.maxRetries) {
            AnalyticsLogger.warn("Batch dropped after $retries retries")
            config.onDroppedBatch?.invoke(batch)
            return
        }
        val delayMs = backoffMs(retries, config.retryBaseDelayMs)
        lock.withLock {
            retryQueue.add(RetryItem(batch, retries, System.currentTimeMillis() + delayMs))
        }
        AnalyticsLogger.debug("Retry in ${delayMs}ms (attempt ${retries + 1}/${config.maxRetries})")
    }

    private fun processRetryQueue() {
        val now = System.currentTimeMillis()
        val due = lock.withLock {
            val d = retryQueue.filter { it.nextRetryAt <= now }
            retryQueue.removeAll { it.nextRetryAt <= now }
            d
        }
        for (item in due) {
            val ok = sendBlocking(item.batch)
            if (!ok) enqueueRetry(item.batch, item.retries + 1)
        }
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private fun buildBatch(events: List<AnalyticsEvent>) = AnalyticsEventBatch(
        sdkVersion = config.sdkVersion,
        sentAt = System.currentTimeMillis(),
        events = events
    )

    private fun backoffMs(attempt: Int, baseMs: Long): Long {
        val cap = 30_000L
        val ceiling = min(cap, (baseMs * 2.0.pow(attempt.toDouble())).toLong())
        return Random.nextLong(ceiling)
    }
}
