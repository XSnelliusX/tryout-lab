# Recover a session from archived audio

Use this after a recording has stopped or the app has exited, especially if live inference skipped chunks or the app crashed. Recovery replays the archived audio through the local speech and translation models; it does not repair or overwrite the original recording or journal.

## Prerequisites

- The session folder must contain `audio.wav` and `events.jsonl`. Audio must be uncompressed 16-bit mono PCM at 16 kHz.
- Run initial setup and prepare the local models first. Recovery uses the existing virtual environment and locally installed models; it does not download models or use a gateway.
- Do not run recovery while that session is still recording. Keep enough free space for the output and allow time for model loading and inference.

## Run

From the repository root, replace the example with the **exact session folder**:

```sh
.venv/bin/python scripts/recover_session.py \
  "$HOME/Library/Application Support/Meeting Assistant/sessions/SESSION_FOLDER" \
  --confirm
```

To replay from an approximate audio offset, add `--start-seconds 300`. The flag `--confirm` is required: no inference runs without it. Progress and output paths appear in the terminal, without transcript text.

Two new private files, `recovery-<timestamp>.jsonl` and `recovery-<timestamp>.txt`, are created in the session folder. The JSONL contains raw recognition, Traditional Chinese, English, approximate window times, skipped low-RMS windows and per-window errors; the text file is a readable transcript. Originals remain unchanged. The script replays **all** windows from the offset, including already completed live captions; it does not merge or deduplicate them. A nonzero exit indicates a failure or one or more failed windows. After an interruption, partial recovery files remain; inspect the journal and rerun from an appropriate offset if needed.

## Limitations and privacy

Audio is processed in fixed, non-overlapping windows of at most six seconds. Speech can be cut at window boundaries, and recognition or translation may omit or misinterpret words. The RMS threshold of 0.008 skips quiet windows; quiet speech can be missed, while noise can be mistaken for speech. Times describe audio windows, not word-level timings. Review against the original audio before relying on the results.

Recovery only sees audio present in the WAV archive. It cannot restore uncaptured audio, detect every recording gap, or recover samples beyond an incomplete WAV header after a crash. It does not do speaker attribution, diarization, summaries, or gateway processing. Outputs are local sensitive copies and persist until deleted; remove them and any backups separately when no longer needed.
