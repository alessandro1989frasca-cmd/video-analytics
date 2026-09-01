// ExampleUsage.swift
// Shows how to wire AVPlayerAdapter into a typical UIViewController.
// Not part of the production SDK — for reference only.

import AVFoundation
import UIKit

class VideoPlayerViewController: UIViewController {

    private var player: AVPlayer!
    private var analyticsAdapter: AVPlayerAdapter!

    private let analyticsConfig = AnalyticsConfig(
        collectorUrl: "https://analytics.yourcompany.com/v1/collect",
        sdkVersion: "1.0.0",
        platform: .ios
    )

    override func viewDidLoad() {
        super.viewDidLoad()

        // 1. Create the AVPlayer as normal
        let url = URL(string: "https://cdn.example.com/live/channel1.m3u8")!
        player = AVPlayer(url: url)

        // 2. Create and attach the analytics adapter
        let content = AnalyticsContentInfo(
            contentId: "live-rai1",
            type: .live,
            title: "RAI 1 Live",
            durationS: nil
        )

        let options = AVPlayerAdapter.Options(
            player: player,
            content: content,
            config: analyticsConfig,
            userIdHash: nil  // pass pre-hashed user ID here if available
        )

        analyticsAdapter = AVPlayerAdapter(options: options)
        analyticsAdapter.attach()

        // 3. Set up AVPlayerLayer and start playback as usual
        let playerLayer = AVPlayerLayer(player: player)
        playerLayer.frame = view.bounds
        view.layer.addSublayer(playerLayer)

        player.play()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        // Detach cleans up observers, ends session, and flushes events
        analyticsAdapter.detach()
    }

    // Seeking (VOD)
    @IBAction func seekTo(_ sender: UISlider) {
        let targetTime = CMTime(seconds: Double(sender.value), preferredTimescale: 600)
        player.seek(to: targetTime)
        // Note: seek events are derived from AVPlayer.currentItem KVO in the adapter.
        // No manual call needed here.
    }
}
