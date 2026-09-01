package com.analytics.sdk

import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.util.UUID

/**
 * Android port of the core SessionManager.
 * Owns session state, computes derived metrics, fires heartbeats.
 * All public methods are safe to call from any thread — internal state is guarded.
 */
internal class AnalyticsSessionManager(
    private val config: AnalyticsConfig,
    private val queue: AnalyticsEventQueue
) {
    // -------------------------------------------------------------------------
    // Session state
    // -------------------------------------------------------------------------

    private var sessionId: String = ""
    private var seq: Int = 0
    var hasFirstFrame: Boolean = false; private set
    private var playbackPositionS: Double = 0.0
    private var currentBitrateKbps: Double = 0.0
    private var currentResolution: String = "unknown"

    private var playRequestAt: Long? = null
    private var firstFrameAt: Long? = null
    private var bufferingStartAt: Long? = null
    private var totalBufferingMs: Long = 0
    private var bufferingCount: Int = 0
    private var bitrateChangeCount: Int = 0
    private var pauseStartAt: Long? = null
    private var isSessionActive: Boolean = false

    private lateinit var contentInfo: AnalyticsContentInfo
    private lateinit var playerInfo: AnalyticsPlayerInfo
    private lateinit var networkInfo: AnalyticsNetworkInfo
    private lateinit var deviceInfo: AnalyticsDeviceInfo

    // Timers run on main looper so they don't require a HandlerThread
    private val mainHandler = Handler(Looper.getMainLooper())
    private var heartbeatRunnable: Runnable? = null
    private var zombieRunnable: Runnable? = null

    // -------------------------------------------------------------------------
    // Session lifecycle
    // -------------------------------------------------------------------------

    @Synchronized
    fun startSession(
        content: AnalyticsContentInfo,
        player: AnalyticsPlayerInfo,
        network: AnalyticsNetworkInfo,
        device: AnalyticsDeviceInfo,
        autoplay: Boolean,
        userIdHash: String? = null
    ): String {
        if (isSessionActive) endSession(AnalyticsSessionEndReason.UNKNOWN)

        sessionId = UUID.randomUUID().toString()
        seq = 0
        hasFirstFrame = false
        playbackPositionS = 0.0
        currentBitrateKbps = 0.0
        currentResolution = "unknown"
        playRequestAt = null
        firstFrameAt = null
        bufferingStartAt = null
        totalBufferingMs = 0
        bufferingCount = 0
        bitrateChangeCount = 0
        pauseStartAt = null
        isSessionActive = true
        contentInfo = content
        playerInfo = player
        networkInfo = network
        deviceInfo = device

        val payload = JSONObject().apply {
            put("autoplay", autoplay)
            userIdHash?.let { put("user_id_hash", it) }
        }
        emitEvent(AnalyticsEventType.SESSION_START, payload)
        resetZombieTimer()
        AnalyticsLogger.debug("Session started: $sessionId")
        return sessionId
    }

    @Synchronized
    fun onPlayRequest(startPositionS: Double? = null) {
        if (!isSessionActive) return
        playRequestAt = System.currentTimeMillis()
        val payload = JSONObject().apply {
            startPositionS?.let { put("start_position_s", it) }
        }
        emitEvent(AnalyticsEventType.PLAY_REQUEST, payload)
        resetZombieTimer()
    }

    @Synchronized
    fun onFirstFrame() {
        if (!isSessionActive || hasFirstFrame) return
        val startupMs = playRequestAt?.let { System.currentTimeMillis() - it } ?: 0L
        firstFrameAt = System.currentTimeMillis()
        hasFirstFrame = true
        emitEvent(AnalyticsEventType.FIRST_FRAME, JSONObject().put("startup_time_ms", startupMs))
        startHeartbeat()
        resetZombieTimer()
        AnalyticsLogger.debug("First frame — startup: ${startupMs}ms")
    }

    @Synchronized
    fun onPause(positionS: Double) {
        if (!isSessionActive) return
        pauseStartAt = System.currentTimeMillis()
        playbackPositionS = positionS
        emitEvent(AnalyticsEventType.PAUSE, JSONObject().put("playback_position_s", positionS))
        resetZombieTimer()
    }

    @Synchronized
    fun onResume(positionS: Double) {
        if (!isSessionActive) return
        val pauseMs = pauseStartAt?.let { System.currentTimeMillis() - it } ?: 0L
        pauseStartAt = null
        playbackPositionS = positionS
        emitEvent(AnalyticsEventType.RESUME, JSONObject().apply {
            put("playback_position_s", positionS)
            put("pause_duration_ms", pauseMs)
        })
        resetZombieTimer()
    }

    @Synchronized
    fun onSeek(fromS: Double, toS: Double) {
        if (!isSessionActive) return
        playbackPositionS = toS
        emitEvent(AnalyticsEventType.SEEK, JSONObject().apply {
            put("from_position_s", fromS)
            put("to_position_s", toS)
        })
        resetZombieTimer()
    }

    @Synchronized
    fun onBufferingStart(positionS: Double, cause: String = "unknown") {
        if (!isSessionActive || bufferingStartAt != null) return
        bufferingStartAt = System.currentTimeMillis()
        emitEvent(AnalyticsEventType.BUFFERING_START, JSONObject().apply {
            put("playback_position_s", positionS)
            put("cause", cause)
        })
        resetZombieTimer()
    }

    @Synchronized
    fun onBufferingEnd(positionS: Double) {
        val start = bufferingStartAt ?: return
        val durationMs = System.currentTimeMillis() - start
        totalBufferingMs += durationMs
        bufferingCount++
        bufferingStartAt = null
        emitEvent(AnalyticsEventType.BUFFERING_END, JSONObject().apply {
            put("playback_position_s", positionS)
            put("buffering_duration_ms", durationMs)
        })
        resetZombieTimer()
    }

    @Synchronized
    fun onBitrateChange(
        prevKbps: Double, newKbps: Double,
        prevRes: String, newRes: String,
        reason: String = "auto",
        positionS: Double,
        codec: String? = null
    ) {
        if (!isSessionActive) return
        currentBitrateKbps = newKbps
        currentResolution = newRes
        bitrateChangeCount++
        emitEvent(AnalyticsEventType.BITRATE_CHANGE, JSONObject().apply {
            put("previous_bitrate_kbps", prevKbps)
            put("new_bitrate_kbps", newKbps)
            put("previous_resolution", prevRes)
            put("new_resolution", newRes)
            put("reason", reason)
            put("playback_position_s", positionS)
            codec?.let { put("codec", it) }
        })
        resetZombieTimer()
    }

    @Synchronized
    fun onError(
        code: String, message: String,
        source: AnalyticsErrorSource,
        fatal: Boolean,
        vsfType: String? = null,
        isEbvs: Boolean? = null,
        positionS: Double? = null,
        httpStatus: Int? = null
    ) {
        if (!isSessionActive) return
        emitEvent(AnalyticsEventType.ERROR, JSONObject().apply {
            put("error_code", code)
            put("error_message", message)
            put("source", source.value)
            put("fatal", fatal)
            vsfType?.let { put("vsf_type", it) }
            isEbvs?.let { put("is_ebvs", it) }
            positionS?.let { put("playback_position_s", it) }
            httpStatus?.let { put("http_status", it) }
        })
        if (fatal) endSession(AnalyticsSessionEndReason.ERROR)
    }

    @Synchronized
    fun onCdnRequest(
        cdnName: String, requestType: String,
        httpStatus: Int, ttfbMs: Double, durationMs: Double,
        bytes: Long, throughputKbps: Double,
        sequenceNumber: Int? = null
    ) {
        if (!isSessionActive) return
        emitEvent(AnalyticsEventType.CDN_REQUEST, JSONObject().apply {
            put("cdn_name", cdnName)
            put("request_type", requestType)
            put("http_status", httpStatus)
            put("ttfb_ms", ttfbMs)
            put("duration_ms", durationMs)
            put("bytes", bytes)
            put("throughput_kbps", throughputKbps)
            sequenceNumber?.let { put("sequence_number", it) }
        })
    }

    @Synchronized
    fun onCdnSwitch(from: String, to: String, reason: String,
                    positionS: Double, triggerHttpStatus: Int? = null) {
        if (!isSessionActive) return
        emitEvent(AnalyticsEventType.CDN_SWITCH, JSONObject().apply {
            put("cdn_from", from)
            put("cdn_to", to)
            put("reason", reason)
            put("playback_position_s", positionS)
            triggerHttpStatus?.let { put("trigger_http_status", it) }
        })
    }

    @Synchronized
    fun onJoinTime(ms: Long) {
        if (!isSessionActive) return
        emitEvent(AnalyticsEventType.JOIN_TIME, JSONObject().put("join_time_ms", ms))
    }

    @Synchronized
    fun onLiveLatency(latencyS: Double, positionS: Double, targetLatencyS: Double? = null) {
        if (!isSessionActive) return
        emitEvent(AnalyticsEventType.LIVE_LATENCY, JSONObject().apply {
            put("latency_s", latencyS)
            put("playback_position_s", positionS)
            targetLatencyS?.let { put("target_latency_s", it) }
        })
    }

    @Synchronized
    fun onManifestError(httpStatus: Int, retryCount: Int, fatal: Boolean) {
        if (!isSessionActive) return
        emitEvent(AnalyticsEventType.MANIFEST_ERROR, JSONObject().apply {
            put("http_status", httpStatus)
            put("retry_count", retryCount)
            put("fatal", fatal)
        })
    }

    @Synchronized
    fun updatePlaybackPosition(positionS: Double,
                                bitrateKbps: Double? = null,
                                resolution: String? = null) {
        playbackPositionS = positionS
        bitrateKbps?.let { currentBitrateKbps = it }
        resolution?.let { currentResolution = it }
    }

    @Synchronized
    fun endSession(reason: AnalyticsSessionEndReason) {
        if (!isSessionActive) return
        stopHeartbeat()
        cancelZombieTimer()

        if (bufferingStartAt != null) onBufferingEnd(playbackPositionS)

        val watchTimeS = firstFrameAt?.let {
            (System.currentTimeMillis() - it) / 1000.0
        } ?: 0.0

        val completionPct: Double? = if (contentInfo.type == AnalyticsContentType.VOD
            && contentInfo.durationS != null && contentInfo.durationS > 0) {
            minOf(100.0, (playbackPositionS / contentInfo.durationS) * 100.0)
        } else null

        emitEvent(AnalyticsEventType.SESSION_END, JSONObject().apply {
            put("watch_time_s", watchTimeS)
            if (completionPct != null) put("completion_pct", completionPct)
            else put("completion_pct", JSONObject.NULL)
            put("reason", reason.value)
            put("rebuffer_count", bufferingCount)
            put("rebuffer_time_s", totalBufferingMs / 1000.0)
            put("bitrate_change_count", bitrateChangeCount)
        })
        isSessionActive = false
        AnalyticsLogger.debug("Session ended: $sessionId reason=${reason.value}")
    }

    // -------------------------------------------------------------------------
    // Heartbeat
    // -------------------------------------------------------------------------

    private fun startHeartbeat() {
        if (config.heartbeatIntervalMs == 0L || heartbeatRunnable != null) return
        val runnable = object : Runnable {
            override fun run() {
                emitHeartbeat()
                mainHandler.postDelayed(this, config.heartbeatIntervalMs)
            }
        }
        heartbeatRunnable = runnable
        mainHandler.postDelayed(runnable, config.heartbeatIntervalMs)
    }

    private fun stopHeartbeat() {
        heartbeatRunnable?.let { mainHandler.removeCallbacks(it) }
        heartbeatRunnable = null
    }

    @Synchronized
    private fun emitHeartbeat() {
        if (!isSessionActive) return
        emitEvent(AnalyticsEventType.HEARTBEAT, JSONObject().apply {
            put("playback_position_s", playbackPositionS)
            put("current_bitrate_kbps", currentBitrateKbps)
            put("current_resolution", currentResolution)
            put("is_buffering", bufferingStartAt != null)
            put("rebuffer_time_ms", totalBufferingMs)
        })
    }

    // -------------------------------------------------------------------------
    // Zombie watchdog
    // -------------------------------------------------------------------------

    private fun resetZombieTimer() {
        cancelZombieTimer()
        val timeout = config.heartbeatIntervalMs * 2 + 5_000L
        val runnable = Runnable {
            AnalyticsLogger.warn("Zombie session detected — auto-closing")
            endSession(AnalyticsSessionEndReason.UNKNOWN)
        }
        zombieRunnable = runnable
        mainHandler.postDelayed(runnable, timeout)
    }

    private fun cancelZombieTimer() {
        zombieRunnable?.let { mainHandler.removeCallbacks(it) }
        zombieRunnable = null
    }

    // -------------------------------------------------------------------------
    // Internal emit
    // -------------------------------------------------------------------------

    private fun emitEvent(type: AnalyticsEventType, payload: JSONObject) {
        seq++
        val event = AnalyticsEvent(
            sessionId = sessionId,
            eventType = type,
            timestamp = System.currentTimeMillis(),
            platform = config.platform,
            content = contentInfo,
            player = playerInfo,
            network = networkInfo,
            device = deviceInfo,
            seq = seq,
            payload = payload
        )
        queue.enqueue(event)
    }
}
