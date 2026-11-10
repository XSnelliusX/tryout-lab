# Local exports

`export_session(session, data_dir, format)` writes a new private file under
`data_dir/sessions/<session-id>/exports/` and returns its path. Formats are
`markdown`, `json`, and `anki`. It uses only the supplied session snapshot; it
does not call a gateway, download anything, or invoke a model.

Each export is a **copy**, not a live view. Source edits do not update existing
copies. Files are retained until explicitly deleted; deleting a session through
the library also removes its app-owned session directory and its exports. Copies
made elsewhere must be deleted separately. Exports can contain sensitive meeting
content: avoid shared or cloud-synced folders unless authorized. New directories
are owner-only and export files are created exclusively with mode 0600. Symlink
components in the app-owned path are rejected.

- **Markdown** contains current Chinese and English text, source segment IDs,
  coarse times, speaker cluster and any reviewed name, revision, and original
  ASR when text differs or was edited. Artifacts appear with status and source
  version; stale derivatives are explicitly marked as not current. Artifacts
  remain proposals, not automatically approved content.
- **JSON** contains the supplied session record, segments (including raw text
  and current revision), and artifact data with recomputed staleness. Revision
  history is included only if supplied in the snapshot; the export does not
  query the library. Settings and credential fields are excluded.
- **Anki** is headerless UTF-8 TSV with six fields: Traditional term, pinyin,
  contextual meaning, source quotation, source segment IDs/coarse time, and
  validation/status and dictionary provenance. Import as tab-separated text and map those fields to the
  desired note type. Only non-stale learning artifacts with ready or
  review-needed status contribute items; missing validation is labeled
  review-needed. This does not imply user approval or dictionary validation.
  Tabs/newlines are replaced with spaces, HTML is escaped, and fields beginning
  with spreadsheet formula characters (even after whitespace) receive a visible
  apostrophe. A missing non-stale learning item raises an error, rather than
  producing an empty file.

Staleness is based on the artifact's source version compared with the session
version; missing version information is treated conservatively as stale. Times
are approximate segment boundaries, not word-level alignments.
