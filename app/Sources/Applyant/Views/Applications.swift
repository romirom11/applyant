// The mailbox's side of Applications (phase 13): "Which application is this?" for replies the
// daemon couldn't place on its own, the mailbox's connection state, and the replies each sent
// application got (with its interview's calendar event). Applied · Interviews · Offers list the
// applications themselves (PostingList) and open them in the review screen, which shows these.
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
            Text(MailText.connection(store.mailbox))
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(2)
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
        .task { await store.openMail() }
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
        _label = State(initialValue: MailText.pickableLabels.contains(email.label) ? email.label : "")
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(email.subject.isEmpty ? "(no subject)" : email.subject).font(.title2.weight(.semibold))
                    Text(MailText.sender(email)).foregroundStyle(.secondary)
                    HStack(spacing: 6) {
                        ChipView(chip: MailText.labelChip(email))
                        Text(email.receivedAt.date.formatted(date: .abbreviated, time: .shortened))
                            .font(.caption).foregroundStyle(.secondary)
                        if email.hasClassifiedBy {
                            Text("· read by \(email.classifiedBy)").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    if email.hasNote { Label(email.note, systemImage: "info.circle").foregroundStyle(.secondary) }
                }
                GroupBox {
                    Text(email.snippet)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(6)
                }
                Picker("It is", selection: $label) {
                    Text("As read (\(MailText.labelTitle(email.label)))").tag("")
                    ForEach(MailText.pickableLabels, id: \.self) { Text(MailText.labelTitle($0)).tag($0) }
                }
                .frame(maxWidth: 360)
                .help("A rejection, interview or offer moves the application on.")
                GroupBox("Which application is it about?") {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(email.candidates, id: \.applicationID) { c in
                            HStack {
                                Text(MailText.candidateTitle(c))
                                ChipView(chip: MailText.stageChip(c.stage) ?? Chip(text: "Applied", tone: .neutral))
                                Spacer()
                                Button("This one") { assign(c.applicationID) }
                            }
                        }
                        let others = otherApplications
                        if !others.isEmpty {
                            Menu(email.candidates.isEmpty ? "Pick an application" : "Another application") {
                                ForEach(others, id: \.id) { app in
                                    Button((app.hasCompany ? "\(app.company) · " : "") + (app.hasTitle ? app.title : "Application \(app.id)")) {
                                        assign(app.id)
                                    }
                                }
                            }
                            .frame(maxWidth: 320)
                        }
                        Divider()
                        Button("Not about any application") { assign(nil) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(6)
                }
            }
            .padding(20)
            .frame(maxWidth: 760, alignment: .leading)
        }
    }

    /// Sent applications the email doesn't already offer.
    private var otherApplications: [Application] {
        let offered = Set(email.candidates.map(\.applicationID))
        let sent: Set<ApplicationStage> = [.approved, .applied, .interview, .offer, .rejected]
        return store.applications.values
            .filter { sent.contains($0.stage) && !offered.contains($0.id) }
            .sorted { $0.id > $1.id }
    }

    private func assign(_ application: Int64?) {
        let chosen = label.isEmpty ? nil : label
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
