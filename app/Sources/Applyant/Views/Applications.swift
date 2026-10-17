// The mailbox's side of Applications (phase 13): "Which application is this?" for replies the
// daemon couldn't place on its own, the mailbox's connection state, and the replies each sent
// application got (with its interview's calendar event). Applied · Interviews · Offers list the
// applications themselves (PostingList) and open them in the review screen, which shows these.
// Set status corrects a status by hand (a row's menu, the review screen).
import AppKit
import ApplyantAPI
import ApplyantKit
import SwiftUI

struct MailboxStatus: View {
    let store: AppStore
    @State private var connecting = false

    var body: some View {
        let problem = MailText.problem(store.mailbox)
        let connected = MailText.isConnected(store.mailbox) && problem == nil
        HStack(alignment: problem == nil ? .center : .top, spacing: 8) {
            Image(systemName: connected ? "envelope" : "exclamationmark.triangle.fill")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(connected ? Theme.secondaryText : Theme.warning)
            if let problem, let box = store.mailbox {
                // Signed out though it says connected: the address, then what's wrong, whole.
                VStack(alignment: .leading, spacing: 2) {
                    Text(box.address.isEmpty ? "Mailbox" : box.address).textRole(.meta).lineLimit(1)
                    Text(problem).font(.system(size: 12)).foregroundStyle(Theme.text).lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                Text(MailText.connection(store.mailbox).replacingOccurrences(of: "Mailbox: ", with: ""))
                    .textRole(.meta)
                    .lineLimit(1)
                    .help(MailText.connection(store.mailbox))
            }
            Spacer(minLength: 4)
            if connected {
                Button("Sync Now") { Task { await store.syncMailbox() } }
                    .buttonStyle(.secondary)
                    .controlSize(.small)
                    .fixedSize()
            } else {
                Button(store.mailbox == nil ? "Connect Mailbox…" : "Reconnect…") { connecting = true }
                    .buttonStyle(problem != nil ? AnyButtonStyle(.primary) : AnyButtonStyle(.secondary))
                    .controlSize(.small)
                    .fixedSize()
            }
        }
        .sheet(isPresented: $connecting) {
            MailboxConnectSheet(store: store) { connecting = false }.worldSheet()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .help(store.mailbox == nil
            ? "Connect Gmail or any IMAP mailbox here or in Settings → Mailbox."
            : "Replies move applications on their own; the ones it can't place are asked about here.")
    }
}

struct WhichApplicationList: View {
    let store: AppStore

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ModuleHeader(section: .whichApplication, subtitle: store.mailQueue.isEmpty ? "Nothing to place" : "\(store.mailQueue.count) repl\(store.mailQueue.count == 1 ? "y" : "ies") to place")
                .columnHeader()
            MailboxStatus(store: store)
                .padding(.horizontal, 6)
            if store.mailQueue.isEmpty {
                EmptyState(
                    title: "No replies to place",
                    systemImage: ApplyantKit.Section.whichApplication.symbol,
                    detail: "Replies Applyant can't place on its own, or can't tell what they are, wait here.",
                    art: .allCaughtUp
                )
            } else {
                CardList(
                    selection: Binding(get: { store.navigation.email }, set: { store.navigation.email = $0 }),
                    order: store.mailQueue.map(\.id),
                    tint: Theme.world(.whichApplication).main
                ) {
                    ForEach(store.mailQueue, id: \.id) { e in
                        SelectableCard(id: e.id) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(e.subject.isEmpty ? "(no subject)" : e.subject).textRole(.rowTitle).lineLimit(2)
                                Text(MailText.sender(e)).textRole(.meta).lineLimit(1)
                                HStack(spacing: 6) {
                                    ChipView(chip: MailText.labelChip(e))
                                    Text(e.receivedAt.date.formatted(.dateTime.day().month(.abbreviated).hour().minute()))
                                        .font(.system(size: 11, weight: .medium))
                                        .foregroundStyle(Theme.secondaryText)
                                }
                                .padding(.top, 2)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("Replies")
        .task {
            await store.openMail()
            // The first reply opens by itself: there's only ever something to decide here.
            if store.navigation.email == nil { store.navigation.email = store.mailQueue.first?.id }
        }
    }
}

struct WhichApplicationDetail: View {
    let store: AppStore

    var body: some View {
        if let id = store.navigation.email, let email = store.mailQueue.first(where: { $0.id == id }) {
            WhichApplication(store: store, email: email).id(id)
        } else {
            EmptyState(
                title: "Which application is this?",
                systemImage: ApplyantKit.Section.whichApplication.symbol,
                detail: "Pick a reply on the left and say which application it's about, or that it's about none."
            )
        }
    }
}

struct WhichApplication: View {
    let store: AppStore
    let email: Email
    @State private var label: String

    init(store: AppStore, email: Email) {
        self.store = store
        self.email = email
        _label = State(initialValue: MailText.pickableLabels.contains(email.label) ? email.label : "other")
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.blockSpacing) {
                PageHeader(
                    title: email.subject.isEmpty ? "(no subject)" : email.subject,
                    subtitle: MailText.sender(email) + " · " + email.receivedAt.date.formatted(date: .abbreviated, time: .shortened)
                ) {
                    CompanyAvatar(name: MailText.sender(email), size: 56)
                }
                // What Applyant made of it, and what's left for you: the decision comes first.
                decision
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .entrance(1)
                // The reply, read like a message: its links shortened, its paragraphs kept.
                Prose(paragraphs: MailText.readable(email.snippet), collapsedLines: 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Theme.cardPadding)
                    .readingSurface()
                    .entrance(2)
            }
            .pageColumn()
        }
    }

    private var decision: some View {
        VStack(alignment: .leading, spacing: Theme.rowSpacing + 4) {
            HStack(spacing: 8) {
                Text("Applyant reads this as").textRole(.body, color: Theme.secondaryText)
                Picker("Applyant reads this as", selection: $label) {
                    ForEach(MailText.pickableLabels, id: \.self) {
                        Text(MailText.labelTitle($0)).tag($0)
                    }
                }
                .labelsHidden()
                .fixedSize()
                .help("A rejection, interview or offer moves the application on.")
                if email.hasConfidence, label == email.label {
                    Text("· \(Int((email.confidence * 100).rounded()))% sure").textRole(.body, color: Theme.secondaryText)
                }
            }
            if email.hasNote {
                Text(MailText.noteSentence(email.note)).textRole(.body, color: Theme.secondaryText).fixedSize(horizontal: false, vertical: true)
            }
            Text("Which application is it about?").textRole(.heading).padding(.top, 4)
            ForEach(email.candidates, id: \.applicationID) { c in
                HStack(spacing: 8) {
                    Text(MailText.candidateTitle(c)).textRole(.body)
                    ChipView(chip: MailText.stageChip(c.stage) ?? Chip(text: "Applied", tone: .neutral))
                    Spacer()
                    Button("This One") { assign(c.applicationID) }.buttonStyle(.primary).controlSize(.small)
                }
                .padding(10)
                .insetSurface()
            }
            HStack(spacing: 10) {
                let others = otherApplications
                if !others.isEmpty {
                    Menu(email.candidates.isEmpty ? "Pick an Application…" : "Another Application…") {
                        ForEach(others, id: \.id) { app in
                            Button((app.hasCompany ? "\(app.company) · " : "") + (app.hasTitle ? app.title : "Application \(app.id)")) {
                                assign(app.id)
                            }
                        }
                    }
                    .fixedSize()
                }
                Button(email.candidates.isEmpty && otherApplications.isEmpty ? "Not One of Mine" : "None of These") { assign(nil) }
                    .buttonStyle(.secondary)
                    .help("It isn't about an application sent through Applyant; it's kept, and no status changes.")
            }
            if email.candidates.isEmpty && otherApplications.isEmpty {
                MetaLine("No application sent through Applyant matches it, so there's nothing to move on.")
            }
        }
        .padding(Theme.cardPadding)
        .glass()
    }

    /// Sent applications the email doesn't already offer.
    private var otherApplications: [Application] {
        let offered = Set(email.candidates.map(\.applicationID))
        return store.applications.values
            .filter { ($0.stage == .approved || StageRules.isSent($0.stage)) && !offered.contains($0.id) }
            .sorted { $0.id > $1.id }
    }

    private func assign(_ application: Int64?) {
        // Only a correction is sent: what Applyant read stays as it was.
        let chosen = label == email.label ? nil : label
        Task {
            await store.assignEmail(email.id, application: application, label: chosen)
            store.navigation.email = store.mailQueue.first?.id
        }
    }
}

/// The replies a sent application got, newest first, with an interview's calendar event.
struct ApplicationReplies: View {
    let app: Application

    var body: some View {
        Card(title: "Replies", systemImage: "envelope") {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(app.emails, id: \.id) { e in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) {
                            ChipView(chip: MailText.labelChip(e))
                            Text(e.subject.isEmpty ? "(no subject)" : e.subject).textRole(.itemTitle).lineLimit(1)
                        }
                        MetaLine(MailText.sender(e) + " · " + e.receivedAt.date.formatted(date: .abbreviated, time: .shortened))
                        if let line = MailText.calendar(e) {
                            HStack(spacing: 6) {
                                Label(line, systemImage: "calendar").textRole(.body)
                                if e.hasCalendarLink, let url = URL(string: e.calendarLink) {
                                    Button("Open in Calendar") { NSWorkspace.shared.open(url) }.buttonStyle(.link).foregroundStyle(Theme.accent)
                                }
                            }
                        }
                        Text(MailText.readable(e.snippet).joined(separator: " "))
                            .textRole(.body, color: Theme.secondaryText)
                            .lineLimit(3)
                            .frame(maxWidth: Theme.measure, alignment: .leading)
                    }
                }
            }
        }
    }
}

/// Set status: the statuses that make sense from this one, set by hand. The daemon has the
/// final say; a refusal is shown with its reason.
struct SetStatusMenu: View {
    let store: AppStore
    let app: Application

    var body: some View {
        let targets = StageRules.targets(from: app.stage)
        if !targets.isEmpty {
            Menu("Set Status") {
                if ApproveText.canReturnToReview(app) {
                    Button("Back to Review (Nothing Is Sent)") { Task { await store.returnToReview(application: app.id) } }
                    Divider()
                }
                ForEach(targets, id: \.self) { stage in
                    Button(StageText.statusItem(stage, from: app.stage)) {
                        Task { await store.setStage(application: app.id, to: stage) }
                    }
                }
            }
            .help("Correct the status by hand: a reply Applyant missed, or one sent outside it")
        }
    }
}
