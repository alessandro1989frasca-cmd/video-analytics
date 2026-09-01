package com.analytics.sdk

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.util.DisplayMetrics
import android.view.WindowManager
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import com.google.android.exoplayer2.C
import com.google.android.exoplayer2.ExoPlayer
import com.google.android.exoplayer2.Format
import com.google.android.exoplayer2.PlaybackException
import com.google.android.exoplayer2.Player
import com.google.android.exoplayer2.analytics.AnalyticsListener
import com.google.android.exoplayer2.analytics.AnalyticsListener.EventTime
import com.google.android.exoplayer2.drm.DrmSession
import com.google.android.exoplayer2.source.LoadEventInfo
import com.google.android.exoplayer2.source.MediaLoadData
import com.google.android.exoplayer2.upstream.HttpDataSource
import java.io.IOException
import java.net.URL

/**
 * ExoPlayerAdapter — wires ExoPlayer/Media3 [AnalyticsListener] to the analytics SDK.
 *
 * ExoPlayer's AnalyticsListener provides the richest event coverage available on Android:
 *  - onVideoSizeChanged                 → first frame detection + resolution
 *  - onPlaybackStateChanged             → buffering start/end, play request, end
 *  - onIsPlayingChanged                 → pause / resume
 *  - onVideoInputFormatChanged          → bitrate change (from chosen rendition)
 *  - onLoadCompleted                    → per-segment CDN analytics (bytes, timing)
 *  - onLoadError                        → network / CDN errors
 *  - onPlayerError                      → fatal player errors
 *  - onRenderedFirstFrame               → definitive first frame signal
 *  - onPositionDiscontinuity            → seek detection
 *
 * Also implements [DefaultLifecycleObserver] so it can be registered on a
 * LifecycleOwner (Activity/Fragment) for automatic attach/detach.
 *
 * Usage:
 *   val adapter = ExoPlayerAdapter(context, player, content, config)
 *   adapter.attach()
 *   lifecycle.addObserver(adapter)  // automatic lifecycle handling
 */
class ExoPlayerAdapter(
    private val context: Context,
    private val player: ExoPlayer,
    private val content: AnalyticsContentInfo,
    private val config: AnalyticsConfig,
    private val cdnOverride: String? = null,
    private val userIdHash: String? = null
) : AnalyticsListener, DefaultLifecycleObserver {

    // -------------------------------------------------------------------------
    // Internal state
    // -------------------------------------------------------------------------

    private val eventQueue = AnalyticsEventQueue(config)
    private val session = AnalyticsSessionManager(config, eventQueue)

    private var isAttached = false
    private var prevVideoFormat: Format? = null
    private var prevVideoRes: String = "unknown"
    private var liveJoinStart: Long? = null

    // Track buffering state independently — ExoPlayer can toggle STATE_BUFFERING
    // multiple times without a STATE_READY in between.
    private var isBuffering = false

    init {
        AnalyticsLogger.isDebug = config.debug
    }

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    /** Call after ExoPlayer.prepare() but before play(). */
    fun attach() {
        if (isAttached) return
        isAttached = true

        session.startSession(
            content = content,
            player = makePlayerInfo(),
            network = makeNetworkInfo(),
            device = makeDeviceInfo(),
            autoplay = player.playWhenReady,
            userIdHash = userIdHash
        )

        if (content.type == AnalyticsContentType.LIVE) {
            liveJoinStart = System.currentTimeMillis()
        }

        player.addAnalyticsListener(this)
    }

    /** Remove listeners, end session, flush remaining events. */
    fun detach() {
        if (!isAttached) return
        isAttached = false
        player.removeAnalyticsListener(this)
        session.endSession(AnalyticsSessionEndReason.USER_STOP)
        eventQueue.destroy()
    }

    // DefaultLifecycleObserver — auto attach/detach on Activity/Fragment lifecycle
    override fun onStart(owner: LifecycleOwner) { attach() }
    override fun onStop(owner: LifecycleOwner)  { detach() }

    // -------------------------------------------------------------------------
    // AnalyticsListener implementations
    // -------------------------------------------------------------------------

    /** Fired when ExoPlayer is first prepared — good proxy for play intent. */
    override fun onPlaybackStateChanged(eventTime: EventTime, state: Int) {
        val posS = eventTime.currentPlaybackPositionMs / 1000.0

        when (state) {
            Player.STATE_BUFFERING -> {
                if (!isBuffering) {
                    isBuffering = true
                    // Before first frame it's the initial load, not a rebuffer
                    val cause = if (!session.hasFirstFrame) "initial" else "network"
                    session.onBufferingStart(posS, cause)
                }
            }

            Player.STATE_READY -> {
                if (isBuffering) {
                    isBuffering = false
                    session.onBufferingEnd(posS)
                }
            }

            Player.STATE_ENDED -> {
                if (isBuffering) { isBuffering = false; session.onBufferingEnd(posS) }
                session.endSession(AnalyticsSessionEndReason.COMPLETED)
            }

            Player.STATE_IDLE -> {
                // Player reset — nothing to do here; errors are caught in onPlayerError
            }
        }
    }

    /**
     * Fired when actual playback starts or stops (i.e., the clock is ticking / stopped).
     * More accurate than STATE_READY for pause/resume tracking.
     */
    override fun onIsPlayingChanged(eventTime: EventTime, isPlaying: Boolean) {
        val posS = eventTime.currentPlaybackPositionMs / 1000.0
        if (isPlaying) {
            session.onResume(posS)
        } else {
            // Filter out pauses that are actually buffering or end-of-stream
            val state = player.playbackState
            if (state != Player.STATE_BUFFERING && state != Player.STATE_ENDED) {
                session.onPause(posS)
            }
        }
    }

    /**
     * First video frame rendered to screen — the definitive FIRST_FRAME signal.
     * Uses onVideoSizeChanged as the PLAY_REQUEST proxy (fires earlier).
     */
    override fun onRenderedFirstFrame(eventTime: EventTime, output: Any, renderTimeMs: Long) {
        session.onFirstFrame()

        if (content.type == AnalyticsContentType.LIVE) {
            liveJoinStart?.let { start ->
                session.onJoinTime(System.currentTimeMillis() - start)
                liveJoinStart = null
            }
        }
    }

    /**
     * Video size change fires before first frame and on every resolution switch.
     * We use it as the PLAY_REQUEST proxy.
     */
    override fun onVideoSizeChanged(eventTime: EventTime, videoSize: com.google.android.exoplayer2.video.VideoSize) {
        if (!session.hasFirstFrame && videoSize.width > 0) {
            session.onPlayRequest()
        }
        val newRes = "${videoSize.width}x${videoSize.height}"
        session.updatePlaybackPosition(
            eventTime.currentPlaybackPositionMs / 1000.0,
            resolution = newRes
        )
    }

    /**
     * Fired when the selected video rendition changes (ABR switch).
     * Format.bitrate = declared bitrate of the rendition in bps.
     */
    override fun onVideoInputFormatChanged(
        eventTime: EventTime,
        format: Format?,
        decoderReuseEvaluation: com.google.android.exoplayer2.decoder.DecoderReuseEvaluation?
    ) {
        val newFormat = format ?: return
        val prevFormat = prevVideoFormat
        val posS = eventTime.currentPlaybackPositionMs / 1000.0

        val newBitrateKbps = (newFormat.bitrate.takeIf { it != Format.NO_VALUE } ?: 0) / 1000.0
        val newRes = "${newFormat.width}x${newFormat.height}".let {
            if (it == "-1x-1") "unknown" else it
        }
        val prevBitrateKbps = prevFormat?.bitrate?.takeIf { it != Format.NO_VALUE }?.div(1000.0) ?: 0.0
        val prevRes = prevFormat?.let { "${it.width}x${it.height}" } ?: prevVideoRes

        session.onBitrateChange(
            prevKbps = prevBitrateKbps,
            newKbps = newBitrateKbps,
            prevRes = prevRes,
            newRes = newRes,
            reason = "auto",
            positionS = posS,
            codec = newFormat.codecs
        )

        prevVideoFormat = newFormat
        prevVideoRes = newRes
    }

    /**
     * Fired on every seek (position discontinuity of type SEEK or SEEK_ADJUSTMENT).
     */
    override fun onPositionDiscontinuity(
        eventTime: EventTime,
        oldPosition: Player.PositionInfo,
        newPosition: Player.PositionInfo,
        reason: Int
    ) {
        if (reason == Player.DISCONTINUITY_REASON_SEEK ||
            reason == Player.DISCONTINUITY_REASON_SEEK_ADJUSTMENT) {
            session.onSeek(
                fromS = oldPosition.positionMs / 1000.0,
                toS   = newPosition.positionMs / 1000.0
            )
        }
    }

    /**
     * Per-load completion — the richest source of CDN analytics.
     * Fires for every HLS/DASH segment, manifest, and key request.
     */
    override fun onLoadCompleted(
        eventTime: EventTime,
        loadEventInfo: LoadEventInfo,
        mediaLoadData: MediaLoadData
    ) {
        val bytes = loadEventInfo.bytesLoaded
        val durationMs = (loadEventInfo.loadDurationMs).toDouble()
        val ttfbMs = 0.0  // ExoPlayer doesn't expose TTFB directly
        val throughputKbps = if (durationMs > 0) (bytes * 8.0) / durationMs else 0.0

        val requestType = when (mediaLoadData.dataType) {
            C.DATA_TYPE_MANIFEST -> "manifest"
            C.DATA_TYPE_DRM      -> "key"
            else                 -> "segment"  // C.DATA_TYPE_MEDIA and others
        }

        val cdnName = cdnOverride
            ?: guessCdn(loadEventInfo.uri?.toString() ?: "")
            ?: "unknown"

        session.onCdnRequest(
            cdnName = cdnName,
            requestType = requestType,
            httpStatus = loadEventInfo.responseHeaders["status"]?.firstOrNull()?.toIntOrNull() ?: 200,
            ttfbMs = ttfbMs,
            durationMs = durationMs,
            bytes = bytes,
            throughputKbps = throughputKbps,
            sequenceNumber = mediaLoadData.mediaStartTimeMs.toInt().takeIf { it >= 0 }
        )
    }

    /**
     * Network/CDN load error — distinguishes retryable from fatal.
     */
    override fun onLoadError(
        eventTime: EventTime,
        loadEventInfo: LoadEventInfo,
        mediaLoadData: MediaLoadData,
        error: IOException,
        wasCanceled: Boolean
    ) {
        if (wasCanceled) return

        val httpStatus = (error as? HttpDataSource.InvalidResponseCodeException)?.responseCode ?: 0
        val isManifest = mediaLoadData.dataType == C.DATA_TYPE_MANIFEST

        if (isManifest) {
            session.onManifestError(httpStatus, retryCount = 0, fatal = false)
            return
        }

        session.onError(
            code = "LOAD_ERROR_${mediaLoadData.dataType}",
            message = error.message ?: "Load error",
            source = AnalyticsErrorSource.NETWORK,
            fatal = false,
            httpStatus = httpStatus
        )
    }

    /**
     * Fatal player error — always ends the session.
     */
    override fun onPlayerError(eventTime: EventTime, error: PlaybackException) {
        val source = when (error.errorCode) {
            in PlaybackException.ERROR_CODE_IO_UNSPECIFIED..PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS ->
                AnalyticsErrorSource.NETWORK
            in PlaybackException.ERROR_CODE_DRM_SCHEME_UNSUPPORTED..PlaybackException.ERROR_CODE_DRM_SYSTEM_ERROR ->
                AnalyticsErrorSource.DRM
            else -> AnalyticsErrorSource.PLAYER
        }

        session.onError(
            code = "EXOPLAYER_${error.errorCode}",
            message = error.message ?: "ExoPlayer error",
            source = source,
            fatal = true,
            vsfType = if (!session.hasFirstFrame) "technical" else null,
            positionS = eventTime.currentPlaybackPositionMs / 1000.0
        )
    }

    /**
     * DRM key loading error.
     */
    override fun onDrmSessionManagerError(eventTime: EventTime, error: Exception) {
        session.onError(
            code = "DRM_SESSION_ERROR",
            message = error.message ?: "DRM error",
            source = AnalyticsErrorSource.DRM,
            fatal = true,
            vsfType = if (!session.hasFirstFrame) "technical" else null
        )
    }

    // -------------------------------------------------------------------------
    // Helpers — device / network metadata
    // -------------------------------------------------------------------------

    private fun makePlayerInfo(): AnalyticsPlayerInfo {
        val exoVersion = try {
            ExoPlayer::class.java.getField("EXOPLAYER_RELEASE_OR_DEV_VERSION").get(null) as? String
        } catch (_: Exception) { "unknown" } ?: "unknown"

        return AnalyticsPlayerInfo(
            engine = AnalyticsPlayerEngine.EXOPLAYER,
            engineVersion = exoVersion,
            sdkVersion = config.sdkVersion
        )
    }

    private fun makeNetworkInfo(): AnalyticsNetworkInfo {
        return AnalyticsNetworkInfo(
            connectionType = getConnectionType(),
            cdn = cdnOverride
        )
    }

    private fun makeDeviceInfo(): AnalyticsDeviceInfo {
        val metrics = DisplayMetrics().also { dm ->
            @Suppress("DEPRECATION")
            (context.getSystemService(Context.WINDOW_SERVICE) as WindowManager)
                .defaultDisplay.getMetrics(dm)
        }
        return AnalyticsDeviceInfo(
            os = "android",
            osVersion = Build.VERSION.RELEASE,
            model = "${Build.MANUFACTURER} ${Build.MODEL}",
            screenResolution = "${metrics.widthPixels}x${metrics.heightPixels}"
        )
    }

    private fun getConnectionType(): AnalyticsConnectionType {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val network = cm.activeNetwork ?: return AnalyticsConnectionType.UNKNOWN
            val caps = cm.getNetworkCapabilities(network) ?: return AnalyticsConnectionType.UNKNOWN
            when {
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)     -> AnalyticsConnectionType.WIFI
                caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> AnalyticsConnectionType.CELLULAR
                caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> AnalyticsConnectionType.ETHERNET
                else -> AnalyticsConnectionType.UNKNOWN
            }
        } else {
            @Suppress("DEPRECATION")
            when (cm.activeNetworkInfo?.type) {
                ConnectivityManager.TYPE_WIFI     -> AnalyticsConnectionType.WIFI
                ConnectivityManager.TYPE_MOBILE   -> AnalyticsConnectionType.CELLULAR
                ConnectivityManager.TYPE_ETHERNET -> AnalyticsConnectionType.ETHERNET
                else -> AnalyticsConnectionType.UNKNOWN
            }
        }
    }

    private fun guessCdn(urlString: String): String? {
        return try {
            val host = URL(urlString).host?.lowercase() ?: return null
            when {
                host.contains("akamai") || host.contains("akamaized") -> "akamai"
                host.contains("cloudfront")  -> "cloudfront"
                host.contains("fastly")      -> "fastly"
                host.contains("cloudflare")  -> "cloudflare"
                host.contains("cdn77")       -> "cdn77"
                else -> host
            }
        } catch (_: Exception) { null }
    }
}
