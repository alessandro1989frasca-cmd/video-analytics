// AVPlayerAdapter.swift
// Hooks into AVPlayer/AVPlayerItem using:
//   - KVO on AVPlayer.status, AVPlayer.timeControlStatus, AVPlayer.currentItem
//   - KVO on AVPlayerItem.status, AVPlayerItem.isPlaybackBufferEmpty,
//             AVPlayerItem.isPlaybackLikelyToKeepUp, AVPlayerItem.isPlaybackBufferFull
//   - NotificationCenter for AVPlayerItem.didPlayToEndTime, AVPlayerItem.failedToPlayToEnd
//   - AVPlayerItem.accessLog() for CDN info, bitrate, and observed bitrate
//   - Periodic time observer for heartbeat position updates
//
// Design:
//   - KVO is always observed on the main thread and dispatched to a serial queue
//     to avoid any latency impact on the rendering pipeline
//   - Access log polling is done on the bg queue, not on the UI thread
//   - attach() / detach() are the only entry points for the integrator

import AVFoundation
import Foundation
import Network  // for NWPathMonitor (connection type)

public final class AVPlayerAdapter: NSObject {

    // MARK: - Public config

    public struct Options {
        /// The AVPlayer instance to observe
        public let player: AVPlayer
        /// Content metadata for this session
        public let content: AnalyticsContentInfo
        /// Analytics SDK config
        public let config: AnalyticsConfig
        /// Optional hashed user ID (SHA-256 of raw ID)
        public let userIdHash: String?
        /// Override CDN name. If nil, the adapter reads it from AVPlayerItemAccessLogEvent.
        public let cdnOverride: String?

        public init(player: AVPlayer,
                    content: AnalyticsContentInfo,
                    config: AnalyticsConfig,
                    userIdHash: String? = nil,
                    cdnOverride: String? = nil) {
            self.player = player
            self.content = content
            self.config = config
            self.userIdHash = userIdHash
            self.cdnOverride = cdnOverride
        }
    }

    // MARK: - Internal state

    private let options: Options
    private let sessionManager: AnalyticsSessionManager
    private let eventQueue: AnalyticsEventQueue
    private let bgQueue = DispatchQueue(label: "com.analytics.avplayer", qos: .utility)

    // KVO tokens
    private var playerStatusToken: NSKeyValueObservation?
    private var timeControlToken: NSKeyValueObservation?
    private var currentItemToken: NSKeyValueObservation?
    private var itemStatusToken: NSKeyValueObservation?
    private var bufferEmptyToken: NSKeyValueObservation?
    private var likelyToKeepUpToken: NSKeyValueObservation?

    // Periodic time observer
    private var timeObserver: Any? = nil

    // Notification tokens
    private var notificationTokens: [NSObjectProtocol] = []

    // Network path monitor
    private var pathMonitor: NWPathMonitor? = nil
    private var connectionType: AnalyticsConnectionType = .unknown

    // Access log tracking
    private var lastAccessLogEventCount = 0
    private var prevBitrateKbps: Double = 0
    private var prevResolution: String = "unknown"

    // State flags
    private var isBuffering = false
    private var wasPlaying = false
    private var liveJoinStart: Date? = nil

    // MARK: - Init

    public init(options: Options) {
        self.options = options
        self.eventQueue = AnalyticsEventQueue(config: options.config)
        self.sessionManager = AnalyticsSessionManager(config: options.config, queue: eventQueue)
        AnalyticsLogger.isDebug = options.config.debug
        super.init()
    }

    // MARK: - Lifecycle

    /// Attach the adapter: starts network monitoring, starts a session, registers all observers.
    public func attach() {
        startNetworkMonitor()

        sessionManager.startSession(
            content: options.content,
            player: makePlayerInfo(),
            network: makeNetworkInfo(),
            device: makeDeviceInfo(),
            autoplay: false,
            userIdHash: options.userIdHash
        )

        if options.content.type == .live {
            liveJoinStart = Date()
        }

        observePlayer()
        observeNotifications()
        startPeriodicTimeObserver()
    }

    /// Detach: removes all observers, ends the session, flushes events.
    public func detach() {
        removeAllObservers()
        sessionManager.endSession(reason: .user_stop)
        eventQueue.destroy()
        pathMonitor?.cancel()
    }

    // MARK: - Player KVO

    private func observePlayer() {
        let player = options.player

        playerStatusToken = player.observe(\.status, options: [.new]) { [weak self] player, _ in
            self?.bgQueue.async { self?.onPlayerStatus(player.status) }
        }

        timeControlToken = player.observe(\.timeControlStatus, options: [.new]) { [weak self] player, _ in
            self?.bgQueue.async { self?.onTimeControlStatus(player.timeControlStatus) }
        }

        currentItemToken = player.observe(\.currentItem, options: [.new, .old]) { [weak self] player, change in
            self?.bgQueue.async { self?.onCurrentItemChanged(player.currentItem) }
        }

        observePlayerItem(player.currentItem)
    }

    private func observePlayerItem(_ item: AVPlayerItem?) {
        guard let item else { return }

        itemStatusToken = item.observe(\.status, options: [.new]) { [weak self] item, _ in
            self?.bgQueue.async { self?.onItemStatus(item.status) }
        }

        bufferEmptyToken = item.observe(\.isPlaybackBufferEmpty, options: [.new]) { [weak self] item, _ in
            self?.bgQueue.async {
                if item.isPlaybackBufferEmpty {
                    self?.onBufferingStart()
                }
            }
        }

        likelyToKeepUpToken = item.observe(\.isPlaybackLikelyToKeepUp, options: [.new]) { [weak self] item, _ in
            self?.bgQueue.async {
                if item.isPlaybackLikelyToKeepUp {
                    self?.onBufferingEnd()
                }
            }
        }
    }

    // MARK: - KVO handlers

    private func onPlayerStatus(_ status: AVPlayer.Status) {
        switch status {
        case .readyToPlay:
            sessionManager.onPlayRequest()
        case .failed:
            let err = options.player.error
            sessionManager.onError(
                code: "AVPlayer.Status.failed",
                message: err?.localizedDescription ?? "AVPlayer failed",
                source: .player, fatal: true,
                vsfType: !sessionManager.hasFirstFrame ? "technical" : nil
            )
        default: break
        }
    }

    private func onTimeControlStatus(_ status: AVPlayer.TimeControlStatus) {
        switch status {
        case .playing:
            if !sessionManager.hasFirstFrame {
                // First time we enter .playing = first frame rendered
                sessionManager.onFirstFrame()
                if options.content.type == .live, let start = liveJoinStart {
                    let joinMs = Int(Date().timeIntervalSince(start) * 1000)
                    sessionManager.onJoinTime(ms: joinMs)
                    liveJoinStart = nil
                }
            }
            onBufferingEnd()
            wasPlaying = true

        case .paused:
            if wasPlaying {
                let pos = currentPosition()
                sessionManager.onPause(positionS: pos)
                wasPlaying = false
            }

        case .waitingToPlayAtSpecifiedRate:
            onBufferingStart()

        @unknown default: break
        }
    }

    private func onItemStatus(_ status: AVPlayerItem.Status) {
        if status == .failed {
            let err = options.player.currentItem?.error
            sessionManager.onError(
                code: "AVPlayerItem.Status.failed",
                message: err?.localizedDescription ?? "AVPlayerItem failed",
                source: .player, fatal: true,
                vsfType: !sessionManager.hasFirstFrame ? "technical" : nil
            )
        }
    }

    private func onCurrentItemChanged(_ newItem: AVPlayerItem?) {
        // Re-attach item-level KVO when a new item is loaded
        [itemStatusToken, bufferEmptyToken, likelyToKeepUpToken].forEach { $0?.invalidate() }
        observePlayerItem(newItem)
    }

    // MARK: - Buffering

    private func onBufferingStart() {
        guard !isBuffering else { return }
        isBuffering = true
        sessionManager.onBufferingStart(positionS: currentPosition(), cause: "network")
    }

    private func onBufferingEnd() {
        guard isBuffering else { return }
        isBuffering = false
        sessionManager.onBufferingEnd(positionS: currentPosition())
    }

    // MARK: - Notifications

    private func observeNotifications() {
        let center = NotificationCenter.default

        notificationTokens.append(
            center.addObserver(
                forName: .AVPlayerItemDidPlayToEndTime,
                object: options.player.currentItem, queue: nil
            ) { [weak self] _ in
                self?.bgQueue.async { self?.onPlayedToEnd() }
            }
        )

        notificationTokens.append(
            center.addObserver(
                forName: .AVPlayerItemFailedToPlayToEndTime,
                object: options.player.currentItem, queue: nil
            ) { [weak self] note in
                self?.bgQueue.async {
                    let err = note.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error
                    self?.sessionManager.onError(
                        code: "AVPlayerItemFailedToPlayToEndTime",
                        message: err?.localizedDescription ?? "Playback failed",
                        source: .player, fatal: true
                    )
                }
            }
        )

        notificationTokens.append(
            center.addObserver(
                forName: .AVPlayerItemPlaybackStalled,
                object: options.player.currentItem, queue: nil
            ) { [weak self] _ in
                self?.bgQueue.async { self?.onBufferingStart() }
            }
        )

        notificationTokens.append(
            center.addObserver(
                forName: .AVPlayerItemNewAccessLogEntry,
                object: options.player.currentItem, queue: nil
            ) { [weak self] _ in
                self?.bgQueue.async { self?.processAccessLog() }
            }
        )

        // App background — flush events before suspension
        notificationTokens.append(
            center.addObserver(
                forName: UIApplication.didEnterBackgroundNotification,
                object: nil, queue: nil
            ) { [weak self] _ in
                self?.eventQueue.flushSynchronous()
            }
        )

        notificationTokens.append(
            center.addObserver(
                forName: UIApplication.willTerminateNotification,
                object: nil, queue: nil
            ) { [weak self] _ in
                self?.sessionManager.endSession(reason: .user_stop)
                self?.eventQueue.flushSynchronous()
            }
        )
    }

    private func onPlayedToEnd() {
        sessionManager.endSession(reason: .completed)
    }

    // MARK: - AVPlayerItemAccessLog (CDN + bitrate)
    // This is the richest source of CDN and quality data on iOS.
    // Each AVPlayerItemAccessLogEvent covers one contiguous CDN segment download burst.

    private func processAccessLog() {
        guard let log = options.player.currentItem?.accessLog() else { return }
        let events = log.events

        guard events.count > lastAccessLogEventCount else { return }
        let newEvents = Array(events.dropFirst(lastAccessLogEventCount))
        lastAccessLogEventCount = events.count

        for event in newEvents {
            processAccessLogEvent(event)
        }
    }

    private func processAccessLogEvent(_ event: AVPlayerItemAccessLogEvent) {
        // ---- CDN info ----
        let cdnName = options.cdnOverride
            ?? guessCdn(from: event.uri ?? "")
            ?? "unknown"

        let bytes = event.numberOfBytesTransferred
        let durationMs = event.transferDuration * 1000  // s → ms
        let throughputKbps = durationMs > 0
            ? Double(bytes * 8) / durationMs
            : 0

        sessionManager.onCdnRequest(
            cdnName: cdnName,
            requestType: "segment",
            httpStatus: 200,         // access log doesn't expose HTTP status per segment
            ttfbMs: 0,               // not available via access log
            durationMs: durationMs,
            bytes: Int(bytes),
            throughputKbps: throughputKbps,
            sequenceNumber: nil
        )

        // ---- Bitrate ----
        // observedBitrate = actual download rate; indicatedBitrate = chosen rendition
        let observedKbps = event.observedBitrate / 1000
        let indicatedKbps = event.indicatedBitrate / 1000

        if indicatedKbps > 0 && abs(indicatedKbps - prevBitrateKbps) > 50 {
            // Rendition changed — compute resolution from video dimensions if available
            let newRes = videoResolution()
            sessionManager.onBitrateChange(
                prevKbps: prevBitrateKbps,
                newKbps: indicatedKbps,
                prevRes: prevResolution,
                newRes: newRes,
                reason: "auto",
                positionS: currentPosition()
            )
            prevBitrateKbps = indicatedKbps
            prevResolution = newRes
        }

        // Update current bitrate for heartbeat
        let reportedKbps = indicatedKbps > 0 ? indicatedKbps : observedKbps
        sessionManager.updatePlaybackPosition(
            currentPosition(),
            bitrateKbps: reportedKbps,
            resolution: videoResolution()
        )

        AnalyticsLogger.debug(
            "AccessLog: cdn=\(cdnName) observed=\(Int(observedKbps))kbps indicated=\(Int(indicatedKbps))kbps"
        )
    }

    // MARK: - Periodic time observer

    private func startPeriodicTimeObserver() {
        let interval = CMTime(seconds: 1.0, preferredTimescale: CMTimeScale(NSEC_PER_SEC))
        timeObserver = options.player.addPeriodicTimeObserver(
            forInterval: interval,
            queue: bgQueue
        ) { [weak self] time in
            guard let self else { return }
            let pos = CMTimeGetSeconds(time)
            self.sessionManager.updatePlaybackPosition(pos)
        }
    }

    // MARK: - Cleanup

    private func removeAllObservers() {
        [playerStatusToken, timeControlToken, currentItemToken,
         itemStatusToken, bufferEmptyToken, likelyToKeepUpToken].forEach { $0?.invalidate() }

        if let obs = timeObserver {
            options.player.removeTimeObserver(obs)
            timeObserver = nil
        }

        notificationTokens.forEach { NotificationCenter.default.removeObserver($0) }
        notificationTokens.removeAll()
    }

    // MARK: - Network monitor

    private func startNetworkMonitor() {
        let monitor = NWPathMonitor()
        pathMonitor = monitor
        monitor.pathUpdateHandler = { [weak self] path in
            self?.connectionType = {
                if path.usesInterfaceType(.wifi)     { return .wifi }
                if path.usesInterfaceType(.cellular) { return .cellular }
                if path.usesInterfaceType(.wiredEthernet) { return .ethernet }
                return .unknown
            }()
        }
        monitor.start(queue: bgQueue)
    }

    // MARK: - Metadata helpers

    private func currentPosition() -> Double {
        let time = options.player.currentTime()
        return CMTimeGetSeconds(time).isNaN ? 0 : CMTimeGetSeconds(time)
    }

    private func videoResolution() -> String {
        guard let item = options.player.currentItem else { return "unknown" }
        let size = item.presentationSize
        if size == .zero { return "unknown" }
        return "\(Int(size.width))x\(Int(size.height))"
    }

    private func makePlayerInfo() -> AnalyticsPlayerInfo {
        AnalyticsPlayerInfo(
            engine: .avplayer,
            engine_version: UIDevice.current.systemVersion,
            sdk_version: options.config.sdkVersion,
            autoplay: nil
        )
    }

    private func makeNetworkInfo() -> AnalyticsNetworkInfo {
        AnalyticsNetworkInfo(
            connection_type: connectionType,
            cdn: options.cdnOverride,
            bandwidth_kbps: nil
        )
    }

    private func makeDeviceInfo() -> AnalyticsDeviceInfo {
        let device = UIDevice.current
        let screen = UIScreen.main.bounds
        return AnalyticsDeviceInfo(
            os: "ios",
            os_version: device.systemVersion,
            model: deviceModel(),
            screen_resolution: "\(Int(screen.width))x\(Int(screen.height))",
            player_resolution: videoResolution()
        )
    }

    private func deviceModel() -> String {
        var systemInfo = utsname()
        uname(&systemInfo)
        return withUnsafeBytes(of: &systemInfo.machine) { bytes -> String in
            let str = bytes.bindMemory(to: CChar.self)
            return String(cString: str.baseAddress!)
        }
    }

    private func guessCdn(from urlString: String) -> String? {
        guard let host = URL(string: urlString)?.host?.lowercased() else { return nil }
        if host.contains("akamai") || host.contains("akamaized") { return "akamai" }
        if host.contains("cloudfront") { return "cloudfront" }
        if host.contains("fastly")     { return "fastly" }
        if host.contains("cloudflare") { return "cloudflare" }
        if host.contains("cdn77")      { return "cdn77" }
        return host
    }
}
