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
        HStack(spacing: 8) {
            Image(systemName: MailText.isConnected(store.mailbox) ? "envelope" : "envelope.badge.shield.half.filled")
                .foregroundStyle(MailText.isConnected(store.mailbox) ? Color.secondary : Color.orange)
            Text(MailText.connection(store.mailbox).replacingOccurrences(of: "Mailbox: ", with: ""))
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
            if MailText.isConnected(store.mailbox) {
                Button("Sync now") { Task { await store.syncMailbox() } }
                    .controlSize(.small)
            } else {
                Button(store.mailbox == nil ? "Connect mailbox…" : "Reconnect…") { connecting = true }
                    .controlSize(.small)
            }
        }
        .sheet(isPresented: $connecting) {
            MailboxConnectSheet(store: store) { connecting = false }
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
        VStack(spacing: 0) {
            MailboxStatus(store: store)
            Divider()
            if store.mailQueue.isEmpty {
                ContentUnavailableView(
                    "Nothing to sort",
                    systemImage: ApplyantKit.Section.whichApplication.symbol,
                    description: Text("Replies Applyant can't place on its own, or can't tell what they are, wait here.")
                )
            } else {
                List(store.mailQueue, id: \.id, selection: Binding(
                    get: { store.navigation.email },
                    set: { store.navigation.email = $0 }
                )) { e in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(e.subject.isEmpty ? "(no subject)" : e.subject).font(.headline).lineLimit(2)
                        Text(MailText.sender(e)).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                        HStack(spacing: 4) {
                            ChipView(chip: MailText.labelChip(e))
                            Text(e.receivedAt.date.formatted(.dateTime.day().month(.abbreviated).hour().minute()))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 3)
                    .tag(e.id)
                }
            }
        }
        .navigationTitle("Which application?")
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
            ContentUnavailableView(
                "Which application is this?",
                systemImage: ApplyantKit.Section.whichApplication.symbol,
                description: Text("Pick a reply on the left and say which application it's about, or that it's about none.")
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
            VStack(alignment: .leading, spacing: 20) {
                // The reply, read like a message.
                VStack(alignment: .leading, spacing: 6) {
                    Text(email.subject.isEmpty ? "(no subject)" : email.subject).font(.title2.weight(.semibold))
                    HStack(spacing: 6) {
                        Text(MailText.sender(email))
                        Text("·")
                        Text(email.receivedAt.date.formatted(date: .abbreviated, time: .shortened))
                    }
                    .font(.callout).foregroundStyle(.secondary)
                }
                Text(email.snippet)
                    .textSelection(.enabled)
                    .lineSpacing(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Divider()
                // What Applyant made of it, and what's left for you.
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 8) {
                        Text("It is").foregroundStyle(.secondary)
                        Picker("It is", selection: $label) {
                            ForEach(MailText.pickableLabels, id: \.self) {
                                Text(MailText.labelTitle($0)).tag($0)
                            }
                        }
                        .labelsHidden()
                        .fixedSize()
                        .help("A rejection, interview or offer moves the application on.")
                        if email.hasConfidence, label == email.label {
                            Text("Applyant is \(Int((email.confidence * 100).rounded()))% sure")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    if email.hasNote {
                        Text(MailText.noteSentence(email.note)).font(.callout).foregroundStyle(.secondary)
                    }
                    Text("Which application is it about?").font(.headline).padding(.top, 4)
                    ForEach(email.candidates, id: \.applicationID) { c in
                        HStack {
                            Text(MailText.candidateTitle(c))
                            ChipView(chip: MailText.stageChip(c.stage) ?? Chip(text: "Applied", tone: .neutral))
                            Spacer()
                            Button("This one") { assign(c.applicationID) }
                        }
                    }
                    HStack(spacing: 10) {
                        let others = otherApplications
                        if !others.isEmpty {
                            Menu(email.candidates.isEmpty ? "Pick an application…" : "Another application…") {
                                ForEach(others, id: \.id) { app in
                                    Button((app.hasCompany ? "\(app.company) · " : "") + (app.hasTitle ? app.title : "Application \(app.id)")) {
                                        assign(app.id)
                                    }
                                }
                            }
                            .fixedSize()
                        }
                        Button(email.candidates.isEmpty && otherApplications.isEmpty ? "Not one of mine" : "None of these") { assign(nil) }
                            .help("It isn't about an application sent through Applyant; it's kept, and no status changes.")
                    }
                    if email.candidates.isEmpty && otherApplications.isEmpty {
                        Text("No application sent through Applyant matches it, so there's nothing to move on.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .padding(24)
            .frame(maxWidth: 720, alignment: .leading)
        }
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
        GroupBox("Replies") {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(app.emails, id: \.id) { e in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            ChipView(chip: MailText.labelChip(e))
                            Text(e.subject.isEmpty ? "(no subject)" : e.subject).font(.headline).lineLimit(1)
                        }
                        Text(MailText.sender(e) + " · " + e.receivedAt.date.formatted(date: .abbreviated, time: .shortened))
                            .font(.caption).foregroundStyle(.secondary)
                        if let line = MailText.calendar(e) {
                            HStack(spacing: 6) {
                                Label(line, systemImage: "calendar").font(.callout)
                                if e.hasCalendarLink, let url = URL(string: e.calendarLink) {
                                    Button("Open in Calendar") { NSWorkspace.shared.open(url) }.buttonStyle(.link)
                                }
                            }
                        }
                        Text(e.snippet).font(.callout).foregroundStyle(.secondary).lineLimit(3)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(6)
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
            Menu("Set status") {
                if ApproveText.canReturnToReview(app) {
                    Button("Back to review (nothing is sent)") { Task { await store.returnToReview(application: app.id) } }
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
