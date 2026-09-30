// Gap audit: live delivery progress ("Filling 14/16 fields · solving captcha") on the
// application's chip and in the menu bar, from the delivery task's live progress events.
import ApplyantAPI
import Foundation
import Testing
@testable import ApplyantKit

private func task(_ id: Int64, app: Int64, _ type: Applyant_V1_TaskEventType, kind: String = "deliver_application") -> Applyant_V1_Event.OneOf_Payload {
    .task(.with {
        $0.taskID = id
        $0.taskKind = kind
        $0.entityID = app
        $0.type = type
    })
}

private func message(_ e: DaemonEvent, _ text: String) -> DaemonEvent {
    var e = e
    e.message = text
    return e
}

@MainActor
@Suite struct DeliveryProgressTests {
    @Test func readsTheFormEnginesMessages() {
        var p = DeliveryProgress(messages: ["opening https://boards.greenhouse.io/helix/jobs/1"])
        #expect(p.line == "Opening the form")
        p.apply("step 1: 16 fields")
        #expect(p.line == "Filling 0/16 fields")
        p.apply("filling 14/16: Resume/CV")
        p.apply("uploaded Resume/CV")
        #expect(p.line == "Filling 14/16 fields · Resume/CV uploaded")
        p.apply("solving a recaptcha v2 captcha")
        #expect(p.line == "Filling 14/16 fields · Resume/CV uploaded · solving captcha")
        p.apply("step 1: pressing \"Next\"")
        p.apply("step 2: 3 fields")
        p.apply("filling 1/3: Why Helix?")
        #expect(p.line == "Step 2 · Filling 1/3 fields · Resume/CV uploaded")
        p.apply("step 2: the site emailed a security code, reading it from the mailbox")
        #expect(p.line.hasSuffix("reading the emailed security code"))
        // Messages it doesn't know (the form agent's) leave the line as it was.
        let before = p.line
        p.apply("agent: clicking the dropdown")
        #expect(p.line == before)
        #expect(DeliveryProgress().line == "Delivering")
    }

    @Test func theChipAndTheMenuBarFollowLiveEvents() async throws {
        let app = application(9, posting: 5, stage: .approved)
        let daemon = FakeDaemon(postings: [posting(5, score: 88, title: "AI Engineer", appId: 9)], applications: [app])
        let store = AppStore(connector: FakeConnector([daemon]), backoff: { _ in })
        let run = Task { await store.run() }
        defer { run.cancel() }
        try await eventually("connected") { store.connection == .connected }

        #expect(StageText.chip(app).text == "Approved · delivering")
        await store.apply(event(1, task(70, app: 9, .started)), live: true)
        await store.apply(message(event(2, task(70, app: 9, .progress)), "step 1: 16 fields"), live: true)
        await store.apply(message(event(3, task(70, app: 9, .progress)), "filling 14/16: Email"), live: true)
        await store.apply(message(event(4, task(70, app: 9, .progress)), "solving a hcaptcha captcha"), live: true)
        #expect(store.deliveries[9]?.line == "Filling 14/16 fields · solving captcha")
        #expect(StageText.chip(app, delivery: store.deliveries[9]).text == "Filling 14/16 fields · solving captcha")
        await store.apply(event(5, task(71, app: 3, .started, kind: "verify_posting")), live: true)
        let line = WorkingLine.text(running: store.activity.running, deliveries: store.deliveries) { id in
            id == 9 ? "Acme" : "application \(id)"
        }
        #expect(line == "Delivering to Acme: Filling 14/16 fields · solving captcha\nWorking: verify_posting")

        // Done (or failed, or handed off): the progress goes, the chip is the stage's again.
        await store.apply(event(6, task(70, app: 9, .done)), live: true)
        #expect(store.deliveries[9] == nil)
        #expect(WorkingLine.text(running: [:], deliveries: [:]) { _ in "" } == "")
    }
}

@MainActor
@Suite struct ReviewQuickActionTests {
    @Test func adaptedFromSaysWhichApplicationAndWhen() {
        var a = Applyant_V1_Answer()
        a.kind = "text"
        a.status = "answered"
        #expect(ReviewActions.adaptedFrom(a) == nil)
        a.adaptedFrom = "answer:4"
        #expect(ReviewActions.adaptedFrom(a) == "adapted from an earlier answer")
        a.adapted = .with {
            $0.answerID = 4
            $0.applicationID = 2
            $0.company = "Orbit"
            $0.question = "Why us?"
            $0.stage = .applied
            $0.at = .init(date: Date(timeIntervalSince1970: 1_789_203_600))  // 2026-09-12
        }
        let text = ReviewActions.adaptedFrom(a) ?? ""
        #expect(text.hasPrefix("adapted from the answer sent to Orbit ("))
        #expect(text.contains("12"))
        #expect(ReviewActions.adaptedQuestion(a) == "Orbit asked: “Why us?”")
        a.adapted.stage = .readyForReview
        #expect(ReviewActions.adaptedFrom(a)?.hasPrefix("adapted from the answer for Orbit") == true)

        let app = application(9, posting: 5, stage: .readyForReview)
        #expect(ReviewActions.canRedraft(a, app: app))
        a.redraftShorter = true
        a.redraftProject = "Lantern"
        #expect(ReviewActions.pending(a) == "Redrafting shorter, from Lantern…")
        #expect(!ReviewActions.canRedraft(a, app: app))
        a.redraftShorter = false
        a.clearRedraftProject()
        a.kind = "choice"
        #expect(!ReviewActions.canRedraft(a, app: app))
        a.kind = "text"
        #expect(!ReviewActions.canRedraft(a, app: application(9, posting: 5, stage: .approved)))
    }
}
