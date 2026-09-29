// classify_email (phase 13): what a reply to an application is, decided on the Mac by Apple's
// on-device Foundation Models, so mail never leaves it.
//
//   → {"id": 7, "op": "classify_email", "subject": "…", "body": "…", "from": "…"}
//   ← {"id": 7, "ok": true, "result": {"label": "interview", "confidence": 0.86, "language": "en"}}
//
// Labels are the daemon's EMAIL_LABELS (daemon/src/db/schema.ts). Whenever the model can't
// answer (Apple Intelligence off, the device not eligible, the model still downloading, a
// language it doesn't support, a guardrail, a low-confidence guess) the answer is
// {"label": "unknown", "confidence": 0}: the daemon then asks the candidate which application
// the email belongs to. It is an answer, not an error, so the email is never retried elsewhere.
import Foundation
import NaturalLanguage
#if canImport(FoundationModels)
import FoundationModels
#endif

public enum EmailLabel: String, CaseIterable, Sendable {
    case rejection, interview, offer, acknowledgement
    case securityCode = "security_code"
    case other, unknown
}

public struct EmailInput: Sendable, Equatable {
    public let subject: String
    public let body: String
    public let from: String

    public init(subject: String, body: String, from: String) {
        self.subject = subject
        self.body = body
        self.from = from
    }
}

public struct EmailClassification: Sendable, Equatable {
    public let label: EmailLabel
    public let confidence: Double
    public let language: String?
    /// Why it's "unknown", for the daemon's log; never part of the label decision.
    public let note: String?

    public init(label: EmailLabel, confidence: Double, language: String?, note: String? = nil) {
        self.label = label
        self.confidence = confidence
        self.language = language
        self.note = note
    }

    public static func unknown(language: String?, note: String) -> EmailClassification {
        EmailClassification(label: .unknown, confidence: 0, language: language, note: note)
    }

    public var json: [String: Any] {
        var out: [String: Any] = [
            "label": label.rawValue,
            "confidence": confidence,
            "language": language ?? NSNull(),
        ]
        if let note { out["note"] = note }
        return out
    }
}

/// What a model said, before the classifier's own checks.
public struct ModelGuess: Sendable, Equatable {
    public let label: String
    /// 0–100, the model's own estimate.
    public let confidence: Int

    public init(label: String, confidence: Int) {
        self.label = label
        self.confidence = confidence
    }
}

public enum ModelAvailability: Sendable, Equatable {
    case available
    case unavailable(String)
}

/// The language model behind the classifier; tests use a fake one.
public protocol EmailModel: Sendable {
    var availability: ModelAvailability { get }
    /// ISO 639-1 codes the model answers in; nil = don't check.
    var supportedLanguages: Set<String>? { get }
    func guess(prompt: String, instructions: String) async throws -> ModelGuess
}

public struct EmailClassifier: Sendable {
    /// Below this the model's guess is not worth passing on: "unknown", confidence 0.
    public static let minConfidence = 0.5
    /// What the model reads of the body (the daemon already cuts it to 6000 characters).
    public static let bodyChars = 4000

    public let model: EmailModel

    public init(model: EmailModel = EmailClassifier.systemModel()) {
        self.model = model
    }

    public static func systemModel() -> EmailModel {
        #if canImport(FoundationModels)
        if #available(macOS 26.0, *) { return FoundationEmailModel() }
        #endif
        return NoEmailModel(reason: "Foundation Models needs macOS 26")
    }

    public static let instructions = """
    You sort emails a job seeker received after applying for jobs. Answer with one label:
    - rejection: the company won't move forward with the application.
    - interview: an invitation to an interview, a call, a test task, an assessment, or to \
    schedule next steps.
    - offer: a job offer.
    - acknowledgement: the application was received or is being reviewed, nothing more.
    - security_code: a one-time or verification code to finish submitting an application.
    - other: not about the job seeker's own job application (newsletters, job alerts, \
    marketing, anything else).
    - unknown: you cannot tell.
    Also give your confidence from 0 to 100. Emails may be in any language.
    """

    public func classify(_ email: EmailInput) async -> EmailClassification {
        let language = Self.language(of: email)
        guard case .available = model.availability else {
            if case let .unavailable(reason) = model.availability {
                return .unknown(language: language, note: reason)
            }
            return .unknown(language: language, note: "the model is unavailable")
        }
        if let language, let supported = model.supportedLanguages, !supported.contains(language) {
            return .unknown(language: language, note: "the on-device model doesn't read \(language)")
        }
        let guess: ModelGuess
        do {
            guess = try await model.guess(prompt: Self.prompt(email), instructions: Self.instructions)
        } catch {
            return .unknown(language: language, note: "the on-device model failed: \(error)")
        }
        guard let label = EmailLabel(rawValue: guess.label.lowercased()) else {
            return .unknown(language: language, note: "the model answered \(guess.label)")
        }
        let confidence = min(max(Double(guess.confidence) / 100, 0), 1)
        if label == .unknown || confidence < Self.minConfidence {
            return .unknown(language: language, note: "not sure (\(label.rawValue), \(guess.confidence)%)")
        }
        return EmailClassification(label: label, confidence: confidence, language: language)
    }

    static func prompt(_ email: EmailInput) -> String {
        """
        From: \(email.from)
        Subject: \(email.subject)

        \(email.body.prefix(bodyChars))
        """
    }

    /// The email's language (ISO 639-1), when NaturalLanguage is reasonably sure.
    public static func language(of email: EmailInput) -> String? {
        let recognizer = NLLanguageRecognizer()
        recognizer.processString("\(email.subject)\n\(email.body.prefix(bodyChars))")
        guard let (language, p) = recognizer.languageHypotheses(withMaximum: 1).first, p >= 0.5
        else { return nil }
        let code = language.rawValue
        return String(code.split(separator: "-").first ?? Substring(code))
    }
}

/// No model on this system.
public struct NoEmailModel: EmailModel {
    public let reason: String
    public init(reason: String) { self.reason = reason }
    public var availability: ModelAvailability { .unavailable(reason) }
    public var supportedLanguages: Set<String>? { nil }
    public func guess(prompt: String, instructions: String) async throws -> ModelGuess {
        throw RequestError(reason)
    }
}

#if canImport(FoundationModels)
@available(macOS 26.0, *)
@Generable
struct EmailGuess {
    @Guide(description: "What the email is", .anyOf(EmailLabel.allCases.map(\.rawValue)))
    var label: String
    @Guide(description: "How sure the label is, 0 to 100", .range(0...100))
    var confidence: Int
}

/// Apple's on-device model (Apple Intelligence).
@available(macOS 26.0, *)
public struct FoundationEmailModel: EmailModel {
    public init() {}

    public var availability: ModelAvailability {
        switch SystemLanguageModel.default.availability {
        case .available:
            return .available
        case let .unavailable(reason):
            switch reason {
            case .appleIntelligenceNotEnabled: return .unavailable("Apple Intelligence is off")
            case .deviceNotEligible: return .unavailable("this Mac can't run Apple Intelligence")
            case .modelNotReady: return .unavailable("the on-device model isn't ready yet")
            @unknown default: return .unavailable("the on-device model is unavailable")
            }
        }
    }

    public var supportedLanguages: Set<String>? {
        let codes = SystemLanguageModel.default.supportedLanguages.compactMap {
            $0.languageCode?.identifier
        }
        return codes.isEmpty ? nil : Set(codes)
    }

    public func guess(prompt: String, instructions: String) async throws -> ModelGuess {
        let session = LanguageModelSession(instructions: instructions)
        let response = try await session.respond(
            to: prompt,
            generating: EmailGuess.self,
            options: GenerationOptions(sampling: .greedy)
        )
        return ModelGuess(label: response.content.label, confidence: response.content.confidence)
    }
}
#endif
