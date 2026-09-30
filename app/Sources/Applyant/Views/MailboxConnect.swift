// Connecting the mailbox from the app (phase 13, reachable from Settings → Mailbox and the
// setup's Connections step): Gmail through Google's consent in the browser with the owner's
// "Desktop app" OAuth client, or IMAP + SMTP with an app password. Secrets go straight to the
// daemon's Secrets (SecureFields, cleared after sending) and never come back.
import AppKit
import ApplyantAPI
import ApplyantKit
import SwiftUI

/// The mailbox's state with Connect / Reconnect / Disconnect; a Form section's rows.
struct MailboxRows: View {
    let store: AppStore
    @State private var connecting = false

    var body: some View {
        let box = store.mailbox
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(box.map(MailText.account) ?? "No mailbox connected").font(.callout)
                Text(MailText.connection(box)).font(.caption).foregroundStyle(.secondary).lineLimit(3)
            }
            Spacer()
            ChipView(chip: MailText.chip(box))
        }
        HStack {
            Button(box == nil ? "Connect mailbox…" : box?.status == "connecting" ? "Show sign-in…" : "Reconnect…") {
                connecting = true
            }
            if box != nil {
                Button("Disconnect", role: .destructive) { Task { await store.disconnectMailbox() } }
            }
            if MailText.isConnected(box) {
                Button("Sync now") { Task { await store.syncMailbox() } }
            }
        }
        .sheet(isPresented: $connecting) {
            MailboxConnectSheet(store: store) { connecting = false }
        }
    }
}

struct MailboxConnectSheet: View {
    enum Kind: String, CaseIterable, Identifiable {
        case gmail = "Gmail"
        case imap = "IMAP / SMTP"
        var id: String { rawValue }
    }

    let store: AppStore
    let close: () -> Void
    @State private var kind: Kind = .gmail
    @State private var gmail = GmailForm()
    @State private var imap = ImapForm()
    @State private var busy = false
    @State private var error: String?
    @State private var started = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Connect mailbox").font(.title2.bold())
            Text("Applyant reads replies to move applications on, reads emailed security codes, and sends email applications you approved. One mailbox at a time: connecting replaces the current one.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Picker("", selection: $kind) {
                ForEach(Kind.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .disabled(waiting)

            Form {
                switch kind {
                case .gmail: gmailFields
                case .imap: imapFields
                }
            }
            .formStyle(.grouped)

            if let error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange).font(.callout).textSelection(.enabled)
            }
            HStack {
                if waiting {
                    ProgressView().controlSize(.small)
                    Text("Waiting for Google consent… finish it in your browser.").font(.callout)
                    Button("Open again") { store.reopenGoogleConsent() }
                } else if started, let box = store.mailbox {
                    Image(systemName: MailText.isConnected(box) ? "checkmark.circle.fill" : "xmark.octagon.fill")
                        .foregroundStyle(MailText.isConnected(box) ? .green : .orange)
                    Text(MailText.connection(box)).font(.callout).lineLimit(2)
                }
                Spacer()
                Button(started && MailText.isConnected(store.mailbox) ? "Done" : "Cancel") { close() }
                    .keyboardShortcut(.cancelAction)
                Button(kind == .gmail ? "Connect with Google" : "Connect") { Task { await connect() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy || waiting || problem != nil)
                    .help(problem ?? "")
            }
        }
        .padding(20)
        .frame(width: 560, height: 560)
        .onAppear(perform: prefill)
    }

    private var waiting: Bool { store.googleConsentURL != nil && store.mailbox?.status == "connecting" }

    private var problem: String? {
        kind == .gmail ? gmail.problem(secretStored: store.mailboxSecretStored) : imap.problem
    }

    @ViewBuilder private var gmailFields: some View {
        SwiftUI.Section {
            TextField("OAuth client ID", text: $gmail.clientId, prompt: Text("1234…apps.googleusercontent.com"))
            SecureField("Client secret", text: $gmail.clientSecret, prompt: Text(store.mailboxSecretStored ? "stored: leave empty to keep it" : "GOCSPX-…"))
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                Text(MailText.gmailHint)
                HStack {
                    Link("Google Cloud credentials", destination: MailText.googleCredentialsURL)
                    Link("Google's steps", destination: MailText.googleGuideURL)
                }
                Text("One consent covers Gmail and Calendar (interview events). Google warns the client is unverified: choose Advanced → continue.")
            }
            .font(.caption).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private var imapFields: some View {
        SwiftUI.Section {
            TextField("Address", text: $imap.address, prompt: Text("me@icloud.com"))
                .onSubmit { imap.applyPreset() }
                .onChange(of: imap.address) { imap.applyPreset() }
            HStack {
                TextField("IMAP server", text: $imap.imapHost, prompt: Text("imap.mail.me.com"))
                TextField("Port", text: $imap.imapPort).frame(width: 90)
            }
            HStack {
                TextField("SMTP server", text: $imap.smtpHost, prompt: Text("smtp.mail.me.com"))
                TextField("Port", text: $imap.smtpPort).frame(width: 90)
            }
            TextField("Login", text: $imap.username, prompt: Text("when it isn't the address"))
            SecureField("App password", text: $imap.password)
        } footer: {
            Text(MailText.imapHint).font(.caption).foregroundStyle(.secondary)
        }
    }

    private func prefill() {
        if let box = store.mailbox {
            kind = box.kind == "imap" ? .imap : .gmail
            if box.kind == "imap" { imap = ImapForm(box) }
            if box.hasClientID { gmail.clientId = box.clientID }
        }
        if gmail.clientId.isEmpty { gmail.clientId = store.googleClientId }
        started = waiting
    }

    private func connect() async {
        busy = true
        error = nil
        store.lastError = nil
        let ok: Bool
        switch kind {
        case .gmail:
            let form = gmail
            gmail.clientSecret = ""
            ok = await store.connectGmail(form)
        case .imap:
            let form = imap
            imap.password = ""
            ok = await store.connectImap(form)
        }
        // Shown here, not as the window's alert behind this sheet.
        if !ok {
            error = store.lastError ?? "Couldn't connect."
            store.lastError = nil
        }
        started = ok
        busy = false
    }
}
