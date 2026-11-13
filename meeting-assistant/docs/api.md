# Local HTTP API (backend ↔ frontend contract, v2)

The loopback server in `meeting_assistant/server.py` serves the UI and this API. Anything not listed here
keeps the behaviour visible in `do_GET`, `do_POST` and `Application.state()`.

Auth: every `/api/*` request carries `Authorization: Bearer <token>`; POSTs also need the same-origin
`Origin` header (the browser sends it). Static files need the session cookie set by `/?token=`.

## Static files

`GET /<name>` serves any regular file directly inside `meeting_assistant/static/` whose name matches
`^[a-z0-9][a-z0-9._-]*\.(html|js|css|svg)$` (no subdirectories, no symlinks), with the security headers and
cookie check. `/` is `index.html`.

## GET /api/state — full snapshot

Heavy (reads the library). Fetch on load and when told to refresh, not on a fast timer.

Fields: `settings, session, sessions, job, diarization, model_status, model_ready, recording_state
("idle"|"starting"|"recording"|"draining"), session_id, segments, live_preview, no_audio, queue_length,
queue_lag_seconds, pending_work, dropped, notice, capture_status, audio_seconds, feed_status, launcher_name,
archive_dir, session_path`, plus:

```jsonc
"audio": {                      // live input diagnostics; levels in dBFS (0 = full scale), null when unknown
  "rms_db": -31.2,              // level of the latest 100 ms
  "peak_db": -12.4,             // sample peak over the latest 1 s
  "noise_db": -52.0,            // tracked background noise floor
  "speech_db": -27.5,           // tracked typical speech level
  "snr_db": 24.5,               // speech_db - noise_db
  "threshold_db": -44.0,        // current speech-detection threshold
  "speaking": true,             // detector state
  "gain_db": 9.5,               // gain currently applied to audio sent to recognition (0 when off)
  "clipped_recent": 0,          // clipped samples in the last 10 s
  "clipped_total": 12,          // since capture start
  "advice": "",                 // one short plain-language hint; "" when healthy
  "device": {                   // null until the capture helper reports it, or with an old helper binary
    "name": "MacBook Pro Microphone", "uid": "BuiltInMicrophoneDevice", "transport": "built-in",
    "sample_rate": 48000, "channels": 1,
    "input_volume": 0.62,       // macOS input volume 0..1; null if the device has no software gain
    "input_volume_settable": true
  }
},
"latency": {                    // measured on this session's live segments; null before the first one
  "count": 42,
  "last":   {"endpoint_ms": 450, "asr_ms": 380, "translate_ms": 410,
             "speech_end_to_source_ms": 620, "speech_end_to_english_ms": 980},
  "median": { /* same keys */ },
  "p90":    { /* same keys */ }
},
"capabilities": {
  "helper_protocol": 2,         // 1 = old capture helper binary (no device selection or telemetry)
  "helper_stale": false,        // native/CaptureAudio.swift is newer than .build/capture-audio
  "event_stream": true
}
```

`settings` has an `audio` object, saved through `POST /api/settings {"audio": {...}}` (partial updates allowed):

```jsonc
"audio": {"device_uid": "",     // "" = follow the macOS default input
          "language": "auto",   // "auto" | "zh" | "en" — recognition language hint
          "normalize": true}    // level-normalise audio sent to recognition
```

Segments (in `segments`, `session.segments`, `live_preview`) have `id, start, end, kind, raw_text,
traditional_text, english, revision, speaker, status, error, edited` and more. `status` is one of:

- `"provisional"` — live preview only: not saved, not editable, may change
- `"translating"` — source text is final; `english` holds the partial translation so far and grows
- `"complete"`, `"pending"`, `"error"`

Live segments may carry `"timing"` with the same keys as `latency.last`.

## GET /api/events — push stream

NDJSON: one JSON object per line, `Content-Type: application/x-ndjson`, never closes while healthy. Requested
with `fetch` and the `Authorization` header and read through `response.body.getReader()`.

```jsonc
{"type": "live", "recording_state": "recording", "audio": { /* as above */ }, "audio_seconds": 81.3,
 "preview": { /* provisional segment or null */ }, "queue_length": 0, "queue_lag_seconds": 0.0,
 "pending_work": 1, "no_audio": false, "feed_status": "…", "capture_status": "…", "notice": "", "dropped": 0}
   // sent when any of these change; at most about 10 per second while capturing
{"type": "segment", "session_id": "…", "segment": { /* full segment, upsert by id */ }}
   // every create or update of a segment of the selected session, including each partial-translation step
{"type": "refresh"}   // something else changed (sessions, settings, job, results, model status, session switch)
{"type": "ping"}      // every 10 s
```

Client rules: on load `GET /api/state`, then open the stream; apply `live` and `segment` events to the local
copy; on `refresh` refetch the state (coalescing bursts); if the stream ends or errors, poll `/api/state`
every 2 s and retry the stream with backoff (1 s, 2 s, 5 s). A `segment` whose id equals the current preview
id replaces the preview.

## GET /api/devices

```jsonc
{"supported": true,
 "devices": [{"uid": "…", "name": "…", "transport": "built-in|usb|bluetooth|aggregate|virtual|other",
              "sample_rate": 48000, "channels": 1, "is_default": true,
              "input_volume": 0.62, "input_volume_settable": true}]}
```

`supported` is false with an old helper binary (`devices` is then `[]`). Runs the helper's `--list-devices`;
cached for 5 s.

## POST routes

Unchanged bodies: `/api/start {source, consent}`, `/api/stop`, `/api/manual {text}`, `/api/save`,
`/api/settings`, `/api/vocabulary`, `/api/vocabulary/delete`, `/api/session/open`, `/api/session/delete`,
`/api/segment/edit`, `/api/segment/retranslate`, `/api/speakers`, `/api/attribution`, `/api/job/start`,
`/api/job/cancel`, `/api/artifact/apply`, `/api/export`.

- `POST /api/settings {"meeting_context": "…"}` saves the default context for new recordings. It updates a
  session only while that session is being recorded.
- `POST /api/session/context {"session_id": "…", "context": "…"}` → `{"session": {…}}` changes the context of
  the open archived session. This bumps its version and makes its results stale.
- `/api/segment/edit`: send `speaker` only when the user changed it (an explicit speaker clears diarization
  ambiguity flags).

Errors: any failure returns JSON `{"error": "message"}` with status 400 (bad request), 403 (auth) or 500
(unexpected server error).

## Capture helper protocol (`.build/capture-audio`)

stdout carries only little-endian mono Float32 PCM at 16 kHz. stderr carries one JSON object per line.

- `--version` → `{"event":"version","protocol":2}`, exit 0. Protocol 1 binaries exit 2 with a usage error.
- `--list-devices` → one `{"event":"device", uid, name, transport, sample_rate, channels, is_default,
  input_volume, input_volume_settable}` per input device, exit 0. Must not trigger a permission prompt.
- `--list-apps` → unchanged.
- `--source teams|system|microphone [--device <uid>]` — `--device` only with `microphone`.
- Events while capturing: `permission`, `started` (adds `"protocol":2` and, for the microphone, a `device`
  object as above), `format` (`sample_rate`, `channels` of the incoming audio, on first buffer and on
  change), `input` (`input_volume`, when the macOS input volume changes during capture), `error`, `stopped`.
