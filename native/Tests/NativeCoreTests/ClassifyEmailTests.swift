import Foundation
import Testing
@testable import NativeCore

struct FakeModel: EmailModel {
    var availability: ModelAvailability = .available
    var supportedLanguages: Set<String>? = ["en", "de"]
    var answer: Result<ModelGuess, RequestError> = .success(ModelGuess(label: "interview", confidence: 90))

    func guess(prompt: String, instructions: String) async throws -> ModelGuess {
        try answer.get()
    }
}

let invite = EmailInput(
    subject: "Interview invitation: Senior Backend Engineer",
    body: """
    Hi Alex,

    Thank you for applying to Acme. We'd like to invite you to a 45-minute video interview with \
    our engineering manager next week. Please pick a slot that suits you using the link below.

    Best regards,
    The Acme recruiting team
    """,
    from: "Acme Recruiting <jobs@acme.example>"
)

@Suite struct ClassifyEmailTests {
    @Test func passesASureGuessOn() async {
        let result = await EmailClassifier(model: FakeModel()).classify(invite)
        #expect(result.label == .interview)
        #expect(result.confidence == 0.9)
        #expect(result.language == "en")
        #expect(result.note == nil)
    }

    @Test func unavailableModelIsUnknownWithConfidenceZero() async {
        let off = FakeModel(availability: .unavailable("Apple Intelligence is off"))
        let result = await EmailClassifier(model: off).classify(invite)
        #expect(result == .unknown(language: "en", note: "Apple Intelligence is off"))
        #expect(result.confidence == 0)
    }

    @Test func lowConfidenceUnknownAndGarbageAreUnknown() async {
        for guess in [
            ModelGuess(label: "rejection", confidence: 30),
            ModelGuess(label: "unknown", confidence: 95),
            ModelGuess(label: "maybe", confidence: 99),
        ] {
            let result = await EmailClassifier(model: FakeModel(answer: .success(guess))).classify(invite)
            #expect(result.label == .unknown, "\(guess)")
            #expect(result.confidence == 0)
        }
    }

    @Test func modelErrorsAndUnsupportedLanguagesAreUnknown() async {
        let failing = FakeModel(answer: .failure(RequestError("guardrail")))
        #expect(await EmailClassifier(model: failing).classify(invite).label == .unknown)
        let englishOnly = FakeModel(supportedLanguages: ["en"])
        let french = EmailInput(
            subject: "Votre candidature",
            body: "Nous avons le regret de vous informer que nous ne donnerons pas suite à votre candidature.",
            from: "rh@exemple.fr"
        )
        let result = await EmailClassifier(model: englishOnly).classify(french)
        #expect(result.label == .unknown)
        #expect(result.language == "fr")
    }

    @Test func labelsAreTheDaemonsEmailLabels() {
        // daemon/src/db/schema.ts EMAIL_LABELS, in order.
        #expect(EmailLabel.allCases.map(\.rawValue) == [
            "rejection", "interview", "offer", "acknowledgement", "security_code", "other", "unknown",
        ])
    }

    @Test func answersOverTheProtocolAsynchronously() async throws {
        let dispatcher = Dispatcher(
            keychain: Keychain(service: "com.applyant.test.classify"),
            classifier: EmailClassifier(model: FakeModel(answer: .success(ModelGuess(label: "offer", confidence: 80))))
        )
        let request = try String(
            data: JSONSerialization.data(withJSONObject: [
                "id": 9, "op": "classify_email", "subject": invite.subject, "body": invite.body, "from": invite.from,
            ]),
            encoding: .utf8
        )!
        let line = await withCheckedContinuation { (done: CheckedContinuation<String, Never>) in
            dispatcher.handle(line: request) { done.resume(returning: $0) }
        }
        let answer = try json(line)
        #expect(answer["id"] as? Int == 9)
        #expect(answer["ok"] as? Bool == true)
        let result = try #require(answer["result"] as? [String: Any])
        #expect(result["label"] as? String == "offer")
        #expect(result["confidence"] as? Double == 0.8)
        #expect(result["language"] as? String == "en")
        // Other ops still answer through the same entry point.
        let ping = await withCheckedContinuation { (done: CheckedContinuation<String, Never>) in
            dispatcher.handle(line: #"{"id": 10, "op": "ping"}"#) { done.resume(returning: $0) }
        }
        #expect(try json(ping)["ok"] as? Bool == true)
    }
}

/// The real on-device model. Skipped when Apple Intelligence is off (or the Mac can't run it).
/// APPLYANT_CLASSIFY_LOG=1 prints each answer, for the phase notes.
@Suite(.enabled(if: {
    if case .available = EmailClassifier.systemModel().availability { return true }
    return false
}(), "Apple Intelligence is off or unavailable"))
struct ClassifyEmailContractTests {
    static let emails: [(EmailLabel, EmailInput)] = [
        (.rejection, EmailInput(
            subject: "Your application to Acme",
            body: """
            Dear Alex, thank you for your interest in the Senior Backend Engineer position at Acme. \
            After careful consideration, we have decided not to move forward with your application \
            at this time. We wish you the best in your search.
            """,
            from: "Acme Talent <no-reply@acme.example>"
        )),
        (.interview, invite),
        (.offer, EmailInput(
            subject: "Offer of employment — Senior Backend Engineer",
            body: """
            Dear Alex, we are delighted to offer you the position of Senior Backend Engineer at Acme, \
            with an annual base salary of €95,000 and a start date of 1 December. Please find the \
            offer letter attached and let us know your decision by Friday.
            """,
            from: "Maria Lopez <maria@acme.example>"
        )),
        (.other, EmailInput(
            subject: "This week in Rust: issue 612",
            body: """
            Hello Rustaceans! This week's newsletter: the 2026 survey results, three new crates of \
            the week, and upcoming meetups in Berlin and Lisbon. Unsubscribe at any time.
            """,
            from: "This Week in Rust <newsletter@this-week-in-rust.example>"
        )),
    ]

    @Test func classifiesSyntheticEmails() async {
        let classifier = EmailClassifier()
        var right = 0
        for (expected, email) in Self.emails {
            let result = await classifier.classify(email)
            if ProcessInfo.processInfo.environment["APPLYANT_CLASSIFY_LOG"] == "1" {
                print("classify_email \(expected.rawValue): \(result.label.rawValue) \(result.confidence) \(result.language ?? "-") \(result.note ?? "")")
            }
            // A contract, not an accuracy test: a known label, a confidence in 0…1, 0 for unknown.
            #expect(EmailLabel.allCases.contains(result.label))
            #expect((0...1).contains(result.confidence))
            if result.label == .unknown { #expect(result.confidence == 0) }
            if result.label == expected { right += 1 }
        }
        // The model should get most of these obvious ones.
        #expect(right >= 3, "only \(right) of \(Self.emails.count) right")
    }
}
