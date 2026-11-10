@preconcurrency import AVFoundation
import CoreMedia
import CoreAudio
import Darwin
import Foundation
import ScreenCaptureKit

// stdout is reserved exclusively for little-endian mono Float32 PCM at 16 kHz.
private let statusLock = NSLock()
private func status(_ event: String, _ fields: [String: Any] = [:]) {
    var object = fields
    object["event"] = event
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
    statusLock.lock()
    defer { statusLock.unlock() }
    FileHandle.standardError.write(data + Data([10]))
}

private struct CaptureFailure: Error {
    let message: String
}

// Remember early failures/signals too, including those occurring during startCapture.
private final class Completion: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Int32?
    private var waiters: [CheckedContinuation<Int32, Never>] = []

    func finish(_ code: Int32) {
        lock.lock()
        guard result == nil else { lock.unlock(); return }
        result = code
        let continuations = waiters
        waiters.removeAll()
        lock.unlock()
        for continuation in continuations { continuation.resume(returning: code) }
    }

    func wait() async -> Int32 {
        await withCheckedContinuation { continuation in
            lock.lock()
            if let result {
                lock.unlock()
                continuation.resume(returning: result)
            } else {
                waiters.append(continuation)
                lock.unlock()
            }
        }
    }

    var isFinished: Bool {
        lock.lock()
        defer { lock.unlock() }
        return result != nil
    }
}

// An unstructured race is intentional: waiting for a macOS permission dialog must
// not keep the process alive after SIGINT/SIGTERM. Exit tears down an abandoned
// startup operation; callbacks are closed and drained before that happens.
private final class StartupRace<Value> {
    private let lock = NSLock()
    private var resolved = false
    private let continuation: CheckedContinuation<Value?, Never>

    init(_ continuation: CheckedContinuation<Value?, Never>) { self.continuation = continuation }

    func resolve(_ value: Value?) {
        lock.lock()
        guard !resolved else { lock.unlock(); return }
        resolved = true
        lock.unlock()
        continuation.resume(returning: value)
    }
}

private func duringStartup<Value>(completion: Completion, operation: @escaping () async throws -> Value) async throws -> Value? {
    let result: Result<Value, Error>? = await withCheckedContinuation { continuation in
        let race = StartupRace<Result<Value, Error>>(continuation)
        Task { _ = await completion.wait(); race.resolve(nil) }
        Task {
            guard !completion.isFinished else { race.resolve(nil); return }
            do { race.resolve(.success(try await operation())) }
            catch { race.resolve(.failure(error)) }
        }
    }
    return try result?.get()
}

// Mutable conversion state and callback shutdown are confined to queue.
private final class AudioOutput: NSObject, SCStreamOutput, SCStreamDelegate, AVCaptureAudioDataOutputSampleBufferDelegate, @unchecked Sendable {
    let queue = DispatchQueue(label: "meeting-assistant.capture.audio")
    private let completion: Completion
    private let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000,
                                       channels: 1, interleaved: false)!
    private var converter: AVAudioConverter?
    private var inputFormat: AVAudioFormat?
    private var failed = false
    private var closed = false

    init(completion: Completion) { self.completion = completion }

    private func fail(_ message: String) {
        guard !failed else { return }
        failed = true
        status("error", ["message": message])
        completion.finish(1)
    }

    // Nonblocking output ensures a stalled or closed reader does not silently drop audio.
    private func writePCM(_ buffer: AVAudioPCMBuffer) throws {
        let count = Int(buffer.frameLength) * MemoryLayout<Float>.size
        guard count > 0 else { return }
        guard let samples = buffer.floatChannelData?[0] else { throw CaptureFailure(message: "Invalid converted audio buffer") }
        let bytes = UnsafeRawPointer(samples).assumingMemoryBound(to: UInt8.self)
        var offset = 0
        while offset < count {
            let n = Darwin.write(STDOUT_FILENO, bytes.advanced(by: offset), count - offset)
            if n > 0 { offset += n; continue }
            if n < 0 && errno == EINTR { continue }
            if n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) {
                var fd = pollfd(fd: STDOUT_FILENO, events: Int16(POLLOUT), revents: 0)
                let ready = poll(&fd, 1, 2_000)
                if ready < 0 && errno == EINTR { continue }
                if ready > 0 && (fd.revents & Int16(POLLOUT)) != 0 { continue }
                throw CaptureFailure(message: "Audio reader stalled or closed; capture stopped")
            }
            throw CaptureFailure(message: "Audio output pipe closed or failed; capture stopped")
        }
    }

    private func convert(_ input: AVAudioPCMBuffer?, endOfStream: Bool) throws {
        guard let converter, let inputFormat else { return }
        let estimated = input.map { Double($0.frameLength) * target.sampleRate / inputFormat.sampleRate } ?? 0
        guard estimated.isFinite, estimated < Double(UInt32.max - 4096) else {
            throw CaptureFailure(message: "Invalid audio frame count")
        }
        let capacity = AVAudioFrameCount(max(4096, Int(ceil(estimated)) + 4096))
        var supplied = false
        while true {
            guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else {
                throw CaptureFailure(message: "Could not allocate audio conversion buffer")
            }
            var error: NSError?
            let result = converter.convert(to: output, error: &error) { _, state in
                if !supplied, let input {
                    supplied = true
                    state.pointee = .haveData
                    return input
                }
                state.pointee = endOfStream ? .endOfStream : .noDataNow
                return nil
            }
            try writePCM(output)
            switch result {
            case .haveData:
                guard output.frameLength > 0 else {
                    throw CaptureFailure(message: "Audio converter made no progress")
                }
                continue
            case .inputRanDry, .endOfStream:
                return
            case .error:
                throw CaptureFailure(message: "Audio format conversion failed")
            @unknown default:
                throw CaptureFailure(message: "Unexpected audio converter status")
            }
        }
    }

    private func consume(_ sampleBuffer: CMSampleBuffer) {
        guard !closed, !failed, CMSampleBufferIsValid(sampleBuffer), CMSampleBufferDataIsReady(sampleBuffer) else { return }
        do {
            guard let description = CMSampleBufferGetFormatDescription(sampleBuffer),
                  let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(description),
                  asbd.pointee.mFormatID == kAudioFormatLinearPCM,
                  let format = AVAudioFormat(streamDescription: asbd),
                  format.sampleRate > 0, format.channelCount > 0 else {
                throw CaptureFailure(message: "Unsupported capture audio format")
            }
            let samples = CMSampleBufferGetNumSamples(sampleBuffer)
            guard samples > 0, samples <= Int(Int32.max),
                  let input = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples)) else {
                throw CaptureFailure(message: "Invalid capture audio buffer")
            }
            input.frameLength = AVAudioFrameCount(samples)
            let copyStatus = CMSampleBufferCopyPCMDataIntoAudioBufferList(sampleBuffer, at: 0, frameCount: Int32(samples), into: input.mutableAudioBufferList)
            guard copyStatus == noErr else { throw CaptureFailure(message: "Could not copy captured PCM") }
            if inputFormat == nil || !inputFormat!.isEqual(format) {
                if converter != nil { try convert(nil, endOfStream: true) }
                guard let next = AVAudioConverter(from: format, to: target) else {
                    throw CaptureFailure(message: "Unsupported capture audio conversion")
                }
                converter = next
                inputFormat = format
            }
            try convert(input, endOfStream: false)
        } catch {
            fail((error as? CaptureFailure)?.message ?? "Audio processing failed")
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        if type == .audio { consume(sampleBuffer) }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        consume(sampleBuffer)
    }

    func reportError(_ message: String, error: NSError? = nil, permission: String? = nil) {
        queue.async {
            guard !self.closed, !self.failed else { return }
            self.failed = true
            var fields: [String: Any] = ["message": message]
            if let error { fields["domain"] = error.domain; fields["code"] = error.code }
            if let permission { fields["permission"] = permission }
            status("error", fields)
            self.completion.finish(1)
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        let nsError = error as NSError
        reportError(nsError.code == -3801 ? screenDeniedMessage : "ScreenCaptureKit stream interrupted",
                    error: nsError, permission: nsError.code == -3801 ? "screen" : nil)
    }

    // Called after stopping capture, or when abandoning startup; drain queued
    // callbacks, flush the resampler, and prevent subsequent callbacks writing.
    func flush() -> Bool {
        queue.sync {
            closed = true
            guard !failed else { return false }
            do { try convert(nil, endOfStream: true) }
            catch { fail((error as? CaptureFailure)?.message ?? "Audio flush failed") }
            return !failed
        }
    }
}

private let screenDeniedMessage = "Screen & System Audio Recording permission denied. Enable Terminal if using the double-click launcher, or your terminal app (e.g. cmux) if launched there, in System Settings > Privacy & Security > Screen & System Audio Recording; fully quit and reopen that app."
private let microphoneDeniedMessage = "Microphone permission denied or restricted. Enable Terminal if using the double-click launcher, or your terminal app (e.g. cmux) if launched there, in System Settings > Privacy & Security > Microphone; fully quit and reopen that app."

private func started(_ source: String) {
    status("started", ["source": source, "format": "f32le", "sample_rate": 16000, "channels": 1])
}

// Resolve the actual Sound > Input selection, not the first enumerated device.
// The session keeps this device until capture is restarted.
private func defaultMicrophone() throws -> AVCaptureDevice {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice,
                                             mScope: kAudioObjectPropertyScopeGlobal,
                                             mElement: kAudioObjectPropertyElementMain)
    var deviceID: AudioDeviceID = kAudioObjectUnknown
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceID) == noErr,
          deviceID != kAudioObjectUnknown else {
        throw CaptureFailure(message: "No default microphone is available. Select an input in macOS System Settings > Sound > Input.")
    }
    address.mSelector = kAudioDevicePropertyDeviceUID
    var uidPointer: UnsafeRawPointer?
    size = UInt32(MemoryLayout<UnsafeRawPointer?>.size)
    guard AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &uidPointer) == noErr,
          let uidPointer else {
        throw CaptureFailure(message: "The default sound input is unavailable for microphone capture. Select an input in macOS System Settings > Sound > Input and retry.")
    }
    let uid = Unmanaged<CFString>.fromOpaque(uidPointer).takeRetainedValue() as String
    guard let device = AVCaptureDevice(uniqueID: uid), device.hasMediaType(.audio) else {
        throw CaptureFailure(message: "The default sound input is unavailable for microphone capture. Select an input in macOS System Settings > Sound > Input and retry.")
    }
    return device
}

private func runScreen(source: String, listOnly: Bool, completion: Completion, output: AudioOutput) async throws -> Int32 {
    status("permission", ["permission": "screen", "message": "macOS may request Screen & System Audio Recording permission for the launching app (Terminal for the double-click launcher, or your terminal app such as cmux). Allow it in System Settings > Privacy & Security, then fully quit and reopen that app if needed."])
    guard let content = try await duringStartup(completion: completion, operation: {
        try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    }), !completion.isFinished else { return await completion.wait() }
    if listOnly {
        for app in content.applications.sorted(by: { $0.bundleIdentifier < $1.bundleIdentifier }) {
            status("app", ["bundle_id": app.bundleIdentifier, "name": app.applicationName, "pid": app.processID])
        }
        return 0
    }
    guard let display = content.displays.first else {
        throw CaptureFailure(message: "No display is available for ScreenCaptureKit audio capture")
    }
    let filter: SCContentFilter
    if source == "teams" {
        let ids: Set<String> = ["com.microsoft.teams2", "com.microsoft.teams"]
        let teams = content.applications.filter { ids.contains($0.bundleIdentifier.lowercased()) }
        guard !teams.isEmpty else {
            throw CaptureFailure(message: "Teams desktop app not found. Open Teams and retry; use --list-apps to inspect bundle IDs. System-wide capture requires explicit --source system.")
        }
        filter = SCContentFilter(display: display, including: teams, exceptingWindows: [])
    } else {
        filter = SCContentFilter(display: display, excludingWindows: [])
    }
    let config = SCStreamConfiguration()
    config.width = 2
    config.height = 2
    config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
    config.queueDepth = 3
    config.capturesAudio = true
    config.excludesCurrentProcessAudio = true
    config.sampleRate = 16_000
    config.channelCount = 1
    config.captureMicrophone = false
    let stream = SCStream(filter: filter, configuration: config, delegate: output)
    try stream.addStreamOutput(output, type: .audio, sampleHandlerQueue: output.queue)
    guard !completion.isFinished else { return await completion.wait() }
    guard let _ = try await duringStartup(completion: completion, operation: {
        try await stream.startCapture()
    }) else { return await completion.wait() }
    if !completion.isFinished { started(source) }
    var code = await completion.wait()
    do { try await stream.stopCapture() }
    catch {
        let error = error as NSError
        status("error", ["message": "Failed to stop capture cleanly", "domain": error.domain, "code": error.code])
        code = 1
    }
    return code
}

private func runMicrophone(completion: Completion, output: AudioOutput) async throws -> Int32 {
    status("permission", ["permission": "microphone", "message": "macOS may request Microphone access for the launching app (Terminal for the double-click launcher, or your terminal app such as cmux). Select the input in macOS System Settings > Sound > Input."])
    let authorization = AVCaptureDevice.authorizationStatus(for: .audio)
    var allowed = authorization == .authorized
    if authorization == .notDetermined {
        guard let granted = try await duringStartup(completion: completion, operation: {
            await AVCaptureDevice.requestAccess(for: .audio)
        }), !completion.isFinished else { return await completion.wait() }
        allowed = granted
    }
    if !allowed {
        let current = AVCaptureDevice.authorizationStatus(for: .audio)
        status("error", ["message": microphoneDeniedMessage, "permission": "microphone", "domain": "AVAuthorizationStatus", "code": current.rawValue])
        return 1
    }
    guard !completion.isFinished else { return await completion.wait() }
    let device = try defaultMicrophone()
    let session = AVCaptureSession()
    let input = try AVCaptureDeviceInput(device: device)
    guard session.canAddInput(input) else { throw CaptureFailure(message: "Could not add the default microphone input") }
    session.addInput(input)
    let audio = AVCaptureAudioDataOutput()
    guard session.canAddOutput(audio) else { throw CaptureFailure(message: "Could not add microphone audio output") }
    session.addOutput(audio)
    audio.setSampleBufferDelegate(output, queue: output.queue)
    let center = NotificationCenter.default
    let runtimeError = center.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: nil) { notification in
        let error = notification.userInfo?[AVCaptureSessionErrorKey] as? NSError
        output.reportError("Microphone capture failed", error: error)
    }
    let interrupted = center.addObserver(forName: AVCaptureSession.wasInterruptedNotification, object: session, queue: nil) { _ in
        output.reportError("Microphone capture was interrupted")
    }
    let disconnected = center.addObserver(forName: AVCaptureDevice.wasDisconnectedNotification, object: device, queue: nil) { _ in
        output.reportError("The selected microphone was disconnected. Select an input in macOS System Settings > Sound > Input and restart capture.")
    }
    defer {
        center.removeObserver(runtimeError)
        center.removeObserver(interrupted)
        center.removeObserver(disconnected)
    }
    guard !completion.isFinished else { return await completion.wait() }
    // startRunning is synchronous and can block; the startup race lets signals
    // terminate even if macOS is still bringing up the input device.
    guard let running = try await duringStartup(completion: completion, operation: {
        await withCheckedContinuation { continuation in
            DispatchQueue.global().async {
                guard !completion.isFinished else { continuation.resume(returning: false); return }
                session.startRunning()
                continuation.resume(returning: session.isRunning)
            }
        }
    }) else { return await completion.wait() }
    guard running else {
        if completion.isFinished { return await completion.wait() }
        throw CaptureFailure(message: "Could not start the default microphone")
    }
    if !completion.isFinished { started("microphone") }
    let code = await completion.wait()
    session.stopRunning()
    return code
}

@main
private struct CaptureAudio {
    static func main() async {
        signal(SIGPIPE, SIG_IGN)
        let args = Array(CommandLine.arguments.dropFirst())
        guard args == ["--list-apps"] || (args.count == 2 && args[0] == "--source" && ["teams", "system", "microphone"].contains(args[1])) else {
            status("error", ["message": "Usage: capture-audio --source teams|system|microphone OR capture-audio --list-apps"])
            exit(2)
        }
        let listOnly = args == ["--list-apps"]
        let source = listOnly ? "" : args[1]
        let completion = Completion()
        var signals: [DispatchSourceSignal] = []
        for number in [SIGINT, SIGTERM] {
            signal(number, SIG_IGN)
            let handler = DispatchSource.makeSignalSource(signal: number, queue: .global())
            handler.setEventHandler { completion.finish(0) }
            handler.resume()
            signals.append(handler)
        }
        let output = AudioOutput(completion: completion)
        var code: Int32 = 0
        do {
            if !listOnly {
                let flags = fcntl(STDOUT_FILENO, F_GETFL)
                guard flags >= 0, fcntl(STDOUT_FILENO, F_SETFL, flags | O_NONBLOCK) == 0 else {
                    throw CaptureFailure(message: "Could not configure audio output pipe")
                }
            }
            if source == "microphone" {
                code = try await runMicrophone(completion: completion, output: output)
            } else {
                code = try await runScreen(source: source, listOnly: listOnly, completion: completion, output: output)
            }
        } catch {
            if completion.isFinished {
                code = await completion.wait()
            } else if let failure = error as? CaptureFailure {
                status("error", ["message": failure.message])
                code = 1
            } else {
                let error = error as NSError
                let denied = source != "microphone" && error.code == -3801
                var fields: [String: Any] = ["message": denied ? screenDeniedMessage : (source == "microphone" ? "Microphone capture failed" : "ScreenCaptureKit failed"), "domain": error.domain, "code": error.code]
                if denied { fields["permission"] = "screen" }
                status("error", fields)
                code = 1
            }
        }
        if !output.flush() { code = 1 }
        if !listOnly || completion.isFinished { status("stopped", ["exit_code": code]) }
        withExtendedLifetime(signals) {}
        exit(code)
    }
}
