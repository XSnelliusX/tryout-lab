# Local Nemotron 3 diarization

The adapter runs **NVIDIA Nemotron-3-Diarization V3**, locally, after a meeting.
No ASR, speaker names, remote requests or model downloads occur during
diarization. Availability and correctness on this Mac remain **untested**.

On the original development Mac, the Metal runtime and model were installed
using the setup below and their checksums passed. Static Mach-O inspection showed
the expected `@loader_path/../lib` runpath and all directly referenced bundled
libraries present. This did not execute the binary or establish inference
compatibility. Other machines need the separate setup below.

## Pinned assets and provenance

The explicit setup command downloads these exact publisher assets (no other
model) and checks the following SHA-256 values before installation:

| Asset | Revision / version | SHA-256 |
| --- | --- | --- |
| NVIDIA NeMo-Speech.cpp macOS aarch64 **Metal** archive | v0.3.0 | `2b972ed8b5dba07492212acf8cb75cbf34ecb141198ffa1997febe84b7c4d9ed` |
| NVIDIA NeMo-Speech.cpp macOS aarch64 **CPU** archive | v0.3.0 | `2c3a7a719b778daeb14f147e011891f16e4b2ac62388d8b8d8b365cc2eebdf15` |
| NVIDIA `Nemotron-3-Diarization.q8_0.gguf` (107,012,128 bytes) | `f667ed73aee57d40cc39428eb768b4fd87a0a29e` | `08456d9e22cd9a323c0364d98375f3746d6e68507ebb705cd46438c534c7a3a1` |

The [release asset metadata](https://api.github.com/repos/NVIDIA/NeMo-Speech.cpp/releases/tags/v0.3.0)
and [model-revision metadata](https://huggingface.co/api/models/nvidia/Nemotron-3-Diarization/revision/f667ed73aee57d40cc39428eb768b4fd87a0a29e?blobs=true)
are the sources of the hashes. The release tag points to source commit
[`20999cc921d2b14aa58708f61756a8b2e787ba20`](https://github.com/NVIDIA/NeMo-Speech.cpp/tree/20999cc921d2b14aa58708f61756a8b2e787ba20).
The checksums detect changes relative to the values obtained from the publishers;
they are **not signatures** or proof that the publishers' files are safe. The
model is subject to [OpenMDW 1.1](https://openmdw.ai/license/1-1/); review its
[model card](https://huggingface.co/nvidia/Nemotron-3-Diarization/blob/f667ed73aee57d40cc39428eb768b4fd87a0a29e/README.md)
and the runtime notices before use.

## Explicit setup

On Apple Silicon macOS, Python 3.12+:

```sh
python3 scripts/setup_diarization.py --backend metal --download
# Alternative, separate CPU archive (choose one instead of the above):
python3 scripts/setup_diarization.py --backend cpu --download
```

This retrieves the runtime archive plus the ~107 MB model; it does not run the
executable, record audio, or perform inference. There is no download without
`--download`. Setup refuses to replace an existing config or target runtime;
inspect and remove or move them manually only if appropriate. `--data-dir PATH`
selects an alternate application data root. The default is
`~/Library/Application Support/Meeting Assistant`. Installed paths are:

```text
DATA_DIR/diarization/config.json
DATA_DIR/diarization/nemo-speech-0.3.0-metal/bin/nemo-speech
DATA_DIR/diarization/nemo-speech-0.3.0-metal/models/Nemotron-3-Diarization.q8_0.gguf
```

The CPU paths use `nemo-speech-0.3.0-cpu` instead. Config is mode 600 and its
parent is mode 700. It contains explicit absolute executable and model paths,
the selected device, pinned version/revision and a locally computed executable
SHA-256. `capabilities(data_dir)` checks these, including the publisher-pinned
model hash, without running the backend or downloading. The executable hash
detects subsequent changes; by itself it does not establish the executable's
publisher if someone manually edits the configuration. Readiness means files
are configured and verified, **not** that the GPU, quality or performance have
been tested. Metal and CPU are explicit alternatives, not automatic fallback.
For inexpensive repeated UI polling, hash results are cached in memory by the
assets' paths and file metadata (including modification and change times); the
config is checked each time. Both assets are fully rehashed before each run.

## Execution contract

`diarize_session(session_path, data_dir=...)` accepts only a session directory
directly under `DATA_DIR/sessions/`, with a non-symlink `audio.wav`: mono,
16 kHz, 16-bit PCM. Its single whole-file command is equivalent to:

```text
nemo-speech diarize /absolute/session/audio.wav --model /absolute/model.gguf \
  --device metal --preset v3-offline --format json --output /private/temporary/result.json
```

The [v0.3.0 CLI implementation](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/20999cc921d2b14aa58708f61756a8b2e787ba20/app/diarize.cpp)
documents these options and emits JSON `segments` with one-based speaker
indices. It invokes one streaming-mode request for the entire WAV.
`v3-offline` is a stateful chunked preset, **not** the separate `--offline`
full-attention mode; the latter is limited to about 6.6 minutes by the
[CLI guide](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/20999cc921d2b14aa58708f61756a8b2e787ba20/docs/cli.md#diarize-audio).
The runtime loads the entire WAV into memory before processing; two-hour memory,
speed and quality have not been measured. The adapter limits input to 12 hours,
uses a six-hour wall-clock timeout, cancellation terminates the process group,
and returns no partial results. Progress gives start/completion, not an invented
percentage. Backend stdout/stderr are discarded and never shown as transcripts.
Temporary output is removed after completion and the archive is not modified.

The model path must exist and match the pinned SHA-256 before launch; no indexed
name is passed. An empty subprocess `PATH` also prevents the tagged runtime from
finding its `curl` downloader. This prevents implicit runtime model downloads;
the backend is not a general network sandbox. Avoid replacing the trusted binary
or libraries. Environment `NEMO_SPEECH_*` overrides are not inherited. NVIDIA's
[tagged build](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/20999cc921d2b14aa58708f61756a8b2e787ba20/CMakeLists.txt)
uses `@loader_path` install rpaths, and its [macOS packager](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/20999cc921d2b14aa58708f61756a8b2e787ba20/scripts/release/package-macos.sh)
checks that non-system dependencies are bundled. No `DYLD_LIBRARY_PATH` is set;
the actual release archive's loading on this Mac has not been tested.

## Interpreting results

`timeline` holds `{start, end, speaker}` intervals using anonymous `speaker_1`
through `speaker_8`; overlapping intervals are retained. `assign_segments`
uses each speaker's union of intersecting intervals, divided by the ASR
segment's duration. It assigns a cluster only if it is the **only** overlapping
cluster and covers at least 80%; any second speaker, a speaker change, low
coverage or missing timing gives `unknown` plus ambiguity/candidates. This is
review guidance based on coarse segment timings, not word alignment or proof
that a person spoke. Thresholds and model segmentation need validation.

The limit is **eight distinct voices for the whole session**. There is no
reliable automatic ninth-speaker detection. The caller/UI must let the user flag
possible overflow and treat attributions and per-person summaries as unreliable;
use anonymous notes or manual correction. The adapter does not identify people,
carry identities between sessions, or silently apply assignments. Validate on
consented representative 2/4/8-voice and overlap fixtures, speaker returns,
long recordings, and a >8-voice negative case before relying on results.

Run deterministic synthetic tests without a model or real audio:

```sh
python3 -m unittest discover -s tests -p test_diarization.py -v
```
