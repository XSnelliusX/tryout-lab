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
    // Pipeline per input format: [floatConverter: any LPCM -> Float32 deinterleaved, same
    // rate and channels, identity channel map] -> explicit channel average -> [converter:
    // mono Float32 -> 16 kHz mono]. No gain, limiting or clamping is applied.
    private var converter: AVAudioConverter?
    private var floatConverter: AVAudioConverter?
    private var monoFormat: AVAudioFormat?
    private var inputFormat: AVAudioFormat?
    private var volumeTimer: DispatchSourceTimer?
    private var lastVolume: Float?
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
    // A full pipe is tolerated for up to 10 s without progress (no extra buffering here);
    // a closed reader fails at once with EPIPE (SIGPIPE is ignored).
    private func writePCM(_ buffer: AVAudioPCMBuffer) throws {
        let count = Int(buffer.frameLength) * MemoryLayout<Float>.size
        guard count > 0 else { return }
        guard let samples = buffer.floatChannelData?[0] else { throw CaptureFailure(message: "Invalid converted audio buffer") }
        let bytes = UnsafeRawPointer(samples).assumingMemoryBound(to: UInt8.self)
        let stallLimit: UInt64 = 10_000_000_000
        var stalledSince: UInt64 = 0
        var offset = 0
        while offset < count {
            let n = Darwin.write(STDOUT_FILENO, bytes.advanced(by: offset), count - offset)
            if n > 0 { offset += n; stalledSince = 0; continue }
            if n < 0 && errno == EINTR { continue }
            if n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) {
                let now = DispatchTime.now().uptimeNanoseconds
                if stalledSince == 0 { stalledSince = now }
                let waited = now - stalledSince
                guard waited < stallLimit else {
                    throw CaptureFailure(message: "Audio reader stalled or closed; capture stopped")
                }
                let remainingMs = (stallLimit - waited) / 1_000_000 + 1
                var fd = pollfd(fd: STDOUT_FILENO, events: Int16(POLLOUT), revents: 0)
                let ready = poll(&fd, 1, Int32(min(remainingMs, 1_000)))
                if ready < 0 && errno != EINTR {
                    throw CaptureFailure(message: "Audio output pipe closed or failed; capture stopped")
                }
                // Writable, hung up or timed out: retry the write, which makes progress,
                // reports EPIPE for a closed reader, or re-checks the stall deadline.
                continue
            }
            throw CaptureFailure(message: "Audio output pipe closed or failed; capture stopped")
        }
    }

    // Resamples mono Float32 at the input rate to the 16 kHz target.
    private func convert(_ input: AVAudioPCMBuffer?, endOfStream: Bool) throws {
        guard let converter else { return }
        let inputRate = converter.inputFormat.sampleRate
        let estimated = input.map { Double($0.frameLength) * target.sampleRate / inputRate } ?? 0
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

    // AVAudioFormat(streamDescription:) returns nil for more than 2 channels unless a
    // channel layout is supplied (AVAudioFormat.h). The layout only labels channels here,
    // because the downmix averages all of them, so a discrete in-order layout suffices.
    private func makeInputFormat(_ asbd: UnsafePointer<AudioStreamBasicDescription>) -> AVAudioFormat? {
        let channels = asbd.pointee.mChannelsPerFrame
        if channels <= 2 { return AVAudioFormat(streamDescription: asbd) }
        let tag = AudioChannelLayoutTag(kAudioChannelLayoutTag_DiscreteInOrder) | AudioChannelLayoutTag(channels)
        guard let layout = AVAudioChannelLayout(layoutTag: tag) else { return nil }
        return AVAudioFormat(streamDescription: asbd, channelLayout: layout)
    }

    private func configure(for format: AVAudioFormat) throws {
        converter = nil
        floatConverter = nil
        monoFormat = nil
        inputFormat = nil
        let channels = format.channelCount
        let floatFormat: AVAudioFormat
        if format.commonFormat == .pcmFormatFloat32 && (!format.isInterleaved || channels == 1) {
            floatFormat = format
        } else {
            let made: AVAudioFormat?
            if let layout = format.channelLayout {
                made = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: format.sampleRate,
                                     interleaved: false, channelLayout: layout)
            } else {
                made = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: format.sampleRate,
                                     channels: channels, interleaved: false)
            }
            guard let made, let next = AVAudioConverter(from: format, to: made) else {
                throw CaptureFailure(message: "Unsupported capture audio conversion")
            }
            // Same channel count in and out; an explicit identity map overrides any
            // layout-driven remapping (AVAudioConverter.h, channelMap).
            next.channelMap = (0..<Int(channels)).map { NSNumber(value: $0) }
            floatConverter = next
            floatFormat = made
        }
        let mono: AVAudioFormat
        if channels == 1 {
            mono = floatFormat
        } else {
            guard let made = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: format.sampleRate,
                                           channels: 1, interleaved: false) else {
                throw CaptureFailure(message: "Unsupported capture audio conversion")
            }
            mono = made
        }
        guard let resampler = AVAudioConverter(from: mono, to: target) else {
            throw CaptureFailure(message: "Unsupported capture audio conversion")
        }
        resampler.sampleRateConverterQuality = AVAudioQuality.max.rawValue
        resampler.sampleRateConverterAlgorithm = AVSampleRateConverterAlgorithm_Mastering
        converter = resampler
        monoFormat = mono
        inputFormat = format
    }

    // Integer or interleaved PCM -> Float32 deinterleaved at the same rate and channel count.
    private func toFloat(_ input: AVAudioPCMBuffer) throws -> AVAudioPCMBuffer {
        guard let floatConverter else { return input }
        guard let output = AVAudioPCMBuffer(pcmFormat: floatConverter.outputFormat, frameCapacity: input.frameLength) else {
            throw CaptureFailure(message: "Could not allocate audio conversion buffer")
        }
        do { try floatConverter.convert(to: output, from: input) }
        catch { throw CaptureFailure(message: "Audio sample format conversion failed") }
        guard output.frameLength == input.frameLength else {
            throw CaptureFailure(message: "Audio sample format conversion was incomplete")
        }
        return output
    }

    // Mono = arithmetic mean of all channels, sample by sample.
    private func downmix(_ buffer: AVAudioPCMBuffer) throws -> AVAudioPCMBuffer {
        let channels = Int(buffer.format.channelCount)
        if channels == 1 { return buffer }
        guard let monoFormat, !buffer.format.isInterleaved, buffer.format.commonFormat == .pcmFormatFloat32,
              let source = buffer.floatChannelData,
              let output = AVAudioPCMBuffer(pcmFormat: monoFormat, frameCapacity: buffer.frameLength),
              let destination = output.floatChannelData?[0] else {
            throw CaptureFailure(message: "Could not downmix captured audio")
        }
        let frames = Int(buffer.frameLength)
        let scale = 1 / Float(channels)
        for frame in 0..<frames {
            var sum: Float = 0
            for channel in 0..<channels { sum += source[channel][frame] }
            destination[frame] = sum * scale
        }
        output.frameLength = buffer.frameLength
        return output
    }

    private func consume(_ sampleBuffer: CMSampleBuffer) {
        guard !closed, !failed, CMSampleBufferIsValid(sampleBuffer), CMSampleBufferDataIsReady(sampleBuffer) else { return }
        do {
            guard let description = CMSampleBufferGetFormatDescription(sampleBuffer),
                  let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(description),
                  asbd.pointee.mFormatID == kAudioFormatLinearPCM,
                  let format = makeInputFormat(asbd),
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
                try configure(for: format)
                status("format", ["sample_rate": format.sampleRate, "channels": Int(format.channelCount)])
            }
            try convert(try downmix(try toFloat(input)), endOfStream: false)
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

    // Polls the device's input volume twice a second on queue and reports changes.
    // A timer is used rather than a CoreAudio listener block so that teardown is a
    // plain cancel on the same queue (see flush).
    func monitorInputVolume(deviceID: AudioDeviceID, initial: Float?) {
        queue.async {
            guard !self.closed, !self.failed, self.volumeTimer == nil else { return }
            self.lastVolume = initial
            let timer = DispatchSource.makeTimerSource(queue: self.queue)
            timer.setEventHandler { self.pollInputVolume(deviceID) }
            timer.schedule(deadline: .now() + .milliseconds(500), repeating: .milliseconds(500))
            self.volumeTimer = timer
            timer.resume()
        }
    }

    private func pollInputVolume(_ deviceID: AudioDeviceID) {
        guard !closed, !failed else { return }
        let volume = inputVolume(deviceID)
        guard volume != lastVolume else { return }
        lastVolume = volume
        status("input", ["input_volume": jsonVolume(volume)])
    }

    // Called after stopping capture, or when abandoning startup; drain queued
    // callbacks, flush the resampler, and prevent subsequent callbacks writing.
    func flush() -> Bool {
        queue.sync {
            volumeTimer?.cancel()
            volumeTimer = nil
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

private func started(_ source: String, device: [String: Any]? = nil) {
    var fields: [String: Any] = ["source": source, "format": "f32le", "sample_rate": 16000, "channels": 1, "protocol": 2]
    if let device { fields["device"] = device }
    status("started", fields)
}

// CoreAudio property queries only: these read the HAL's device list and settings and
// do not open an input stream, so they need no microphone permission.
private func audioAddress(_ selector: AudioObjectPropertySelector,
                          _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
                          _ element: AudioObjectPropertyElement = kAudioObjectPropertyElementMain) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: element)
}

private func audioDeviceIDs() -> [AudioDeviceID]? {
    var address = audioAddress(kAudioHardwarePropertyDevices)
    var size: UInt32 = 0
    let system = AudioObjectID(kAudioObjectSystemObject)
    guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr else { return nil }
    let stride = MemoryLayout<AudioDeviceID>.size
    var ids = [AudioDeviceID](repeating: kAudioObjectUnknown, count: Int(size) / stride)
    guard !ids.isEmpty else { return [] }
    guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &ids) == noErr else { return nil }
    return Array(ids.prefix(Int(size) / stride))
}

private func defaultInputDeviceID() -> AudioDeviceID? {
    var address = audioAddress(kAudioHardwarePropertyDefaultInputDevice)
    var deviceID: AudioDeviceID = kAudioObjectUnknown
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceID) == noErr,
          deviceID != kAudioObjectUnknown else { return nil }
    return deviceID
}

// kAudioDevicePropertyDeviceUID and kAudioObjectPropertyName return a CFString the
// caller must release (AudioHardware.h, AudioHardwareBase.h).
private func stringProperty(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    var address = audioAddress(selector)
    var pointer: UnsafeRawPointer?
    var size = UInt32(MemoryLayout<UnsafeRawPointer?>.size)
    guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &pointer) == noErr, let pointer else { return nil }
    return Unmanaged<CFString>.fromOpaque(pointer).takeRetainedValue() as String
}

private func uint32Property(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
    var address = audioAddress(selector)
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr else { return nil }
    return value
}

private func nominalSampleRate(_ id: AudioDeviceID) -> Double? {
    var address = audioAddress(kAudioDevicePropertyNominalSampleRate)
    var value: Float64 = 0
    var size = UInt32(MemoryLayout<Float64>.size)
    guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr, value > 0 else { return nil }
    return value
}

// Total channels over the device's input streams; 0 for output-only devices.
private func inputChannelCount(_ id: AudioDeviceID) -> Int {
    var address = audioAddress(kAudioDevicePropertyStreamConfiguration, kAudioDevicePropertyScopeInput)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size) == noErr,
          Int(size) >= MemoryLayout<AudioBufferList>.size else { return 0 }
    let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { raw.deallocate() }
    guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, raw) == noErr else { return 0 }
    let buffers = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
    var channels = 0
    for buffer in buffers { channels += Int(buffer.mNumberChannels) }
    return channels
}

private func transportName(_ id: AudioDeviceID) -> String {
    guard let value = uint32Property(id, kAudioDevicePropertyTransportType) else { return "other" }
    if value == UInt32(kAudioDeviceTransportTypeBuiltIn) { return "built-in" }
    if value == UInt32(kAudioDeviceTransportTypeUSB) { return "usb" }
    if value == UInt32(kAudioDeviceTransportTypeBluetooth) || value == UInt32(kAudioDeviceTransportTypeBluetoothLE) { return "bluetooth" }
    if value == UInt32(kAudioDeviceTransportTypeAggregate) { return "aggregate" }
    if value == UInt32(kAudioDeviceTransportTypeVirtual) { return "virtual" }
    return "other"
}

// Input volume: the main element if present, else channel 1, else channel 2.
// Many USB and Bluetooth inputs expose none.
private func inputVolumeAddress(_ id: AudioDeviceID) -> AudioObjectPropertyAddress? {
    let elements: [AudioObjectPropertyElement] = [kAudioObjectPropertyElementMain, 1, 2]
    for element in elements {
        var address = audioAddress(kAudioDevicePropertyVolumeScalar, kAudioDevicePropertyScopeInput, element)
        if AudioObjectHasProperty(id, &address) { return address }
    }
    return nil
}

private func inputVolume(_ id: AudioDeviceID) -> Float? {
    guard var address = inputVolumeAddress(id) else { return nil }
    var value: Float32 = 0
    var size = UInt32(MemoryLayout<Float32>.size)
    guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr else { return nil }
    return value
}

private func inputVolumeSettable(_ id: AudioDeviceID) -> Bool {
    guard var address = inputVolumeAddress(id) else { return false }
    var settable: DarwinBoolean = false
    return AudioObjectIsPropertySettable(id, &address, &settable) == noErr && settable.boolValue
}

private func jsonVolume(_ volume: Float?) -> Any {
    guard let volume, volume.isFinite else { return NSNull() }
    // Four decimals, serialized exactly (a Double would print as 0.67600000000000005).
    return NSDecimalNumber(string: String(format: "%.4f", Double(volume)))
}

private func deviceInfo(_ id: AudioDeviceID, defaultID: AudioDeviceID?) -> [String: Any]? {
    guard let uid = stringProperty(id, kAudioDevicePropertyDeviceUID) else { return nil }
    let rate: Any = nominalSampleRate(id) ?? NSNull()
    return ["uid": uid,
            "name": stringProperty(id, kAudioObjectPropertyName) ?? uid,
            "transport": transportName(id),
            "sample_rate": rate,
            "channels": inputChannelCount(id),
            "is_default": id == defaultID,
            "input_volume": jsonVolume(inputVolume(id)),
            "input_volume_settable": inputVolumeSettable(id)]
}

private func setInputVolume(_ value: Float, deviceUID: String?) -> Int32 {
    guard value.isFinite, value >= 0, value <= 1 else {
        status("error", ["message": "Input volume must be between 0.0 and 1.0"])
        return 2
    }
    let id: AudioDeviceID
    do {
        id = try selectInputDevice(deviceUID)
    } catch let failure as CaptureFailure {
        status("error", ["message": failure.message])
        return 1
    } catch {
        status("error", ["message": "Could not select input device"])
        return 1
    }
    guard transportName(id) != "virtual", inputVolumeSettable(id) else {
        status("error", ["message": "This input device does not support direct microphone input volume control."])
        return 1
    }
    let elements: [AudioObjectPropertyElement]
    var mainAddr = audioAddress(kAudioDevicePropertyVolumeScalar, kAudioDevicePropertyScopeInput, kAudioObjectPropertyElementMain)
    if AudioObjectHasProperty(id, &mainAddr) {
        var settable: DarwinBoolean = false
        if AudioObjectIsPropertySettable(id, &mainAddr, &settable) == noErr && settable.boolValue {
            elements = [kAudioObjectPropertyElementMain]
        } else {
            elements = []
        }
    } else {
        elements = [1, 2].filter { elem in
            var addr = audioAddress(kAudioDevicePropertyVolumeScalar, kAudioDevicePropertyScopeInput, elem)
            var settable: DarwinBoolean = false
            return AudioObjectHasProperty(id, &addr) && AudioObjectIsPropertySettable(id, &addr, &settable) == noErr && settable.boolValue
        }
    }
    guard !elements.isEmpty else {
        status("error", ["message": "This input device does not support direct microphone input volume control."])
        return 1
    }
    var target = value
    let size = UInt32(MemoryLayout<Float32>.size)
    for elem in elements {
        var addr = audioAddress(kAudioDevicePropertyVolumeScalar, kAudioDevicePropertyScopeInput, elem)
        guard AudioObjectSetPropertyData(id, &addr, 0, nil, size, &target) == noErr else {
            status("error", ["message": "macOS rejected setting microphone input volume on this device."])
            return 1
        }
    }
    guard let readBack = inputVolume(id), abs(readBack - value) <= 0.025 else {
        status("error", ["message": "This input device ignored direct microphone input volume control."])
        return 1
    }
    let uid = stringProperty(id, kAudioDevicePropertyDeviceUID) ?? deviceUID ?? ""
    status("input_volume", ["uid": uid, "input_volume": jsonVolume(readBack), "input_volume_settable": true])
    return 0
}

private func listInputDevices() -> Int32 {
    guard let ids = audioDeviceIDs() else {
        status("error", ["message": "Could not enumerate audio devices"])
        return 1
    }
    let defaultID = defaultInputDeviceID()
    for id in ids where inputChannelCount(id) > 0 {
        if let info = deviceInfo(id, defaultID: defaultID) { status("device", info) }
    }
    return 0
}

// Without a UID, resolve the actual Sound > Input selection, not the first enumerated
// device. The session keeps this device until capture is restarted.
private func selectInputDevice(_ uid: String?) throws -> AudioDeviceID {
    guard let uid else {
        guard let id = defaultInputDeviceID() else {
            throw CaptureFailure(message: "No default microphone is available. Select an input in macOS System Settings > Sound > Input.")
        }
        return id
    }
    for id in audioDeviceIDs() ?? [] where inputChannelCount(id) > 0 && stringProperty(id, kAudioDevicePropertyDeviceUID) == uid {
        return id
    }
    throw CaptureFailure(message: "Input device not found: \(uid). Use --list-devices to see available inputs.")
}

private func captureDevice(_ id: AudioDeviceID) throws -> AVCaptureDevice {
    guard let uid = stringProperty(id, kAudioDevicePropertyDeviceUID),
          let device = AVCaptureDevice(uniqueID: uid), device.hasMediaType(.audio) else {
        throw CaptureFailure(message: "The selected sound input is unavailable for microphone capture. Select an input in macOS System Settings > Sound > Input and retry.")
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
    // captureMicrophone (macOS 15+) defaults to NO per SCStream.h; it is not set, so
    // the helper does not depend on its availability.
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

private func runMicrophone(deviceUID: String?, completion: Completion, output: AudioOutput) async throws -> Int32 {
    // Resolve the CoreAudio device before any permission prompt, so an unknown
    // --device fails without one.
    let deviceID = try selectInputDevice(deviceUID)
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
    let device = try captureDevice(deviceID)
    let session = AVCaptureSession()
    let input = try AVCaptureDeviceInput(device: device)
    guard session.canAddInput(input) else { throw CaptureFailure(message: "Could not add the microphone input") }
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
        throw CaptureFailure(message: "Could not start the microphone")
    }
    if !completion.isFinished {
        // Read the volume before the device snapshot: a change in between is then
        // reported by the monitor rather than lost.
        let initialVolume = inputVolume(deviceID)
        started("microphone", device: deviceInfo(deviceID, defaultID: defaultInputDeviceID()))
        output.monitorInputVolume(deviceID: deviceID, initial: initialVolume)
    }
    let code = await completion.wait()
    session.stopRunning()
    return code
}

@main
private struct CaptureAudio {
    // Returns (source, device UID) for a capture invocation, nil for a usage error.
    static func parseCapture(_ args: [String]) -> (source: String, device: String?)? {
        var source: String?
        var device: String?
        var index = 0
        while index < args.count {
            guard index + 1 < args.count else { return nil }
            let name = args[index]
            let value = args[index + 1]
            if name == "--source" && source == nil && ["teams", "system", "microphone"].contains(value) {
                source = value
            } else if name == "--device" && device == nil && !value.isEmpty && !value.hasPrefix("--") {
                device = value
            } else {
                return nil
            }
            index += 2
        }
        guard let source else { return nil }
        if device != nil && source != "microphone" { return nil }
        return (source, device)
    }

    // Returns (volume, device UID) for --set-input-volume <0..1> [--device <uid>], nil otherwise.
    static func parseSetInputVolume(_ args: [String]) -> (volume: Float, device: String?)? {
        guard !args.isEmpty else { return nil }
        var volume: Float?
        var device: String?
        var index = 0
        while index < args.count {
            guard index + 1 < args.count else { return nil }
            let name = args[index]
            let value = args[index + 1]
            if name == "--set-input-volume" && volume == nil, let parsed = Float(value), parsed.isFinite {
                volume = parsed
            } else if name == "--device" && device == nil && !value.isEmpty && !value.hasPrefix("--") {
                device = value
            } else {
                return nil
            }
            index += 2
        }
        guard let volume else { return nil }
        return (volume, device)
    }

    static func main() async {
        signal(SIGPIPE, SIG_IGN)
        // Install signal handling first so an early stop request is never lost.
        let completion = Completion()
        var signals: [DispatchSourceSignal] = []
        for number in [SIGINT, SIGTERM] {
            signal(number, SIG_IGN)
            let handler = DispatchSource.makeSignalSource(signal: number, queue: .global())
            handler.setEventHandler { completion.finish(0) }
            handler.resume()
            signals.append(handler)
        }
        let args = Array(CommandLine.arguments.dropFirst())
        if args == ["--version"] {
            status("version", ["protocol": 2])
            exit(0)
        }
        if args == ["--list-devices"] {
            exit(listInputDevices())
        }
        if let volumeRequest = parseSetInputVolume(args) {
            exit(setInputVolume(volumeRequest.volume, deviceUID: volumeRequest.device))
        }
        let listOnly = args == ["--list-apps"]
        let capture = listOnly ? nil : parseCapture(args)
        guard listOnly || capture != nil else {
            status("error", ["message": "Usage: capture-audio --source teams|system|microphone [--device <uid>] (--device only with microphone) OR capture-audio --set-input-volume <0..1> [--device <uid>] OR capture-audio --list-apps|--list-devices|--version"])
            exit(2)
        }
        let source = capture?.source ?? ""
        let deviceUID = capture?.device
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
                code = try await runMicrophone(deviceUID: deviceUID, completion: completion, output: output)
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
