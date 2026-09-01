/**
 * JSON Schema for EventBatch — used by the backend collector for validation (Ajv).
 * Exported as a TypeScript constant so it can be imported directly without a file read.
 *
 * Draft-07 compatible. Validates both the outer batch envelope and each individual event.
 */

export const EVENT_BATCH_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://analytics.internal/schemas/event-batch.json',
  title: 'EventBatch',
  type: 'object',
  required: ['sdk_version', 'sent_at', 'events'],
  additionalProperties: false,
  properties: {
    sdk_version: { type: 'string', minLength: 1 },
    sent_at:     { type: 'integer', minimum: 0 },
    events: {
      type: 'array',
      minItems: 1,
      maxItems: 500,
      items: { $ref: '#/definitions/AnalyticsEvent' }
    }
  },

  definitions: {

    Platform: {
      type: 'string',
      enum: ['web', 'ios', 'android', 'tvos', 'androidtv', 'tizen', 'webos', 'roku', 'unknown']
    },

    ContentType: { type: 'string', enum: ['live', 'vod'] },

    ConnectionType: {
      type: 'string',
      enum: ['wifi', 'cellular', 'ethernet', 'unknown']
    },

    PlayerEngine: {
      type: 'string',
      enum: ['hls.js', 'dash.js', 'shaka', 'exoplayer', 'media3', 'avplayer', 'native', 'unknown']
    },

    ErrorSource: {
      type: 'string',
      enum: ['player', 'network', 'drm', 'cdn', 'unknown']
    },

    SessionEndReason: {
      type: 'string',
      enum: ['completed', 'user_stop', 'error', 'unknown']
    },

    ContentInfo: {
      type: 'object',
      required: ['content_id', 'type', 'title', 'duration_s'],
      additionalProperties: false,
      properties: {
        content_id: { type: 'string', minLength: 1 },
        type:       { $ref: '#/definitions/ContentType' },
        title:      { type: 'string' },
        duration_s: { type: ['number', 'null'] },
        series_id:  { type: 'string' }
      }
    },

    PlayerInfo: {
      type: 'object',
      required: ['engine', 'engine_version', 'sdk_version'],
      additionalProperties: false,
      properties: {
        engine:          { $ref: '#/definitions/PlayerEngine' },
        engine_version:  { type: 'string' },
        sdk_version:     { type: 'string' },
        autoplay:        { type: 'boolean' }
      }
    },

    NetworkInfo: {
      type: 'object',
      required: ['connection_type'],
      additionalProperties: false,
      properties: {
        connection_type: { $ref: '#/definitions/ConnectionType' },
        cdn:             { type: 'string' },
        bandwidth_kbps:  { type: 'number', minimum: 0 }
      }
    },

    DeviceInfo: {
      type: 'object',
      required: ['os', 'os_version', 'model'],
      additionalProperties: false,
      properties: {
        os:                { type: 'string' },
        os_version:        { type: 'string' },
        model:             { type: 'string' },
        screen_resolution: { type: 'string' },
        player_resolution: { type: 'string' }
      }
    },

    // Individual event: the payload is kept as open `object` here.
    // Per-event payload shapes are validated in application code via the
    // PAYLOAD_SCHEMAS map below, after the event_type is known.
    AnalyticsEvent: {
      type: 'object',
      required: [
        'session_id', 'event_type', 'timestamp', 'platform',
        'content', 'player', 'network', 'device', 'seq', 'payload'
      ],
      additionalProperties: false,
      properties: {
        session_id: { type: 'string', format: 'uuid' },
        event_type: {
          type: 'string',
          enum: [
            'SESSION_START', 'PLAY_REQUEST', 'FIRST_FRAME',
            'PAUSE', 'RESUME', 'SEEK', 'STOP', 'SESSION_END', 'HEARTBEAT',
            'BUFFERING_START', 'BUFFERING_END',
            'BITRATE_CHANGE',
            'ERROR',
            'CDN_REQUEST', 'CDN_SWITCH',
            'JOIN_TIME', 'LIVE_LATENCY', 'MANIFEST_ERROR',
            'AD_BREAK_START', 'AD_BREAK_END', 'AD_QUARTILE', 'AD_ERROR'
          ]
        },
        timestamp:  { type: 'integer', minimum: 0 },
        platform:   { $ref: '#/definitions/Platform' },
        content:    { $ref: '#/definitions/ContentInfo' },
        player:     { $ref: '#/definitions/PlayerInfo' },
        network:    { $ref: '#/definitions/NetworkInfo' },
        device:     { $ref: '#/definitions/DeviceInfo' },
        seq:        { type: 'integer', minimum: 1 },
        payload:    { type: 'object' }
      }
    }
  }
} as const;

// ---------------------------------------------------------------------------
// Per-event payload schemas — validated after event_type dispatch
// ---------------------------------------------------------------------------

export const PAYLOAD_SCHEMAS: Record<string, object> = {

  SESSION_START: {
    type: 'object', required: ['autoplay'],
    properties: {
      autoplay:     { type: 'boolean' },
      user_id_hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      page_url:     { type: 'string', maxLength: 2048 }
    },
    additionalProperties: false
  },

  PLAY_REQUEST: {
    type: 'object',
    properties: {
      start_position_s: { type: 'number', minimum: 0 }
    },
    additionalProperties: false
  },

  FIRST_FRAME: {
    type: 'object', required: ['startup_time_ms'],
    properties: {
      startup_time_ms: { type: 'integer', minimum: 0 }
    },
    additionalProperties: false
  },

  PAUSE: {
    type: 'object', required: ['playback_position_s'],
    properties: { playback_position_s: { type: 'number', minimum: 0 } },
    additionalProperties: false
  },

  RESUME: {
    type: 'object', required: ['playback_position_s', 'pause_duration_ms'],
    properties: {
      playback_position_s: { type: 'number', minimum: 0 },
      pause_duration_ms:   { type: 'integer', minimum: 0 }
    },
    additionalProperties: false
  },

  SEEK: {
    type: 'object', required: ['from_position_s', 'to_position_s'],
    properties: {
      from_position_s: { type: 'number', minimum: 0 },
      to_position_s:   { type: 'number', minimum: 0 }
    },
    additionalProperties: false
  },

  STOP: {
    type: 'object', required: ['playback_position_s', 'reason'],
    properties: {
      playback_position_s: { type: 'number', minimum: 0 },
      reason: { type: 'string', enum: ['completed', 'user_stop', 'error', 'unknown'] }
    },
    additionalProperties: false
  },

  SESSION_END: {
    type: 'object',
    required: ['watch_time_s', 'completion_pct', 'reason', 'rebuffer_count', 'rebuffer_time_s', 'bitrate_change_count'],
    properties: {
      watch_time_s:         { type: 'number', minimum: 0 },
      completion_pct:       { type: ['number', 'null'], minimum: 0, maximum: 100 },
      reason:               { type: 'string', enum: ['completed', 'user_stop', 'error', 'unknown'] },
      rebuffer_count:       { type: 'integer', minimum: 0 },
      rebuffer_time_s:      { type: 'number', minimum: 0 },
      bitrate_change_count: { type: 'integer', minimum: 0 }
    },
    additionalProperties: false
  },

  HEARTBEAT: {
    type: 'object',
    required: ['playback_position_s', 'current_bitrate_kbps', 'current_resolution', 'is_buffering', 'rebuffer_time_ms'],
    properties: {
      playback_position_s:  { type: 'number', minimum: 0 },
      current_bitrate_kbps: { type: 'number', minimum: 0 },
      current_resolution:   { type: 'string' },
      is_buffering:         { type: 'boolean' },
      rebuffer_time_ms:     { type: 'number', minimum: 0 },
      live_latency_s:       { type: 'number', minimum: 0 }
    },
    additionalProperties: false
  },

  BUFFERING_START: {
    type: 'object', required: ['playback_position_s'],
    properties: {
      playback_position_s: { type: 'number', minimum: 0 },
      cause: { type: 'string', enum: ['initial', 'seek', 'bitrate_switch', 'network', 'unknown'] }
    },
    additionalProperties: false
  },

  BUFFERING_END: {
    type: 'object', required: ['playback_position_s', 'buffering_duration_ms'],
    properties: {
      playback_position_s:  { type: 'number', minimum: 0 },
      buffering_duration_ms: { type: 'integer', minimum: 0 }
    },
    additionalProperties: false
  },

  BITRATE_CHANGE: {
    type: 'object',
    required: ['previous_bitrate_kbps', 'new_bitrate_kbps', 'previous_resolution', 'new_resolution', 'reason', 'playback_position_s'],
    properties: {
      previous_bitrate_kbps: { type: 'number', minimum: 0 },
      new_bitrate_kbps:      { type: 'number', minimum: 0 },
      previous_resolution:   { type: 'string' },
      new_resolution:        { type: 'string' },
      codec:                 { type: 'string' },
      reason:                { type: 'string', enum: ['auto', 'user'] },
      playback_position_s:   { type: 'number', minimum: 0 }
    },
    additionalProperties: false
  },

  ERROR: {
    type: 'object', required: ['error_code', 'error_message', 'source', 'fatal'],
    properties: {
      error_code:          { type: 'string' },
      error_message:       { type: 'string' },
      source:              { type: 'string', enum: ['player', 'network', 'drm', 'cdn', 'unknown'] },
      fatal:               { type: 'boolean' },
      vsf_type:            { type: 'string', enum: ['technical', 'business'] },
      is_ebvs:             { type: 'boolean' },
      playback_position_s: { type: 'number' },
      http_status:         { type: 'integer' }
    },
    additionalProperties: false
  },

  CDN_REQUEST: {
    type: 'object',
    required: ['cdn_name', 'request_type', 'http_status', 'ttfb_ms', 'duration_ms', 'bytes', 'throughput_kbps'],
    properties: {
      cdn_name:        { type: 'string' },
      request_type:    { type: 'string', enum: ['manifest', 'segment', 'key'] },
      media_type:      { type: 'string', enum: ['video', 'audio', 'subtitle', 'muxed'] },
      url:             { type: 'string', maxLength: 2048 },
      http_status:     { type: 'integer' },
      ttfb_ms:         { type: 'number', minimum: 0 },
      duration_ms:     { type: 'number', minimum: 0 },
      bytes:           { type: 'integer', minimum: 0 },
      throughput_kbps: { type: 'number', minimum: 0 },
      sequence_number: { type: 'integer', minimum: 0 }
    },
    additionalProperties: false
  },

  CDN_SWITCH: {
    type: 'object', required: ['cdn_from', 'cdn_to', 'reason', 'playback_position_s'],
    properties: {
      cdn_from:             { type: 'string' },
      cdn_to:               { type: 'string' },
      reason:               { type: 'string', enum: ['error', 'policy', 'latency', 'manual', 'unknown'] },
      trigger_http_status:  { type: 'integer' },
      playback_position_s:  { type: 'number', minimum: 0 }
    },
    additionalProperties: false
  },

  JOIN_TIME: {
    type: 'object', required: ['join_time_ms'],
    properties: { join_time_ms: { type: 'integer', minimum: 0 } },
    additionalProperties: false
  },

  LIVE_LATENCY: {
    type: 'object', required: ['latency_s', 'playback_position_s'],
    properties: {
      latency_s:           { type: 'number', minimum: 0 },
      target_latency_s:    { type: 'number', minimum: 0 },
      playback_position_s: { type: 'number', minimum: 0 }
    },
    additionalProperties: false
  },

  MANIFEST_ERROR: {
    type: 'object', required: ['http_status', 'retry_count', 'fatal'],
    properties: {
      http_status:  { type: 'integer' },
      url:          { type: 'string', maxLength: 2048 },
      retry_count:  { type: 'integer', minimum: 0 },
      fatal:        { type: 'boolean' }
    },
    additionalProperties: false
  },

  AD_BREAK_START: {
    type: 'object', required: ['ad_id', 'position', 'duration_s', 'ad_count'],
    properties: {
      ad_id:      { type: 'string' },
      position:   { type: 'string', enum: ['pre', 'mid', 'post'] },
      duration_s: { type: 'number', minimum: 0 },
      ad_count:   { type: 'integer', minimum: 1 }
    },
    additionalProperties: false
  },

  AD_BREAK_END: {
    type: 'object', required: ['ad_id', 'position', 'watched_s', 'skipped'],
    properties: {
      ad_id:      { type: 'string' },
      position:   { type: 'string', enum: ['pre', 'mid', 'post'] },
      watched_s:  { type: 'number', minimum: 0 },
      skipped:    { type: 'boolean' }
    },
    additionalProperties: false
  },

  AD_QUARTILE: {
    type: 'object', required: ['ad_id', 'quartile', 'position'],
    properties: {
      ad_id:    { type: 'string' },
      quartile: { type: 'integer', enum: [0, 25, 50, 75, 100] },
      position: { type: 'string', enum: ['pre', 'mid', 'post'] }
    },
    additionalProperties: false
  },

  AD_ERROR: {
    type: 'object', required: ['error_code', 'error_message', 'fatal'],
    properties: {
      ad_id:         { type: 'string' },
      error_code:    { type: 'string' },
      error_message: { type: 'string' },
      fatal:         { type: 'boolean' }
    },
    additionalProperties: false
  }
};
