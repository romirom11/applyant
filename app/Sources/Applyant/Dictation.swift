// Speaking an answer instead of typing it: the Mac's own speech recognition (the Speech
// framework) turns the microphone into text in the answer field, live. Nothing is recorded or
// kept: the audio goes to the recogniser and only the text stays, for the candidate to correct
// before sending. On-device recognition is used when the Mac has it for the language; otherwise
// Apple's servers do it (macOS says so when it asks for permission).
@preconcurrency import AVFoundation
import ApplyantKit
import Observation
@preconcurrency import Speech

@MainActor @Observable
final class Dictation {
    enum State: Equatable {
        case idle
        case starting
        case listening
        case failed(String)
    }

    private(set) var state: State = .idle
    /// The recogniser's locale ("uk-UA"); remembered between launches.
    var locale: String? {
        didSet { UserDefaults.standard.set(locale, forKey: Self.localeKey) }
    }

    private static let localeKey = "dictation.locale"
    private let engine = AVAudioEngine()
    private let feed = AudioFeed()
    private var recognizer: SFSpeechRecognizer?
    private var task: SFSpeechRecognitionTask?
    private var text = DictationText(base: "")
    private var onText: ((String) -> Void)?
    /// Counts recognition tasks, so a late callback of an old one is ignored.
    private var generation = 0

    init() {
        locale = UserDefaults.standard.string(forKey: Self.localeKey)
    }

    var listening: Bool { state == .listening || state == .starting }

    /// The locales the recogniser knows (identifiers like "uk-UA").
    static var supported: [String] {
        SFSpeechRecognizer.supportedLocales().map { $0.identifier.replacingOccurrences(of: "_", with: "-") }
    }

    /// Starts dictating after `base`; every change of the text goes to `onText`.
    func start(base: String, onText: @escaping (String) -> Void) {
        guard !listening, let locale else { return }
        state = .starting
        text = DictationText(base: base)
        self.onText = onText
        Task {
            guard await Self.allowed() else {
                state = .failed("Allow Applyant to use the microphone and speech recognition in System Settings → Privacy & Security.")
                return
            }
            guard state == .starting else { return }
            guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)), recognizer.isAvailable else {
                state = .failed("Speech recognition isn't available for this language right now.")
                return
            }
            self.recognizer = recognizer
            do {
                try listen()
                state = .listening
            } catch {
                stopAudio()
                state = .failed("The microphone couldn't be started: \(error.localizedDescription)")
            }
        }
    }

    func stop() {
        guard listening else { return }
        state = .idle
        generation += 1
        task?.finish()
        task = nil
        stopAudio()
        text.commit()
        onText?(text.text)
    }

    /// Microphone and speech recognition, asked for once each.
    private static func allowed() async -> Bool {
        let speech = await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
            SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0 == .authorized) }
        }
        guard speech else { return false }
        return await AVCaptureDevice.requestAccess(for: .audio)
    }

    private func listen() throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        let feed = feed
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in feed.append(buffer) }
        engine.prepare()
        try engine.start()
        recognize()
    }

    /// One recognition task. A task ends by itself after a pause or (on Apple's servers) about a
    /// minute; while the candidate is still dictating the next one picks up.
    private func recognize() {
        guard let recognizer else { return }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        feed.request = request
        generation += 1
        let mine = generation
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            let heard = result?.bestTranscription.formattedString
            let final = result?.isFinal ?? false
            let failed = error != nil
            Task { @MainActor in self?.heard(heard, final: final, failed: failed, generation: mine) }
        }
    }

    private func heard(_ phrase: String?, final: Bool, failed: Bool, generation mine: Int) {
        guard mine == generation, state == .listening else { return }
        if let phrase {
            text.partial = phrase
            onText?(text.text)
        }
        guard final || failed else { return }
        text.commit()
        onText?(text.text)
        recognize()
    }

    private func stopAudio() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        feed.request?.endAudio()
        feed.request = nil
    }
}

/// The audio thread's side: microphone buffers go to whichever recognition request is current.
private final class AudioFeed: @unchecked Sendable {
    private let lock = NSLock()
    private var current: SFSpeechAudioBufferRecognitionRequest?

    var request: SFSpeechAudioBufferRecognitionRequest? {
        get { lock.withLock { current } }
        set { lock.withLock { current = newValue } }
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        lock.withLock { current }?.append(buffer)
    }
}
