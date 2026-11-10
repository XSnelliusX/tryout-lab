# Post-meeting workbench

The workbench is implemented as a prototype. Synthetic repository, model-adapter, gateway-mock and integration checks pass; live inference and actual gateway compatibility/quality have not been validated for this update. Stop any older server and restart the app to load updated code. Recording still requires consent and an explicit Start.

## Sessions, context and corrections

Browse saved sessions; legacy session journals are imported into the library on launch. Saving meeting context updates the selected session and the default for future sessions. A new recording carries the displayed selected session's saved context, or the global default if no session is open. Save context/vocabulary drafts before starting. Context is a hint, not verified evidence.

Edit a segment directly and save it with its current revision. Original raw recognition is preserved, edits have revision history, and changes make dependent outputs stale; retranslate or regenerate as appropriate. Listen to the retained audio when a correction matters. Segment boundaries are coarse, not exact word timings.

Vocabulary can be added explicitly, including an opt-in term from a correction. Enabled terms are recognition hints for the next enqueued segment, not training and not automatic global replacement of transcript text. See [recognition quality](recognition-quality.md).

For example, add `container protection` and `phase one` as recognition terms with
empty English-rendering fields. Add `容器防護` → `container protection` as a
translation pair. Do not put a Chinese meaning into the English-rendering field:
the translator's output direction is always English. Keep only relevant terms
enabled; hints can bias an ambiguous recording incorrectly.

## Offline processing

The offline refinement pass uses speech-aware windows up to 24 seconds, with up to 1.5 seconds overlap where no suitable pause is found. It produces candidates for manual review and copying into the appropriate segment editor, not automatic replacement: a longer audio window does not map exactly onto the old segments. Timing is approximate, not exact alignment. Keep the original audio and raw transcript as evidence. Refinement may still repeat mistakes; changed context and vocabulary improve its inputs, not guarantee its results.

Local diarization requires the pinned Metal backend and model installed separately as described in [diarization](diarization.md); actual inference is untested. It produces anonymous speaker clusters, not identities. Review assignments before applying and name clusters manually. The selected model supports at most eight distinct voices; more are unsupported. Use the **attribution unreliable / more than 8 voices** checkbox to disable automatic assignment and send anonymous evidence for notes. Overlap and speaker changes remain unknown unless manually corrected.

Applying a new clustering clears previous cluster-to-name mappings: `speaker_1`
from a new run is not evidence of the same person. Review and name clusters again
before requesting per-person notes. Only one server may own the data directory
at a time, preventing a second server from deleting an active recording.

## Gateway review, summary and learning

Configure an explicit gateway endpoint and model and provide a key through `MEETING_ASSISTANT_GATEWAY_KEY` or UI memory. Keys are not persisted. Confirm each remote job before sending transcript text; audio is never uploaded. Check authorization and gateway retention before sending sensitive content. Missing gateway configuration does not break live local capture or inference. See [gateway configuration](gateway.md).

Confirmation is bound to the exact selected session, transcript version and configured destination. A change in another tab requires reviewing and confirming again rather than silently sending a different payload.

Review corrections are proposals, not automatic changes. Apply them individually after checking their evidence; applying one changes the source version and invalidates sibling proposals, so rerun review for further suggestions. Summaries and learning output also depend on the source version and must be reviewed, especially after edits or speaker-name changes. Summaries are chunk-grounded drafts: cross-chunk reversals are not yet globally reconciled. Proposed actions are not automatically accepted commitments. Dictionary-supported pinyin does not verify the contextual reading, meaning or Taiwan usage; heteronyms remain review-needed. The study list deduplicates term/readings, excludes saved known terms and keeps at most 30 entries, without claiming to measure proficiency.

Only audio-derived reviewed segments, meeting context and the relevant reviewed speaker-name mapping are sent. Manual pasted translation inputs are excluded. HTTPS endpoints must resolve to public addresses in this prototype; private/internal-only gateway routes require a separate reviewed deployment change.

## Export and deletion

Export local Markdown, JSON or Anki-compatible TSV. Anki TSV must be imported into Anki; it is not sent there automatically. Exports are snapshots and can become stale. Deleting a session removes that exact app-owned session and its app-owned exports, not copies, external backups or data sent elsewhere. See [exports](exports.md).

Deletion first moves the session into private recoverable quarantine, commits
the library deletion, then removes the quarantined files. If cleanup is
interrupted, startup completes committed deletions or restores uncommitted ones;
do not manually delete `.trash` while recovering. SQLite secure deletion is
enabled for removed records, but APFS snapshots, SSD behavior and backups mean
physical secure erasure cannot be guaranteed. Settings and your separately saved
vocabulary are retained when a session is deleted; remove vocabulary separately.
