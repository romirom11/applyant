import ApplyantAPI
import Foundation
import Testing
@testable import ApplyantKit

func email(_ id: Int64, subject: String, label: String = "unknown", confidence: Double? = nil, candidates: [Int64] = []) -> Email {
    .with {
        $0.id = id
        $0.subject = subject
        $0.fromAddress = "no-reply@greenhouse.io"
        $0.label = label
        if let confidence { $0.confidence = confidence }
        $0.status = "ask"
        $0.receivedAt = .init(date: Date(timeIntervalSince1970: 1_790_000_000))
        $0.candidates = candidates.map { cid in .with { $0.applicationID = cid; $0.title = "Role \(cid)"; $0.company = "Tallyhall"; $0.stage = .applied } }
    }
}

func mailbox(_ status: String = "connected", address: String = "me@gmail.com", asking: Int32 = 0) -> Mailbox {
    .with {
        $0.kind = "gmail"
        $0.address = address
        $0.status = status
        $0.asking = asking
    }
}

@MainActor
@Suite struct MailTests {
    @Test func theMailboxAndRepliesReadAsText() {
        #expect(MailText.connection(nil) == "No mailbox connected")
        #expect(MailText.connection(mailbox("connecting", address: "")) == "Mailbox: waiting for Google consent")
        var failed = mailbox("failed")
        failed.note = "access_denied"
        #expect(MailText.connection(failed) == "Mailbox failed: access_denied")
        #expect(MailText.connection(mailbox()) == "Mailbox: me@gmail.com · not synced yet")
        let now = Date()
        var synced = mailbox(asking: 2)
        synced.syncedAt = .init(date: now)
        #expect(MailText.connection(synced, now: now) == "Mailbox: me@gmail.com · synced \(now.formatted(date: .omitted, time: .shortened))")
        #expect(MailText.menuLine(synced, now: now).hasSuffix(" · 2 to sort"))
        #expect(MailText.labelChip(email(1, subject: "x", label: "interview", confidence: 0.86)) == Chip(text: "Interview 86%", tone: .good))
        #expect(MailText.labelChip(email(1, subject: "x")) == Chip(text: "Unsure", tone: .neutral))
        #expect(MailText.candidateTitle(email(1, subject: "x", candidates: [4]).candidates[0]) == "Tallyhall · Role 4")

        var invite = email(2, subject: "Interview", label: "interview", confidence: 0.9)
        #expect(MailText.calendar(invite) == nil)
        invite.calendarStatus = "created"
        invite.inviteStart = "2026-10-07T14:00:00"
        invite.inviteTimeZone = "Europe/Berlin"
        #expect(MailText.calendar(invite) == "On your calendar · 2026-10-07 14:00 (Europe/Berlin)")
        invite.calendarStatus = "skipped"
        invite.calendarNote = "the email has no time (no calendar invite attached)"
        #expect(MailText.calendar(invite) == "Not on your calendar: the email has no time (no calendar invite attached)")
        invite.calendarStatus = "created"
        invite.inviteStart = "2026-10-07T12:00:00Z"
        invite.clearInviteTimeZone()
        #expect(MailText.inviteTime(invite) == "2026-10-07 12:00 UTC")

        for section in [Section.interviews, .offers, .whichApplication] {
            #expect(section.isBuilt && section.group == .applications, "\(section)")
        }
        #expect(StageText.chip(application(1, posting: 1, stage: .rejected)).text == "Rejected")
    }

    @Test func applicationSectionsFollowWhereTheMailLeftThem() async throws {
        let daemon = FakeDaemon(
            postings: (1...4).map { posting($0, score: 80, title: "Role \($0)", appId: $0) },
            applications: [
                application(1, posting: 1, stage: .applied),
                application(2, posting: 2, stage: .interview),
                application(3, posting: 3, stage: .offer),
                application(4, posting: 4, stage: .rejected),
            ]
        )
        let store = AppStore(connector: FakeConnector([daemon]), backoff: { _ in })
        let run = Task { await store.run() }
        defer { run.cancel() }
        try await eventually("connected") { store.connection == .connected }
        #expect(Set(store.items(.applied).compactMap(\.applicationId)) == [1, 4])
        #expect(store.items(.applied).first { $0.applicationId == 4 }?.chips.first?.text == "Rejected")
        #expect(store.items(.interviews).compactMap(\.applicationId) == [2])
        #expect(store.items(.offers).compactMap(\.applicationId) == [3])
        #expect(store.count(.interviews) == 1 && store.count(.offers) == 1)
        #expect(store.mailbox == nil)
        #expect(store.count(.whichApplication) == 0)
    }

    @Test func whichApplicationAssignsDismissesAndFollowsMailEvents() async throws {
        let daemon = FakeDaemon(
            postings: [posting(1, score: 80, title: "Role 1", appId: 1), posting(2, score: 70, title: "Role 2", appId: 2)],
            applications: [application(1, posting: 1, stage: .applied), application(2, posting: 2, stage: .applied)],
            lastId: 5
        )
        daemon.mailboxState = mailbox(asking: 2)
        daemon.queue = [
            email(10, subject: "Tallyhall: next steps", label: "interview", confidence: 0.9, candidates: [1, 2]),
            email(11, subject: "Your newsletter"),
        ]
        let store = AppStore(connector: FakeConnector([daemon]), backoff: { _ in })
        let run = Task { await store.run() }
        defer { run.cancel() }
        try await eventually("connected") { store.connection == .connected }
        #expect(daemon.calls.contains("mailbox") && daemon.calls.contains("mailQueue"))
        #expect(store.mailQueue.map(\.id) == [10, 11])
        #expect(store.count(.whichApplication) == 2)
        #expect(MailText.isConnected(store.mailbox))

        // "This one": the application moves on (the daemon says so), the email leaves the queue.
        await store.assignEmail(10, application: 1)
        #expect(daemon.calls.contains("assignEmail 10 1 -"))
        #expect(store.mailQueue.map(\.id) == [11])
        #expect(store.applications[1]?.stage == .interview)
        #expect(store.items(.interviews).compactMap(\.applicationId) == [1])
        #expect(store.mailbox?.asking == 1)

        // "Not about any application", with what it is.
        await store.assignEmail(11, application: nil, label: "other")
        #expect(daemon.calls.contains("assignEmail 11 none other"))
        #expect(store.mailQueue.isEmpty)

        // A new question arrives through a mail event alone.
        daemon.queue = [email(12, subject: "Re: your application")]
        daemon.feed.yield(.with {
            $0.id = 6
            $0.mail = .with { $0.entityID = 12; $0.status = "ask" }
        })
        try await eventually("the new question") { store.mailQueue.map(\.id) == [12] }

        #expect(await store.syncMailbox() == true)
        #expect(await store.syncMailbox() == false)
        #expect(store.lastError == nil)
    }
}
