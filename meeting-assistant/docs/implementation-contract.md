# Implementation contracts: post-meeting workbench

This is the shared implementation seam for the next prototype, not a claim of
tested model quality. Original audio and recognition are immutable evidence.
User edits and post-processing outputs are versioned derivatives. Live inference
stays local; remote text processing requires an explicit confirmed action.

## Shared records

- Segment: `id` (integer within session), `start`/`end` (coarse seconds or null),
  `kind`, `raw_text` (original ASR), `traditional_text` (current reviewed source),
  `english`, `revision` (integer >=1), `status`, `speaker` (cluster or `unknown`),
  optional `error`; original ASR must never be overwritten by an edit.
- Settings: `meeting_context` (string), `vocabulary` (list of objects with `id`,
  `term`, `translation`, `note`, `enabled`, `known`; terms are recognition hints,
  not mandatory substitutions); `gateway` (`endpoint`, `model`, no stored key).
- Session: `id`, `source`, `created_at`, `status`, `version` (incremented by any
  source/identity revision), `context`, `segments`, `speaker_names`, `artifacts`.
- Artifact: `id`, `kind`, `session_id`, `source_version`, `status`, `data`,
  `created_at`; stale when the session version changes. An offline ASR pass or
  gateway correction is a proposal, not an automatic replacement.

## Storage API (`meeting_assistant/library.py`)

`Library(data_dir: Path)` is a thread-safe SQLite repository, with independent
connections/transactions and private files. It imports legacy `events.jsonl`
session journals on explicit `import_legacy()` without running models.

- `get_settings() -> dict`, `save_settings(updates: dict) -> dict`
- `list_sessions() -> list[dict]`
- `register_session(session_id, source, context="") -> dict`
- `set_session_status(session_id, status) -> None`
- `get_session(session_id) -> dict` (includes segments and artifact metadata/data)
- `upsert_segment(session_id, segment: dict) -> dict`: preserves existing user
  revisions, rejects stale inferred translations; returns current stored segment.
- `edit_segment(session_id, segment_id, text, expected_revision, speaker=None)
  -> dict`: optimistic concurrency; clears stale translation; immutable revision
  history accessible through `segment_history(session_id, segment_id) -> list`.
- `update_translation(session_id, segment_id, revision, english, error=None)
  -> dict`: reject stale revision, never roll back text.
- `add_vocabulary(term, translation="", note="") -> dict`,
  `remove_vocabulary(vocabulary_id) -> None`; validate lengths/reserved tokens.
- `set_speaker_names(session_id, names: dict) -> dict`
- `assign_speakers(session_id, assignments: list[dict]) -> dict`: each assignment
  has segment `id`, `speaker`, optional ambiguity metadata; invalidates derivatives.
- `add_artifact(session_id, kind, source_version, data, status="ready") -> dict`
- `get_artifact(session_id, artifact_id) -> dict`
- `delete_session(session_id) -> None`: only exact app-owned session directory,
  plus app-owned exports; no arbitrary path deletion. Record deletion is explicit.

## Model API (`meeting_assistant/inference.py`)

Keep old API working. Extend:

- `transcribe(audio, sample_rate=16000, *, context="", vocabulary=None,
  max_tokens=None) -> {raw_text, traditional_text}`. Recognition hints use Qwen's
  documented `system_prompt`/`hotwords`, not transcript text substitution.
- `translate(text, *, context="", vocabulary=None, history=None) -> str`.
  PLaMo uses its reviewed chat/PFML3 options with reserved-token validation.

`meeting_assistant/refinement.py`:

- `refine_session(session_path: Path, models, *, context="", vocabulary=None,
  progress=None, cancelled=None) -> dict` returns `segments` proposals, coarse
  timing, provenance and limitations. Longer speech-aware windows, bounded
  overlap/dedup; no edits to original archive or reference transcript.

## Post-processing (`meeting_assistant/postprocess.py`)

- `GatewayClient(endpoint, model, api_key="")`; validated explicit HTTPS endpoint,
  no implicit provider/default, no redirects. Only caller-approved text payloads.
- `analyze(segments, *, task, context="", speaker_names=None, progress=None,
  cancelled=None) -> dict`: task `review`, `summary`, or `learning`. Chunk bounded
  transcript input for long meetings; every proposed claim/edit/vocabulary entry
  references exact existing segment IDs and quotation. Review edits additionally
  carry the exact original text and a proposed replacement. Invalid references
  are rejected or marked unsupported; never auto-apply. No unsupported owners,
  deadlines, speaker identity or invented audio evidence.
- `validate_learning(data, segments) -> dict` local dictionary/pinyin validation,
  original contextual meaning retained separately from dictionary meanings.

## Diarization (`meeting_assistant/diarization.py`)

- `capabilities(data_dir) -> dict`: clearly report backend/model readiness.
- `diarize_session(session_path, *, data_dir, progress=None, cancelled=None)
  -> dict`: explicitly configured local NeMo-Speech.cpp V3 backend and pinned
  eight-voice model only, stateful long-recording path. No implicit downloads.
- `assign_segments(segments, timeline) -> list[dict]`: temporal overlap with
  conservative ambiguous/unknown labels, not automatic person identification.

## HTTP/workbench endpoints

Existing token/loopback/origin checks apply to all new endpoints. JSON body only.
GET `/api/state` extends with settings, selected session, session list, job state,
and diarization capabilities (never API keys). GET `/api/history?session_id=...&segment_id=...`
and `/api/audio?session_id=...&start=...&end=...` need bearer authentication (audio
is fetched to a browser Blob, not an unauthenticated media link).

POST endpoints:

- `/api/settings`: `{meeting_context?, vocabulary?, gateway?}`
- `/api/vocabulary`: `{term, translation?, note?}`;
  `/api/vocabulary/delete`: `{id}`
- `/api/session/open`: `{session_id}`; `/api/session/delete`: `{session_id,confirm:true}`
- `/api/segment/edit`: `{session_id,id,text,expected_revision,speaker?,vocabulary_term?,
  vocabulary_translation?}`; vocabulary addition is opt-in, not whole-sentence
  guessing. `/api/segment/retranslate`: `{session_id,id}`
- `/api/speakers`: `{session_id,names:{...}}`
- `/api/job/start`: `{task:refine|diarize|review|summary|learning,confirm_send?:true,
  session_id,expected_version,expected_gateway?:{endpoint,model},api_key?:string}`;
  remote confirmation must match the selected session, transcript version and
  exact configured gateway. Remote key is held in memory/env only. Jobs prohibit live capture.
- `/api/attribution`: `{session_id,unreliable:boolean}` flags overflow or uncertain speaker
  attribution; anonymous post-meeting processing and no automatic assignments.
- `/api/job/cancel`: `{}`
- `/api/artifact/apply`: `{artifact_id,proposal_index,expected_version}` applies
  one reviewed correction/refinement proposal using optimistic revisions.
- `/api/export`: `{format:markdown|json|anki}` saves private local file and returns path.

No capture, real gateway calls, private-meeting inspection, or model inference is
needed for implementation checks. Deterministic fixtures/mocks may test contracts.
