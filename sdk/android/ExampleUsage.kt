package com.example.player

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import com.analytics.sdk.AnalyticsConfig
import com.analytics.sdk.AnalyticsContentInfo
import com.analytics.sdk.AnalyticsContentType
import com.analytics.sdk.AnalyticsPlatform
import com.analytics.sdk.ExoPlayerAdapter
import com.google.android.exoplayer2.ExoPlayer
import com.google.android.exoplayer2.MediaItem
import com.google.android.exoplayer2.ui.StyledPlayerView

/**
 * Example Activity showing how to integrate ExoPlayerAdapter.
 * The adapter also implements DefaultLifecycleObserver, so registering it
 * with lifecycle.addObserver() handles attach/detach automatically.
 */
class PlayerActivity : AppCompatActivity() {

    private lateinit var player: ExoPlayer
    private lateinit var analyticsAdapter: ExoPlayerAdapter

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_player)

        // 1. Create ExoPlayer as usual
        player = ExoPlayer.Builder(this).build()
        val playerView = findViewById<StyledPlayerView>(R.id.player_view)
        playerView.player = player

        // 2. Set up analytics
        val content = AnalyticsContentInfo(
            contentId  = "live-rai2",
            type       = AnalyticsContentType.LIVE,
            title      = "RAI 2 Live",
            durationS  = null
        )
        val analyticsConfig = AnalyticsConfig(
            collectorUrl = "https://analytics.yourcompany.com/v1/collect",
            sdkVersion   = "1.0.0",
            platform     = AnalyticsPlatform.ANDROID,
            debug        = BuildConfig.DEBUG
        )

        analyticsAdapter = ExoPlayerAdapter(
            context     = this,
            player      = player,
            content     = content,
            config      = analyticsConfig
        )

        // 3. Register with lifecycle — auto attach on onStart, detach on onStop
        lifecycle.addObserver(analyticsAdapter)

        // 4. Load and play as normal
        val mediaItem = MediaItem.fromUri("https://cdn.example.com/live/rai2.m3u8")
        player.setMediaItem(mediaItem)
        player.prepare()
        player.playWhenReady = true
    }

    override fun onDestroy() {
        super.onDestroy()
        player.release()
    }
}
