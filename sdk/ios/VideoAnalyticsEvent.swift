// VideoAnalyticsEvent.swift
// Mirrors the shared JSON schema (schema/events.ts) in Swift.
// All types here must stay in sync with the TypeScript schema.

import Foundation

// MARK: - Enumerations

public enum AnalyticsPlatform: String, Codable {
    case ios, tvos, androidtv, android, web, tizen, webos, roku, unknown
}

public enum AnalyticsContentType: String, Codable {
    case live, vod
}

public enum AnalyticsConnectionType: String, Codable {
    case wifi, cellular, ethernet, unknown
}

public enum AnalyticsPlayerEngine: String, Codable {
    case avplayer, hlsJs = "hls.js", dashJs = "dash.js", shaka, exoplayer, media3, native, unknown
}

public enum AnalyticsErrorSource: String, Codable {
    case player, network, drm, cdn, unknown
}

public enum AnalyticsSessionEndReason: String, Codable {
    case completed, user_stop, error, unknown
}

public enum AnalyticsEventType: String, Codable {
    case SESSION_START, PLAY_REQUEST, FIRST_FRAME
    case PAUSE, RESUME, SEEK, STOP, SESSION_END, HEARTBEAT
    case BUFFERING_START, BUFFERING_END
    case BITRATE_CHANGE
    case ERROR
    case CDN_REQUEST, CDN_SWITCH
    case JOIN_TIME, LIVE_LATENCY, MANIFEST_ERROR
    case AD_BREAK_START, AD_BREAK_END, AD_QUARTILE, AD_ERROR
}

// MARK: - Sub-objects (envelope sections)

public struct AnalyticsContentInfo: Codable {
    public let content_id: String
    public let type: AnalyticsContentType
    public let title: String
    public let duration_s: Double?
    public let series_id: String?

    public init(contentId: String, type: AnalyticsContentType, title: String,
                durationS: Double? = nil, seriesId: String? = nil) {
        self.content_id = contentId
        self.type = type
        self.title = title
        self.duration_s = durationS
        self.series_id = seriesId
    }
}

public struct AnalyticsPlayerInfo: Codable {
    public let engine: AnalyticsPlayerEngine
    public let engine_version: String
    public let sdk_version: String
    public let autoplay: Bool?
}

public struct AnalyticsNetworkInfo: Codable {
    public let connection_type: AnalyticsConnectionType
    public let cdn: String?
    public let bandwidth_kbps: Double?
}

public struct AnalyticsDeviceInfo: Codable {
    public let os: String
    public let os_version: String
    public let model: String
    public let screen_resolution: String?
    public let player_resolution: String?
}

// MARK: - Event envelope

/// The full event envelope sent in each batch item.
public struct AnalyticsEvent: Codable {
    public let session_id: String
    public let event_type: AnalyticsEventType
    public let timestamp: Int64          // epoch ms
    public let platform: AnalyticsPlatform
    public let content: AnalyticsContentInfo
    public let player: AnalyticsPlayerInfo
    public let network: AnalyticsNetworkInfo
    public let device: AnalyticsDeviceInfo
    public let seq: Int
    public let payload: AnyCodable       // event-specific, see payloads below
}

/// Top-level batch sent to the collector endpoint.
public struct AnalyticsEventBatch: Codable {
    public let sdk_version: String
    public let sent_at: Int64            // epoch ms
    public let events: [AnalyticsEvent]
}

// MARK: - AnyCodable helper
// Allows arbitrary JSON payloads without defining every field statically.

public struct AnyCodable: Codable {
    public let value: Any

    public init(_ value: Any) { self.value = value }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let dict = try? container.decode([String: AnyCodable].self) {
            value = dict.mapValues { $0.value }
        } else if let array = try? container.decode([AnyCodable].self) {
            value = array.map { $0.value }
        } else if let str = try? container.decode(String.self) { value = str }
        else if let int = try? container.decode(Int.self)       { value = int }
        else if let dbl = try? container.decode(Double.self)    { value = dbl }
        else if let bool = try? container.decode(Bool.self)     { value = bool }
        else { value = NSNull() }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case let dict as [String: Any]:
            try container.encode(dict.mapValues { AnyCodable($0) })
        case let arr as [Any]:
            try container.encode(arr.map { AnyCodable($0) })
        case let str as String:   try container.encode(str)
        case let int as Int:      try container.encode(int)
        case let dbl as Double:   try container.encode(dbl)
        case let bool as Bool:    try container.encode(bool)
        default:                  try container.encodeNil()
        }
    }
}
