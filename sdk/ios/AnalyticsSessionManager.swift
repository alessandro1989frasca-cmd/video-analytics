// AnalyticsSessionManager.swift
// iOS/tvOS port of the core SessionManager logic.
// Owns session state, computes derived metrics, fires heartbeats.
// Delegates transport to AnalyticsEventQueue.

import Foundation

public final class AnalyticsSessionManager {

    // MARK: - Session state

    private(set) var sessionId: String = ""
    private(set) var seq: Int = 0
    private(set) var hasFirstFrame: Bool = false
    private(set) var playbackPositionS: Double = 0
    private(set) var currentBitrateKbps: Double = 0
    private(set) var currentResolution: String = "unknown"

    private var playRequestAt: Date? = nil
    private var firstFrameAt: Date? = nil
    private var bufferingStartAt: Date? = nil
    private var totalBufferingMs: Double = 0
    private var bufferingCount: Int = 0
    private var bitrateChangeCount: Int = 0
    private var pauseStartAt: Date? = nil
    private var isSessionActive: Bool = false

    // Zombie watchdog
    private var zombieTimer: Timer? = nil
    private var heartbeatTimer: Timer? = nil

    // Config
    private let config: AnalyticsConfig
    private let queue: AnalyticsEventQueue
    private var contentInfo: AnalyticsContentInfo!
    private var playerInfo: AnalyticsPlayerInfo!
    private var networkInfo: AnalyticsNetworkInfo!
    private var deviceInfo: AnalyticsDeviceInfo!

    public init(config: AnalyticsConfig, queue: AnalyticsEventQueue) {
        self.config = config
        self.queue = queue
    }

    // MARK: - Session lifecycle

    @discardableResult
    public func startSession(
        content: AnalyticsContentInfo,
        player: AnalyticsPlayerInfo,
        network: AnalyticsNetworkInfo,
        device: AnalyticsDeviceInfo,
        autoplay: Bool,
        userIdHash: String? = nil
    ) -> String {
        if isSessionActive {
            endSession(reason: .unknown)
        }

        sessionId = UUID().uuidString.lowercased()
        seq = 0
        hasFirstFrame = false
        playbackPositionS = 0
        currentBitrateKbps = 0
        currentResolution = "unknown"
        playRequestAt = nil
        firstFrameAt = nil
        bufferingStartAt = nil
        totalBufferingMs = 0
        bufferingCount = 0
        bitrateChangeCount = 0
        pauseStartAt = nil
        isSessionActive = true

        self.contentInfo = content
        self.playerInfo = player
        self.networkInfo = network
        self.deviceInfo = device

        var payload: [String: Any] = ["autoplay": autoplay]
        if let hash = userIdHash { payload["user_id_hash"] = hash }

        emitEvent(type: .SESSION_START, payload: payload)
        resetZombieTimer()

        AnalyticsLogger.debug("Session started: \(sessionId)")
        return sessionId
    }

    public func onPlayRequest(startPositionS: Double? = nil) {
        guard isSessionActive else { return }
        playRequestAt = Date()
        var payload: [String: Any] = [:]
        if let pos = startPositionS { payload["start_position_s"] = pos }
        emitEvent(type: .PLAY_REQUEST, payload: payload)
        resetZombieTimer()
    }

    public func onFirstFrame() {
        guard isSessionActive, !hasFirstFrame else { return }
        let startupMs = playRequestAt.map { Int(Date().timeIntervalSince($0) * 1000) } ?? 0
        firstFrameAt = Date()
        hasFirstFrame = true
        emitEvent(type: .FIRST_FRAME, payload: ["startup_time_ms": startupMs])
        startHeartbeat()
        resetZombieTimer()
        AnalyticsLogger.debug("First frame — startup: \(startupMs)ms")
    }

    public func onPause(positionS: Double) {
        guard isSessionActive else { return }
        pauseStartAt = Date()
        playbackPositionS = positionS
        emitEvent(type: .PAUSE, payload: ["playback_position_s": positionS])
        resetZombieTimer()
    }

    public func onResume(positionS: Double) {
        guard isSessionActive else { return }
        let pauseMs = pauseStartAt.map { Int(Date().timeIntervalSince($0) * 1000) } ?? 0
        pauseStartAt = nil
        playbackPositionS = positionS
        emitEvent(type: .RESUME, payload: [
            "playback_position_s": positionS,
            "pause_duration_ms": pauseMs
        ])
        resetZombieTimer()
    }

    public func onSeek(fromS: Double, toS: Double) {
        guard isSessionActive else { return }
        playbackPositionS = toS
        emitEvent(type: .SEEK, payload: ["from_position_s": fromS, "to_position_s": toS])
        resetZombieTimer()
    }

    public func onBufferingStart(positionS: Double, cause: String = "unknown") {
        guard isSessionActive, bufferingStartAt == nil else { return }
        bufferingStartAt = Date()
        emitEvent(type: .BUFFERING_START, payload: [
            "playback_position_s": positionS,
            "cause": cause
        ])
        resetZombieTimer()
    }

    public func onBufferingEnd(positionS: Double) {
        guard isSessionActive, let start = bufferingStartAt else { return }
        let durationMs = Date().timeIntervalSince(start) * 1000
        totalBufferingMs += durationMs
        bufferingCount += 1
        bufferingStartAt = nil
        emitEvent(type: .BUFFERING_END, payload: [
            "playback_position_s": positionS,
            "buffering_duration_ms": Int(durationMs)
        ])
        resetZombieTimer()
    }

    public func onBitrateChange(
        prevKbps: Double, newKbps: Double,
        prevRes: String, newRes: String,
        reason: String = "auto",
        positionS: Double,
        codec: String? = nil
    ) {
        guard isSessionActive else { return }
        currentBitrateKbps = newKbps
        currentResolution = newRes
        bitrateChangeCount += 1
        var payload: [String: Any] = [
            "previous_bitrate_kbps": prevKbps,
            "new_bitrate_kbps": newKbps,
            "previous_resolution": prevRes,
            "new_resolution": newRes,
            "reason": reason,
            "playback_position_s": positionS
        ]
        if let c = codec { payload["codec"] = c }
        emitEvent(type: .BITRATE_CHANGE, payload: payload)
        resetZombieTimer()
    }

    public func onError(
        code: String, message: String,
        source: AnalyticsErrorSource,
        fatal: Bool,
        vsfType: String? = nil,
        isEbvs: Bool? = nil,
        positionS: Double? = nil,
        httpStatus: Int? = nil
    ) {
        guard isSessionActive else { return }
        var payload: [String: Any] = [
            "error_code": code,
            "error_message": message,
            "source": source.rawValue,
            "fatal": fatal
        ]
        if let v = vsfType   { payload["vsf_type"] = v }
        if let e = isEbvs    { payload["is_ebvs"] = e }
        if let p = positionS { payload["playback_position_s"] = p }
        if let h = httpStatus{ payload["http_status"] = h }
        emitEvent(type: .ERROR, payload: payload)
        if fatal { endSession(reason: .error) }
    }

    public func onCdnRequest(
        cdnName: String, requestType: String,
        httpStatus: Int, ttfbMs: Double, durationMs: Double,
        bytes: Int, throughputKbps: Double,
        sequenceNumber: Int? = nil
    ) {
        guard isSessionActive else { return }
        var payload: [String: Any] = [
            "cdn_name": cdnName,
            "request_type": requestType,
            "http_status": httpStatus,
            "ttfb_ms": ttfbMs,
            "duration_ms": durationMs,
            "bytes": bytes,
            "throughput_kbps": throughputKbps
        ]
        if let seq = sequenceNumber { payload["sequence_number"] = seq }
        emitEvent(type: .CDN_REQUEST, payload: payload)
    }

    public func onCdnSwitch(from: String, to: String, reason: String,
                             positionS: Double, triggerHttpStatus: Int? = nil) {
        guard isSessionActive else { return }
        var payload: [String: Any] = [
            "cdn_from": from, "cdn_to": to,
            "reason": reason, "playback_position_s": positionS
        ]
        if let s = triggerHttpStatus { payload["trigger_http_status"] = s }
        emitEvent(type: .CDN_SWITCH, payload: payload)
    }

    public func onJoinTime(ms: Int) {
        guard isSessionActive else { return }
        emitEvent(type: .JOIN_TIME, payload: ["join_time_ms": ms])
    }

    public func onLiveLatency(latencyS: Double, positionS: Double, targetLatencyS: Double? = nil) {
        guard isSessionActive else { return }
        var payload: [String: Any] = ["latency_s": latencyS, "playback_position_s": positionS]
        if let t = targetLatencyS { payload["target_latency_s"] = t }
        emitEvent(type: .LIVE_LATENCY, payload: payload)
    }

    public func onManifestError(httpStatus: Int, retryCount: Int, fatal: Bool) {
        guard isSessionActive else { return }
        emitEvent(type: .MANIFEST_ERROR, payload: [
            "http_status": httpStatus,
            "retry_count": retryCount,
            "fatal": fatal
        ])
    }

    public func updatePlaybackPosition(_ positionS: Double,
                                        bitrateKbps: Double? = nil,
                                        resolution: String? = nil) {
        playbackPositionS = positionS
        if let b = bitrateKbps  { currentBitrateKbps = b }
        if let r = resolution    { currentResolution = r }
    }

    public func endSession(reason: AnalyticsSessionEndReason) {
        guard isSessionActive else { return }
        stopHeartbeat()
        cancelZombieTimer()

        if bufferingStartAt != nil {
            onBufferingEnd(positionS: playbackPositionS)
        }

        let watchTimeS: Double
        if let ff = firstFrameAt {
            watchTimeS = Date().timeIntervalSince(ff)
        } else {
            watchTimeS = 0
        }

        let completionPct: Double?
        if contentInfo.type == .vod, let dur = contentInfo.duration_s, dur > 0 {
            completionPct = min(100.0, (playbackPositionS / dur) * 100.0)
        } else {
            completionPct = nil
        }

        var payload: [String: Any] = [
            "watch_time_s": watchTimeS,
            "reason": reason.rawValue,
            "rebuffer_count": bufferingCount,
            "rebuffer_time_s": totalBufferingMs / 1000.0,
            "bitrate_change_count": bitrateChangeCount
        ]
        if let pct = completionPct { payload["completion_pct"] = pct }
        else { payload["completion_pct"] = NSNull() }

        emitEvent(type: .SESSION_END, payload: payload)
        isSessionActive = false
        AnalyticsLogger.debug("Session ended: \(sessionId), reason: \(reason.rawValue)")
    }

    // MARK: - Heartbeat

    private func startHeartbeat() {
        guard config.heartbeatIntervalMs > 0, heartbeatTimer == nil else { return }
        let interval = TimeInterval(config.heartbeatIntervalMs) / 1000.0
        heartbeatTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            self?.emitHeartbeat()
        }
    }

    private func stopHeartbeat() {
        heartbeatTimer?.invalidate()
        heartbeatTimer = nil
    }

    private func emitHeartbeat() {
        guard isSessionActive else { return }
        emitEvent(type: .HEARTBEAT, payload: [
            "playback_position_s": playbackPositionS,
            "current_bitrate_kbps": currentBitrateKbps,
            "current_resolution": currentResolution,
            "is_buffering": bufferingStartAt != nil,
            "rebuffer_time_ms": totalBufferingMs
        ])
    }

    // MARK: - Zombie watchdog

    private func resetZombieTimer() {
        cancelZombieTimer()
        let timeout = TimeInterval(config.heartbeatIntervalMs * 2 + 5000) / 1000.0
        zombieTimer = Timer.scheduledTimer(withTimeInterval: timeout, repeats: false) { [weak self] _ in
            AnalyticsLogger.warn("Zombie session detected — auto-closing")
            self?.endSession(reason: .unknown)
        }
    }

    private func cancelZombieTimer() {
        zombieTimer?.invalidate()
        zombieTimer = nil
    }

    // MARK: - Internal emit

    private func emitEvent(type: AnalyticsEventType, payload: [String: Any]) {
        guard isSessionActive || type == .SESSION_END else { return }
        seq += 1

        let event = AnalyticsEvent(
            session_id: sessionId,
            event_type: type,
            timestamp: Int64(Date().timeIntervalSince1970 * 1000),
            platform: config.platform,
            content: contentInfo,
            player: playerInfo,
            network: networkInfo,
            device: deviceInfo,
            seq: seq,
            payload: AnyCodable(payload)
        )
        queue.enqueue(event)
    }
}
