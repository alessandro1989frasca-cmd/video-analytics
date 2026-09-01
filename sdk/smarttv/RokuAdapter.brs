' RokuAdapter.brs
' Roku SceneGraph analytics adapter — BrightScript
'
' Hooks into a Video SceneGraph node and maps Roku player events to the
' common analytics schema, then POSTs batches to the collector endpoint.
'
' Usage (in your Scene or VideoScreen component):
'   analytics = RokuAnalytics()
'   analytics.init({
'     collectorUrl: "https://analytics.yourcompany.com/v1/collect",
'     sdkVersion: "1.0.0",
'     contentId: "vod-123",
'     contentType: "vod",         ' "vod" or "live"
'     title: "Il Nome della Rosa",
'     durationS: 3600             ' omit or 0 for live
'   })
'   analytics.attachVideoNode(m.video)
'   ...
'   analytics.detach()
'
' BrightScript does not have classes; use an associative array as a namespace.

Function RokuAnalytics() As Object
    this = {}

    ' -------------------------------------------------------------------------
    ' Internal state
    ' -------------------------------------------------------------------------
    this._cfg = {}
    this._video = Invalid
    this._sessionId = ""
    this._seq = 0
    this._events = []
    this._hasFirstFrame = false
    this._playRequestAt = 0
    this._bufferingStartAt = 0
    this._isBuffering = false
    this._bufferingCountsAsRebuffer = false
    this._totalBufferingMs = 0.0
    this._bufferingCount = 0
    this._currentBitrateKbps = 0.0
    this._prevPosition = 0.0
    this._watchStartAt = 0
    this._pauseStartAt = 0

    ' -------------------------------------------------------------------------
    ' Public: init
    ' -------------------------------------------------------------------------
    this.init = Function(cfg As Object)
        m._cfg = cfg
        m._sessionId = CreateObject("roDeviceInfo").GetRandomUUID()
        m._seq = 0
        m._events = []
    End Function

    ' -------------------------------------------------------------------------
    ' Public: attachVideoNode
    ' Links observer callbacks to the SceneGraph Video node.
    ' -------------------------------------------------------------------------
    this.attachVideoNode = Function(videoNode As Object)
        m._video = videoNode

        ' Build device + network info
        deviceInfo = CreateObject("roDeviceInfo")
        displayInfo = CreateObject("roDeviceInfo")

        m._platform = "roku"
        m._deviceModel = deviceInfo.GetModelDisplayName()
        m._osVersion = deviceInfo.GetVersion()
        m._connectionType = m._getConnectionType(deviceInfo)

        ' SESSION_START
        m._emitSessionStart()

        ' Observe Video node fields
        videoNode.observeField("state",    "onVideoState")
        videoNode.observeField("position", "onPosition")
        videoNode.observeField("videoFormat", "onVideoFormat")

        ' Roku doesn't expose direct events for buffering; derive from state
    End Function

    ' -------------------------------------------------------------------------
    ' Public: detach
    ' -------------------------------------------------------------------------
    this.detach = Function()
        m._emitSessionEnd("user_stop")
        m._flush()
    End Function

    ' -------------------------------------------------------------------------
    ' Field observers (called by SceneGraph message port loop)
    ' Call these from your component's field observers:
    '   m.top.observeField("state", "onVideoState")
    '   Sub onVideoState() ... analytics.onVideoState(m.video.state) ... End Sub
    ' -------------------------------------------------------------------------
    this.onVideoState = Function(state As String)
        pos = m._video.position

        If state = "playing"
            If Not m._hasFirstFrame
                ' First time entering "playing" = first frame
                m._emitPlayRequest()
                m._emitFirstFrame()
                m._hasFirstFrame = true
                m._watchStartAt = m._nowMs()
            End If
            If m._isBuffering
                m._isBuffering = false
                durationMs = m._nowMs() - m._bufferingStartAt
                If m._bufferingCountsAsRebuffer
                    m._totalBufferingMs = m._totalBufferingMs + durationMs
                    m._bufferingCount = m._bufferingCount + 1
                End If
                m._bufferingCountsAsRebuffer = false
                m._emitBufferingEnd(pos, durationMs)
            End If

        Else If state = "buffering"
            If Not m._isBuffering
                m._isBuffering = true
                m._bufferingStartAt = m._nowMs()
                m._bufferingCountsAsRebuffer = m._hasFirstFrame
                cause = "initial"
                If m._hasFirstFrame Then cause = "network"
                m._emitBufferingStart(pos, cause)
            End If

        Else If state = "paused"
            m._pauseStartAt = m._nowMs()
            m._emitPause(pos)

        Else If state = "finished"
            m._emitSessionEnd("completed")
            m._flush()

        Else If state = "error"
            errorInfo = m._video.errorInfo
            code = ""
            msg = ""
            If Type(errorInfo) = "roAssociativeArray"
                code = errorInfo.ROKUPLAYER_ERROR_CODE
                msg  = errorInfo.ROKUPLAYER_ERROR_STRING
            End If
            m._emitError(code, msg, "player", true)
            m._emitSessionEnd("error")
            m._flush()
        End If

        ' Flush on threshold
        If m._events.Count() >= 20 Then m._flush()
    End Function

    this.onPosition = Function(position As Float)
        ' Heartbeat position update — the real heartbeat fires on a timer set
        ' up in the main message loop (see example below)
        m._prevPosition = position
    End Function

    this.onVideoFormat = Function()
        If m._video = Invalid Then Return
        fmt = m._video.videoFormat
        If Type(fmt) = "roAssociativeArray"
            bps = fmt.Bitrate
            If Type(bps) = "Integer" And bps > 0
                newKbps = bps / 1000.0
                If Abs(newKbps - m._currentBitrateKbps) > 100
                    m._emitBitrateChange(m._currentBitrateKbps, newKbps, m._prevPosition)
                    m._currentBitrateKbps = newKbps
                End If
            End If
        End If
    End Function

    ' Call this every 15s from your main message loop timer
    this.onHeartbeat = Function()
        If Not m._hasFirstFrame Then Return
        m._emitHeartbeat(m._prevPosition)
        If m._events.Count() > 0 Then m._flush()
    End Function

    ' -------------------------------------------------------------------------
    ' Internal emit helpers
    ' -------------------------------------------------------------------------
    this._emitSessionStart = Function()
        payload = {autoplay: false}
        m._push("SESSION_START", payload)
    End Function

    this._emitPlayRequest = Function()
        m._playRequestAt = m._nowMs()
        m._push("PLAY_REQUEST", {})
    End Function

    this._emitFirstFrame = Function()
        startupMs = m._nowMs() - m._playRequestAt
        m._push("FIRST_FRAME", {startup_time_ms: startupMs})
    End Function

    this._emitPause = Function(posS As Float)
        m._push("PAUSE", {playback_position_s: posS})
    End Function

    this._emitBufferingStart = Function(posS As Float, cause As String)
        m._push("BUFFERING_START", {playback_position_s: posS, cause: cause})
    End Function

    this._emitBufferingEnd = Function(posS As Float, durationMs As Float)
        m._push("BUFFERING_END", {playback_position_s: posS, buffering_duration_ms: durationMs})
    End Function

    this._emitBitrateChange = Function(prevKbps As Float, newKbps As Float, posS As Float)
        m._push("BITRATE_CHANGE", {
            previous_bitrate_kbps: prevKbps,
            new_bitrate_kbps: newKbps,
            previous_resolution: "unknown",
            new_resolution: "unknown",
            reason: "auto",
            playback_position_s: posS
        })
    End Function

    this._emitError = Function(code As String, msg As String, source As String, fatal As Boolean)
        m._push("ERROR", {
            error_code: code,
            error_message: msg,
            source: source,
            fatal: fatal
        })
    End Function

    this._emitHeartbeat = Function(posS As Float)
        m._push("HEARTBEAT", {
            playback_position_s: posS,
            current_bitrate_kbps: m._currentBitrateKbps,
            current_resolution: "unknown",
            is_buffering: m._isBuffering,
            rebuffer_time_ms: m._totalBufferingMs
        })
    End Function

    this._emitSessionEnd = Function(reason As String)
        watchTimeS = 0.0
        If m._watchStartAt > 0
            watchTimeS = (m._nowMs() - m._watchStartAt) / 1000.0
        End If
        m._push("SESSION_END", {
            watch_time_s: watchTimeS,
            completion_pct: Invalid,
            reason: reason,
            rebuffer_count: m._bufferingCount,
            rebuffer_time_s: m._totalBufferingMs / 1000.0,
            bitrate_change_count: 0
        })
    End Function

    ' -------------------------------------------------------------------------
    ' Internal: push event to queue
    ' -------------------------------------------------------------------------
    this._push = Function(eventType As String, payload As Object)
        m._seq = m._seq + 1
        event = {
            session_id: m._sessionId,
            event_type: eventType,
            timestamp: m._nowMs(),
            platform: "roku",
            seq: m._seq,
            content: {
                content_id: m._cfg.contentId,
                type: m._cfg.contentType,
                title: m._cfg.title,
                duration_s: m._cfg.durationS
            },
            player: {
                engine: "native",
                engine_version: m._osVersion,
                sdk_version: m._cfg.sdkVersion
            },
            network: {
                connection_type: m._connectionType
            },
            device: {
                os: "roku",
                os_version: m._osVersion,
                model: m._deviceModel
            },
            payload: payload
        }
        m._events.Push(event)
    End Function

    ' -------------------------------------------------------------------------
    ' Internal: HTTP flush via roUrlTransfer
    ' -------------------------------------------------------------------------
    this._flush = Function()
        If m._events.Count() = 0 Then Return

        batch = {
            sdk_version: m._cfg.sdkVersion,
            sent_at: m._nowMs(),
            events: m._events
        }
        m._events = []

        url = CreateObject("roUrlTransfer")
        url.SetUrl(m._cfg.collectorUrl)
        url.AddHeader("Content-Type", "application/json")
        url.SetRequest("POST")

        ' FormatJSON serialises the AA to a JSON string
        body = FormatJSON(batch)
        url.AsyncPostFromString(body)
        ' Fire-and-forget — Roku's roUrlTransfer doesn't block
    End Function

    ' -------------------------------------------------------------------------
    ' Helpers
    ' -------------------------------------------------------------------------
    this._nowMs = Function() As LongInteger
        ts = CreateObject("roDateTime")
        Return ts.AsSeconds() * 1000
    End Function

    this._getConnectionType = Function(deviceInfo As Object) As String
        connType = deviceInfo.GetConnectionType()
        If connType = "WiFiConnection"   Then Return "wifi"
        If connType = "WiredConnection"  Then Return "ethernet"
        Return "unknown"
    End Function

    Return this
End Function
