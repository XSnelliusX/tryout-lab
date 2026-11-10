#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
mkdir -p "$ROOT/.build"
xcrun swiftc -swift-version 5 -parse-as-library -O \
  -framework ScreenCaptureKit -framework AVFoundation -framework CoreMedia -framework CoreAudio \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist \
  -Xlinker "$ROOT/native/CaptureAudio-Info.plist" \
  "$ROOT/native/CaptureAudio.swift" -o "$ROOT/.build/capture-audio.new"
codesign --force --sign - --identifier org.meeting-assistant.capture-audio "$ROOT/.build/capture-audio.new"
mv -f "$ROOT/.build/capture-audio.new" "$ROOT/.build/capture-audio"
printf '%s\n' "Built $ROOT/.build/capture-audio" >&2
