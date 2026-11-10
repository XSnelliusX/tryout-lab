# Meeting Assistant

> **Preview:** a personal experiment, not a finished product. Recognition,
> translation, speaker attribution and summaries can be wrong or incomplete.
> Features, setup and privacy safeguards are still being evaluated; don't rely
> on this as the only record of important decisions.

Meeting Assistant is a macOS tool for understanding Mandarin–English meetings:
it captures one audio source, shows Chinese speech alongside English text, and
provides tools to review the recording and learn from it afterwards.

## Why build this?

I regularly join technical meetings where people switch between Taiwanese
Mandarin and English. Some free live-transcription tools I have tried either
don't support Chinese or don't transcribe it well enough for these meetings.
Even Microsoft Teams transcripts can struggle with the combination of Chinese,
accents and software-engineering terms. For example, “container protection”
might be heard as “content production,” and “phase one” as “V One.”

This project explores whether local Chinese speech recognition, English
translation, meeting context, and a vocabulary I can correct and maintain make
those conversations easier to follow. It is an experiment—not a claim that it
already outperforms Teams or other tools. Hints may also bias recognition toward
the wrong term, so important details still need to be checked against audio.

## What it's useful for

- **Following a meeting:** local live Chinese captions and English translation,
  from Teams desktop audio, system audio, or a microphone in a physical room.
  Choose one source at a time; microphone and Teams audio are not mixed.
- **Handling engineering vocabulary:** provide meeting context and terms such
  as `container protection`; add a Chinese → English glossary pair when useful.
- **Correcting mistakes:** edit transcript segments, replay saved audio, retain
  the original recognition and revision history, and optionally add a corrected
  term to the vocabulary. This is prompting with hints, not model training.
- **Reviewing a recording:** run a local second pass with longer audio windows,
  compare its candidates with the live transcript, and try anonymous local
  speaker diarization with manual name review.
- **Learning Chinese and preparing notes:** optional, explicitly approved
  gateway jobs propose transcript corrections, meeting notes, and Chinese
  vocabulary with pinyin and source examples. Export Markdown, JSON, or an
  Anki-compatible TSV.

## Important limitations

- Live captions, refinement and diarization are prototypes. Accuracy, latency,
  two-hour reliability and performance have not been established. A second pass
  may repeat errors; its longer-window candidates must be reviewed and copied
  manually rather than automatically replacing the original transcript.
- The speaker model supports **at most eight distinct voices per session**.
  Anonymous clusters do not identify people, and overlapping speech may be
  ambiguous. Flag uncertain attribution or more than eight voices in the UI.
- Notes are chunk-grounded drafts, not a guaranteed account of final decisions.
  Pinyin checks do not prove a contextual reading, meaning or Taiwan usage.
- This preview targets Apple Silicon macOS and Microsoft Teams desktop; it is
  not a meeting bot, browser extension, or general cross-platform application.

## Setup and launch

Requirements: Apple Silicon Mac, macOS, Python 3.13, Xcode command-line tools,
and sufficient disk space for local models. The initial setup installs Python
dependencies, builds a native capture helper and downloads the selected ASR
and translation models. The repository's `.venv/` is ignored by Git but is not
private on a cloud-synced filesystem; it holds third-party dependencies, not
meeting content. Model and meeting data remain outside the repository:

```sh
cd meeting-assistant
./scripts/setup.sh
./scripts/start.sh
```

The app opens a browser window on a token-authenticated loopback server.
Alternatively, double-click `Start Meeting Assistant.command` after setup. Wait
for **Models ready**, choose a source, confirm required consent, and select
**Start recording**. Select **Stop & finish** and wait for processing before
closing the launcher.

Microphone mode requires macOS **Microphone** permission. Teams and system
audio require **Screen & System Audio Recording** permission for the app that
launched the helper—normally Terminal for the double-click launcher, or the
terminal app used to run the script. See the [live-test guide](docs/live-test.md)
for permission troubleshooting and the [workbench guide](docs/workbench.md) for
using context, edits and review.

The optional diarization backend has a separate
[setup](docs/diarization.md). Gateway review, summaries and learning require an
explicit endpoint and model, any required API key, and confirmation for each
send; see [gateway configuration](docs/gateway.md).

## Privacy and retention

- Live capture, speech recognition, translation and local diarization run on
  the Mac. There is no automatic cloud fallback. Starting the app does not
  start recording.
- Recordings, transcript revisions, vocabulary and model files are stored under
  `~/Library/Application Support/Meeting Assistant`, **outside this repository**.
  Recordings remain until you delete them; exported copies and backups must be
  managed separately.
- Optional gateway jobs send selected transcript text, context and reviewed
  names—not audio—only after an explicit confirmation. Check company approval,
  participant consent, retention and residency before recording or sending.
- Never commit meeting audio, transcripts, private vocabulary, API keys, local
  databases, or model weights. The project `.gitignore` excludes common runtime
  files, but verify changes before committing.

## More detail

- [Workbench: context, corrections, jobs and exports](docs/workbench.md)
- [Recognition hints and offline refinement](docs/recognition-quality.md)
- [Local diarization](docs/diarization.md) · [Gateway and Chinese learning](docs/gateway.md)
- [Recover archived audio](docs/recovery.md) · [Exports](docs/exports.md)
- [Implementation plan and known gaps](docs/plan.md)

The prototype has synthetic tests, but those tests don't establish recognition
quality, real-world diarization, gateway compatibility or meeting reliability.
