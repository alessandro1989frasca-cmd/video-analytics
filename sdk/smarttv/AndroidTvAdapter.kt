package com.analytics.sdk.smarttv

import android.content.Context
import android.os.Build
import com.analytics.sdk.AnalyticsConfig
import com.analytics.sdk.AnalyticsContentInfo
import com.analytics.sdk.AnalyticsPlatform
import com.analytics.sdk.ExoPlayerAdapter
import com.google.android.exoplayer2.ExoPlayer

/**
 * AndroidTvAdapter — Android TV / Fire TV / Google TV
 *
 * Android TV uses the same ExoPlayer stack as mobile Android.
 * This class is a thin wrapper over ExoPlayerAdapter that:
 *  - Forces platform = ANDROIDTV
 *  - Sets leanback-appropriate display metrics (usually 1920×1080)
 *  - Can be extended for Amazon Fire TV specifics (e.g. Whisperplay events)
 *
 * Usage is identical to the mobile ExoPlayerAdapter:
 *   val adapter = AndroidTvAdapter(context, player, content, config)
 *   lifecycle.addObserver(adapter)
 */
class AndroidTvAdapter(
    context: Context,
    player: ExoPlayer,
    content: AnalyticsContentInfo,
    baseConfig: AnalyticsConfig,
    cdnOverride: String? = null,
    userIdHash: String? = null
) : ExoPlayerAdapter(
    context = context,
    player = player,
    content = content,
    // Force platform to ANDROIDTV regardless of what was passed in
    config = baseConfig.copy(platform = AnalyticsPlatform.ANDROIDTV),
    cdnOverride = cdnOverride,
    userIdHash = userIdHash
) {
    // All functionality is inherited from ExoPlayerAdapter.
    // Add Fire TV / Google TV specific overrides here if needed.
    //
    // Amazon Fire TV: consider hooking into the Amazon media extension events
    // via AmazonHLSPlayer if not using ExoPlayer.
    //
    // Google TV / Chromecast with Google TV: same as Android TV —
    // ExoPlayer is the standard player.
}

/**
 * Roku adapter is implemented in BrightScript (see RokuAdapter.brs).
 * This file is a placeholder to document the approach.
 */
object RokuAdapterNotes {
    /**
     * Roku SceneGraph uses a Video component with observer callbacks.
     * The analytics adapter is implemented in BrightScript:
     *   - see sdk/smarttv/RokuAdapter.brs
     *
     * Key hooks:
     *   - m.video.observeField("state", "onVideoStateChange")
     *   - m.video.observeField("position", "onPositionChange")
     *   - state values: "buffering", "playing", "paused", "finished", "error"
     *   - HTTP requests via roUrlTransfer for batch posting
     */
    const val DOCS = "See sdk/smarttv/RokuAdapter.brs"
}
