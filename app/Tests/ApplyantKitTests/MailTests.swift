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
        #expect(daemon.calls.contains("mailboxSetup") && daemon.calls.contains("mailQueue"))
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

    @Test func connectFormsCheckWhatTheyNeed() {
        #expect(GmailForm().problem(secretStored: false) == "Paste the OAuth client ID.")
        #expect(GmailForm(clientId: "id.apps.googleusercontent.com").problem(secretStored: false) == "Paste the client secret.")
        #expect(GmailForm(clientId: "id.apps.googleusercontent.com").problem(secretStored: true) == nil)
        #expect(GmailForm(clientId: " x ", clientSecret: "s").problem(secretStored: false) == nil)

        var imap = ImapForm()
        #expect(imap.problem == "Enter the mailbox's address.")
        imap.address = "me@icloud.com"
        imap.applyPreset()
        #expect(imap.imapHost == "imap.mail.me.com" && imap.imapPort == "993")
        #expect(imap.smtpHost == "smtp.mail.me.com" && imap.smtpPort == "587")
        #expect(imap.problem == "Enter the app password.")
        #expect(imap.settings == nil)
        imap.password = "abcd-efgh-ijkl-mnop"
        imap.smtpPort = "x"
        #expect(imap.problem == "Ports are numbers (993, 465, 587…).")
        imap.smtpPort = ""
        let settings = imap.settings
        #expect(settings?.imapPort == 993 && settings?.smtpPort == 0 && settings?.password == "abcd-efgh-ijkl-mnop")
        #expect(settings?.hasUsername == false)
        // A preset never overwrites servers the candidate typed.
        var custom = ImapForm()
        custom.imapHost = "mail.example.org"
        custom.address = "me@gmail.com"
        custom.applyPreset()
        #expect(custom.imapHost == "mail.example.org" && custom.smtpHost == "smtp.gmail.com")
        #expect(MailText.imapPreset(for: "me@example.org") == nil)

        // Reconnecting starts from what it was connected with, never the password.
        let box = Mailbox.with {
            $0.kind = "imap"; $0.address = "me@icloud.com"; $0.imapHost = "imap.mail.me.com"; $0.imapPort = 993
            $0.smtpHost = "smtp.mail.me.com"; $0.smtpPort = 587; $0.username = "me"
        }
        let again = ImapForm(box)
        #expect(again.smtpPort == "587" && again.username == "me" && again.password.isEmpty)
        #expect(MailText.account(box) == "IMAP · me@icloud.com (imap.mail.me.com)")
        #expect(MailText.chip(nil).text == "Not connected")
        #expect(MailText.chip(mailbox("connecting", address: "")).text == "Waiting for Google")
    }

    @Test func gmailConnectsThroughTheBrowserAndDisconnects() async throws {
        let daemon = FakeDaemon()
        let store = AppStore(connector: FakeConnector([daemon]), backoff: { _ in })
        store.consentPollInterval = .milliseconds(20)
        var opened: [URL] = []
        store.onOpenURL = { opened.append($0) }
        let run = Task { await store.run() }
        defer { run.cancel() }
        try await eventually("connected") { store.connection == .connected }
        #expect(store.mailbox == nil && !store.mailboxSecretStored)

        // Without a secret (none stored yet) nothing is sent.
        #expect(await store.connectGmail(GmailForm(clientId: "desktop.apps.googleusercontent.com")) == false)
        #expect(!daemon.calls.contains { $0.hasPrefix("connectGmail") })

        #expect(await store.connectGmail(GmailForm(clientId: " desktop.apps.googleusercontent.com ", clientSecret: "GOCSPX-test")))
        #expect(daemon.calls.contains("connectGmail desktop.apps.googleusercontent.com secret:given"))
        #expect(opened.map(\.host) == ["accounts.google.test"])
        #expect(store.googleConsentURL != nil)
        #expect(MailText.connection(store.mailbox) == "Mailbox: waiting for Google consent")
        #expect(store.mailboxSecretStored)
        store.reopenGoogleConsent()
        #expect(opened.count == 2)

        // The browser comes back: polling sees it (no event needed), the wait ends.
        daemon.finishConsent(address: "me@gmail.com")
        try await eventually("connected mailbox") { MailText.isConnected(store.mailbox) }
        #expect(store.googleConsentURL == nil)
        #expect(MailText.account(store.mailbox!) == "Gmail · me@gmail.com")
        #expect(store.googleClientId == "desktop.apps.googleusercontent.com")

        // Reconnect with the stored secret: none is sent again.
        #expect(await store.connectGmail(GmailForm(clientId: "desktop.apps.googleusercontent.com")))
        #expect(daemon.calls.contains("connectGmail desktop.apps.googleusercontent.com secret:none"))
        daemon.finishConsent(address: nil)
        try await eventually("failed") { store.mailbox?.status == "failed" }
        #expect(MailText.connection(store.mailbox) == "Mailbox failed: Google sign-in was not completed (access_denied)")
        #expect(store.googleConsentURL == nil)

        await store.disconnectMailbox()
        #expect(daemon.calls.contains("disconnectMailbox"))
        #expect(store.mailbox == nil)
        #expect(store.mailboxSecretStored)
        #expect(store.lastError == nil)
    }

    @Test func imapConnectsWithAnAppPasswordOrSaysWhyNot() async throws {
        let daemon = FakeDaemon()
        daemon.imapRefusal = "IMAP login failed: AUTHENTICATIONFAILED"
        let store = AppStore(connector: FakeConnector([daemon]), backoff: { _ in })
        let run = Task { await store.run() }
        defer { run.cancel() }
        try await eventually("connected") { store.connection == .connected }

        var form = ImapForm()
        form.address = "Me@iCloud.com"
        form.applyPreset()
        #expect(await store.connectImap(form) == false)  // no password: nothing sent
        #expect(!daemon.calls.contains { $0.hasPrefix("connectImap") })
        form.password = "wrong"
        #expect(await store.connectImap(form) == false)
        #expect(store.lastError == "IMAP login failed: AUTHENTICATIONFAILED")
        #expect(store.mailbox == nil)
        store.lastError = nil

        daemon.imapRefusal = nil
        form.password = "abcd-efgh-ijkl-mnop"
        #expect(await store.connectImap(form))
        #expect(daemon.calls.contains("connectImap me@icloud.com imap.mail.me.com:993 smtp.mail.me.com:587"))
        #expect(daemon.mailSecrets["mail.password"] == "abcd-efgh-ijkl-mnop")
        #expect(MailText.isConnected(store.mailbox))
        #expect(MailText.account(store.mailbox!) == "IMAP · me@icloud.com (imap.mail.me.com)")

        await store.disconnectMailbox()
        #expect(store.mailbox == nil && daemon.mailSecrets["mail.password"] == nil)
    }

    @Test func theNoteReadsAsASentence() {
        #expect(MailText.noteSentence("a rejection that matches no application") == "A rejection that matches no application.")
        #expect(MailText.noteSentence("Is it about this one?") == "Is it about this one?")
        #expect(MailText.noteSentence("  ") == "")
    }
}
