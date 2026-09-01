# Smart TV / OTT Platform Notes

Quick reference for each platform's SDK integration path and known quirks.

---

## Samsung Tizen

| Firmware | Engine | SDK to use |
|---|---|---|
| Tizen 3–4 (2017–18) | AVPlay (mandatory) | `TizenAdapter` |
| Tizen 5+ (2019+) | AVPlay **or** HTML5 `<video>` | `TizenAdapter` or `HlsJsAdapter` with `platform:'tizen'` |
| Tizen 6+ (2021+) | HTML5 preferred | `HlsJsAdapter` / `ShakaAdapter` |

**Key AVPlay quirks**
- `prepareAsync` must complete before `play()` — the adapter handles this.
- `getStreamingProperty('CURRENT_BANDWIDTH')` returns bps as a string; the adapter converts and polls every 5 s.
- `PLAYER_MSG_BITRATE_INFO` event fires on some firmware but not all — the bitrate poller is the reliable fallback.
- `oncurrentplaytime` fires every ~200 ms and is the only reliable position source.
- No per-segment HTTP metrics — `PLAYER_MSG_FRAGMENT_INFO` provides partial info (url, size, download time) on Tizen 5+.

---

## LG webOS

| Firmware | Engine | SDK to use |
|---|---|---|
| webOS 3.x (2016–17) | HTML5 `<video>` (Chromium 38) | `WebOsAdapter` — limited MSE support |
| webOS 4.x (2018–19) | HTML5 `<video>` (Chromium 53) | `WebOsAdapter` or `HlsJsAdapter` |
| webOS 5+ (2020+) | HTML5 `<video>` (Chromium 79+) | Any web adapter; ShakaAdapter recommended |

**Key webOS quirks**
- `webOSDev.device` is available in webOS SDK apps; not available in cast/browser mode.
- `webkitplaybacktargetavailabilitychanged` fires on quality changes but is not universally supported.
- The `VideoTracks` API is the best source of bitrate info; poll it after each quality change event.
- For live low-latency streams, webOS 5+ supports LL-HLS but requires `fetchpriority` header hints.

---

## Android TV / Fire TV / Google TV

Use the **Android SDK** (`ExoPlayerAdapter`) with `platform: ANDROIDTV`.

`AndroidTvAdapter.kt` wraps `ExoPlayerAdapter` with the correct platform enum.

**Amazon Fire TV specifics**
- For Fire TV Stick (Gen 1/2) with ExoPlayer 2.x: use ExoPlayer's `DefaultBandwidthMeter` for bandwidth estimates.
- Amazon provides an `AmazonHLSPlayer` extension for advanced HLS features; it exposes the same `AnalyticsListener` interface.

**Google TV / Chromecast with Google TV**
- Identical to standard Android TV. Google's `MediaBrowserService` pattern doesn't change the player API.

---

## Roku

Use **`RokuAdapter.brs`** (BrightScript).

**Integration steps**

1. Copy `RokuAdapter.brs` into your Roku channel's `components/` directory.
2. In your video screen component:
```brightscript
analytics = RokuAnalytics()
analytics.init({
  collectorUrl: "https://analytics.yourcompany.com/v1/collect",
  sdkVersion: "1.0.0",
  contentId: "vod-123",
  contentType: "vod",
  title: "My Content",
  durationS: 3600
})
analytics.attachVideoNode(m.video)
```

3. In your main message loop, fire the heartbeat:
```brightscript
heartbeatTimer = CreateObject("roSGNode", "Timer")
heartbeatTimer.duration = 15
heartbeatTimer.repeat = true
heartbeatTimer.observeField("fire", "onHeartbeat")
heartbeatTimer.control = "start"

Sub onHeartbeat()
  m.analytics.onHeartbeat()
End Sub
```

**Roku quirks**
- `roUrlTransfer` is fire-and-forget; there's no async success/failure callback in older firmware.
  For Roku OS 9.2+, use `AsyncPostFromString` with a message port for retry capability.
- `FormatJSON` is the only JSON serialiser available natively; deeply nested objects are supported.
- The `roDateTime.AsSeconds()` precision is 1s on older firmware; multiply by 1000 for epoch-ms approximation.
- Roku SceneGraph `Video` component state transitions:
  `buffering → playing → paused → playing → finished`

---

## General OTT / IPTV (Linux-based STBs)

For embedded Linux STBs (Nagra, Amino, Arris, etc.) running a browser-based UI:

- If the player is inside a WebKit/Chromium WebView: use the **Web SDK** (`HlsJsAdapter` or `ShakaAdapter`), set `platform:'unknown'` or negotiate a custom value with your platform team.
- If the player is a native GStreamer or ffmpeg pipeline: implement a thin HTTP client that POSTs batches to the collector endpoint directly, using the `AnalyticsEventBatch` JSON schema.
- For GStreamer, hook into `gst-bus` messages: `GST_MESSAGE_STATE_CHANGED`, `GST_MESSAGE_BUFFERING`, `GST_MESSAGE_ERROR`.

---

## CDN detection on Smart TVs

Smart TV players rarely expose per-request HTTP metadata. Strategies by platform:

| Platform | CDN detection method |
|---|---|
| Tizen AVPlay | Parse `PLAYER_MSG_FRAGMENT_INFO` event data (URL field) |
| webOS | Intercept `XMLHttpRequest` in JS layer or use a service worker (webOS 5+) |
| Android TV | `onLoadCompleted` in ExoPlayer `AnalyticsListener` (URL available) |
| Roku | `roUrlTransfer` wraps each request; CDN can be inferred from URL if available |

For multi-CDN environments, the recommended approach is to **inject the CDN name into the manifest** as a comment or custom HLS tag (`#EXT-X-SESSION-DATA`), parse it at startup, and pass it as `cdnOverride` to the adapter.
