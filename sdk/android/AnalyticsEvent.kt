package com.analytics.sdk

import org.json.JSONArray
import org.json.JSONObject

// ---------------------------------------------------------------------------
// Enumerations — mirror schema/events.ts
// ---------------------------------------------------------------------------

enum class AnalyticsPlatform(val value: String) {
    IOS("ios"), ANDROID("android"), WEB("web"),
    TVOS("tvos"), ANDROIDTV("androidtv"),
    TIZEN("tizen"), WEBOS("webos"), ROKU("roku"), UNKNOWN("unknown")
}

enum class AnalyticsContentType(val value: String) {
    LIVE("live"), VOD("vod")
}

enum class AnalyticsConnectionType(val value: String) {
    WIFI("wifi"), CELLULAR("cellular"), ETHERNET("ethernet"), UNKNOWN("unknown")
}

enum class AnalyticsPlayerEngine(val value: String) {
    EXOPLAYER("exoplayer"), MEDIA3("media3"), AVPLAYER("avplayer"),
    HLS_JS("hls.js"), DASH_JS("dash.js"), SHAKA("shaka"),
    NATIVE("native"), UNKNOWN("unknown")
}

enum class AnalyticsErrorSource(val value: String) {
    PLAYER("player"), NETWORK("network"), DRM("drm"), CDN("cdn"), UNKNOWN("unknown")
}

enum class AnalyticsSessionEndReason(val value: String) {
    COMPLETED("completed"), USER_STOP("user_stop"), ERROR("error"), UNKNOWN("unknown")
}

enum class AnalyticsEventType(val value: String) {
    SESSION_START("SESSION_START"), PLAY_REQUEST("PLAY_REQUEST"), FIRST_FRAME("FIRST_FRAME"),
    PAUSE("PAUSE"), RESUME("RESUME"), SEEK("SEEK"), STOP("STOP"),
    SESSION_END("SESSION_END"), HEARTBEAT("HEARTBEAT"),
    BUFFERING_START("BUFFERING_START"), BUFFERING_END("BUFFERING_END"),
    BITRATE_CHANGE("BITRATE_CHANGE"), ERROR("ERROR"),
    CDN_REQUEST("CDN_REQUEST"), CDN_SWITCH("CDN_SWITCH"),
    JOIN_TIME("JOIN_TIME"), LIVE_LATENCY("LIVE_LATENCY"), MANIFEST_ERROR("MANIFEST_ERROR"),
    AD_BREAK_START("AD_BREAK_START"), AD_BREAK_END("AD_BREAK_END"),
    AD_QUARTILE("AD_QUARTILE"), AD_ERROR("AD_ERROR")
}

// ---------------------------------------------------------------------------
// Sub-objects
// ---------------------------------------------------------------------------

data class AnalyticsContentInfo(
    val contentId: String,
    val type: AnalyticsContentType,
    val title: String,
    val durationS: Double?,
    val seriesId: String? = null
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("content_id", contentId)
        put("type", type.value)
        put("title", title)
        if (durationS != null) put("duration_s", durationS) else put("duration_s", JSONObject.NULL)
        seriesId?.let { put("series_id", it) }
    }
}

data class AnalyticsPlayerInfo(
    val engine: AnalyticsPlayerEngine,
    val engineVersion: String,
    val sdkVersion: String,
    val autoplay: Boolean? = null
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("engine", engine.value)
        put("engine_version", engineVersion)
        put("sdk_version", sdkVersion)
        autoplay?.let { put("autoplay", it) }
    }
}

data class AnalyticsNetworkInfo(
    val connectionType: AnalyticsConnectionType,
    val cdn: String? = null,
    val bandwidthKbps: Double? = null
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("connection_type", connectionType.value)
        cdn?.let { put("cdn", it) }
        bandwidthKbps?.let { put("bandwidth_kbps", it) }
    }
}

data class AnalyticsDeviceInfo(
    val os: String,
    val osVersion: String,
    val model: String,
    val screenResolution: String? = null,
    val playerResolution: String? = null
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("os", os)
        put("os_version", osVersion)
        put("model", model)
        screenResolution?.let { put("screen_resolution", it) }
        playerResolution?.let { put("player_resolution", it) }
    }
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

data class AnalyticsEvent(
    val sessionId: String,
    val eventType: AnalyticsEventType,
    val timestamp: Long,           // epoch ms
    val platform: AnalyticsPlatform,
    val content: AnalyticsContentInfo,
    val player: AnalyticsPlayerInfo,
    val network: AnalyticsNetworkInfo,
    val device: AnalyticsDeviceInfo,
    val seq: Int,
    val payload: JSONObject
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("session_id", sessionId)
        put("event_type", eventType.value)
        put("timestamp", timestamp)
        put("platform", platform.value)
        put("content", content.toJson())
        put("player", player.toJson())
        put("network", network.toJson())
        put("device", device.toJson())
        put("seq", seq)
        put("payload", payload)
    }
}

data class AnalyticsEventBatch(
    val sdkVersion: String,
    val sentAt: Long,
    val events: List<AnalyticsEvent>
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("sdk_version", sdkVersion)
        put("sent_at", sentAt)
        put("events", JSONArray().also { arr -> events.forEach { arr.put(it.toJson()) } })
    }
}
