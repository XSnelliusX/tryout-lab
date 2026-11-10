# First live test

This MVP has not yet been tested in a live meeting; captions and performance are not guaranteed. Obtain all required participant consent and company approval for recording **and local archiving** before starting.

**Preview:** the first reported capture attempt was blocked by macOS permission error `-3801`; live capture and caption quality remain unverified. After moving or cloning the project, run `scripts/setup.sh` from the project directory to prepare the local Python environment and capture helper. Model files are stored outside the repository and can be reused if already installed.

Double-click `Start Meeting Assistant.command` in Finder to launch it in Terminal, or run:

```sh
cd /path/to/tryout_lab/meeting-assistant
./scripts/start.sh
```

The app opens its local browser UI; launching it does not automatically start capture. For a fresh installation or repair, run `scripts/setup.sh` first. Setup installs dependencies, builds the capture helper and downloads models to `~/Library/Application Support/Meeting Assistant/models` (outside this repository).

After an implementation update, stop any recording, wait for finishing, and stop the old server with **Ctrl+C** in its terminal. Relaunch and use the newly opened browser tab so the updated source selector and permission guidance are loaded. No model re-download is needed for the microphone update.

## Meeting checklist

1. Choose one source: **Teams** for Teams desktop output, **system** for all system output, or **microphone** for a physical meeting using the macOS default input. Teams does not need to be open for microphone capture. These are alternatives, not mixed capture. Teams and system output do not include your microphone directly. Close music and other sound sources if using system capture.
2. Wait for **Models Ready**. Obtain required consent for recording and local archiving, then select **Start**. Launching alone does not request microphone permission or start capture.
3. Grant the relevant macOS permission if prompted; see troubleshooting below. The UI also provides Settings links.
4. Check the audio meter, then the live Chinese source transcript and English translation.
5. Use **Focus captions** for larger English text and fewer controls during the meeting. This is a normal browser window, not an always-on-top overlay.
6. Select **Stop & finish** and wait for the final queue to finish before closing the browser or launcher. Use **Save transcript** for a readable bilingual text file. The session archive is local and private; its path is shown by the app. Recordings are retained until you delete them manually; there is no automatic retention deletion. Also consider separate copies and backups.

If capture is unavailable, use the UI's pasted-Chinese translation fallback with the local model. Live inference stays on the Mac; there is no cloud fallback. Speaker diarization, gateway review and summaries are not part of this MVP.

### If no audio appears

The status now separates startup from active capture. Check **Received: … seconds of audio**:

- Stuck at **0.0**: no audio frames have reached the app. Check the displayed permission/startup error first; `-3801` blocks capture entirely.
- Counter increases but signal RMS stays near **0.0000**: audio frames are arriving but silent. For microphone, check **Sound → Input** and the input-level indicator while someone speaks. For Teams, check computer audio is connected and someone remote is speaking; the physical room is not captured by this source.
- Counter increases and the RMS signal is nonzero, but no captions: very quiet sound may be below the current `0.008` speech threshold, or inference may be queued. Review the signal and queue diagnostics. Source captions may take up to a six-second chunk plus model processing to appear; there is no measured latency guarantee.

If Teams app filtering stays silent after permissions are granted, stop and select **All system audio** only if capturing other apps is appropriate and consented. Microphone is a separate alternative for physical-room speech, not a direct digital Teams fallback.

The Transformers `plamo3` / empty-type warning has a [source-level explanation](inference-compatibility.md): it is emitted while choosing the tokenizer, separately from the custom MLX inference model. It is not the ScreenCaptureKit permission error, and is not proof that translation works. The loader now checks the expected model/tokenizer classes without globally suppressing warnings.

If the queue warning reports skipped captions, the captured audio is still archived. After stopping the app, use the [manual recovery guide](recovery.md) to replay it locally into separate files. Recovery cannot restore audio that was never captured.

## Audio sources and permissions

- **Teams / system:** ScreenCaptureKit requires **System Settings → Privacy & Security → Screen & System Audio Recording**. A `-3801` error indicates permission was denied. The native helper is launched by your terminal app, not by Teams or the browser. For the Finder `.command` launcher, permission is usually attributed to **Terminal** (`/System/Applications/Utilities/Terminal.app`). If you run `scripts/start.sh` from cmux, allow **cmux** (`/Applications/cmux.app`); if you run it from VS Code, allow VS Code. If macOS instead lists `capture-audio` directly, allow the actual requesting item shown.
- After granting access, fully quit and reopen the responsible launcher app, then launch again. Save or stop other work running in that app first. You can alternatively launch from Terminal to avoid closing cmux. Do not reset global TCC permissions.
- If Terminal or cmux is missing from the Screen & System Audio Recording list, use **+**, press **⌘⇧G**, and enter the application path above. Microphone access is requested on Start; that permission pane may not show the launcher until it has requested access.
- **Microphone:** AVFoundation capture uses the default input selected in **System Settings → Sound → Input** and requires **System Settings → Privacy & Security → Microphone**, not screen access. It can be useful in a physical room to capture your voice, nearby voices, and room noise. It does not directly capture remote Teams audio; with laptop output muted, do not expect those remote voices to be picked up acoustically.

Setting the **Mac's speaker/output volume** to zero is expected to leave Teams' digital audio available for capture, but this has not been verified on this Mac. Do not mute playback inside Teams or select **Don't use audio** as a substitute: the assistant needs Teams to keep receiving/rendering the remote audio stream.
