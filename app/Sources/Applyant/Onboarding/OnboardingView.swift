// The first-launch setup (phase 16): 1 Connections · 2 Import · 3 Preferences (pre-filled from
// the CV; search starts when it's done) · 4 Interview (the phase-9 chat, or Later). Shown over
// the main window on the first launch while setup isn't done; the menu and Settings reopen it.
// The steps' rules live in ApplyantKit's OnboardingFlow.
import AppKit
import ApplyantAPI
import ApplyantKit
import SwiftUI
import UniformTypeIdentifiers

struct OnboardingView: View {
    @Bindable var store: AppStore

    var body: some View {
        let flow = store.onboarding
        VStack(spacing: 0) {
            HStack(spacing: 18) {
                ForEach(OnboardingStep.allCases) { step in
                    Button {
                        store.onboarding.open(step)
                    } label: {
                        StepBadge(step: step, state: flow.state(step), current: flow.current == step)
                    }
                    .buttonStyle(.plain)
                    .disabled(!flow.canOpen(step))
                }
                Spacer()
                Button("Close") { store.showOnboarding = false }
                    .keyboardShortcut(.cancelAction)
            }
            .padding(16)
            Divider()
            VStack(alignment: .leading, spacing: 12) {
                Text("\(flow.current.number) · \(flow.current.title)").font(.title2.bold())
                Text(flow.current.summary).foregroundStyle(.secondary)
                Group {
                    switch flow.current {
                    case .connections: ConnectionsStep(store: store)
                    case .importing: ImportStep(store: store)
                    case .preferences: PreferencesStep(store: store)
                    case .interview: InterviewStep(store: store)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            .padding(20)
            Divider()
            HStack {
                Text(OnboardingText.search(flow)).font(.callout).foregroundStyle(flow.searchStarted ? .green : .secondary)
                Spacer()
                if let skip = flow.current.skipState {
                    Button(skip == "later" ? "Later" : "Skip") {
                        Task { await store.settleStep(flow.current, as: skip) }
                    }
                }
                if flow.current != .preferences {
                    Button(flow.current == .interview ? "Done" : "Continue") {
                        Task { await store.settleStep(flow.current) }
                    }
                    .keyboardShortcut(.defaultAction)
                }
            }
            .padding(16)
        }
        .task { await store.refreshSetup(refresh: true) }
    }
}

private struct StepBadge: View {
    let step: OnboardingStep
    let state: String
    let current: Bool

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: state == "done" ? "checkmark.circle.fill" : state == "pending" ? "\(step.number).circle" : "arrow.uturn.forward.circle")
                .foregroundStyle(state == "done" ? .green : current ? .accentColor : .secondary)
            Text(step.title).fontWeight(current ? .semibold : .regular)
        }
    }
}

private struct ConnectionsStep: View {
    @Bindable var store: AppStore
    @State private var github = ""
    @State private var jev = ""

    var body: some View {
        let s = store.setup
        Form {
            SwiftUI.Section("Agents on this Mac") {
                if let s {
                    Row(ok: s.claude.found && s.claude.signedIn, text: OnboardingText.tool("Claude Code", s.claude))
                    Row(ok: s.codex.found && s.codex.signedIn, text: OnboardingText.tool("Codex", s.codex))
                } else {
                    Text("The daemon isn't answering yet.").foregroundStyle(.secondary)
                }
                Button("Check again") { Task { await store.refreshSetup(refresh: true) } }
            }
            SwiftUI.Section("Jev") {
                Row(ok: s?.jev.connected == true, text: s.map { OnboardingText.connection($0.jev) } ?? "")
                HStack {
                    SecureField("Jev API key", text: $jev)
                    Button("Save key") {
                        let key = jev
                        jev = ""
                        Task { await store.setJevKey(key) }
                    }
                    .disabled(jev.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            SwiftUI.Section("GitHub") {
                Row(ok: s?.github.connected == true, text: s.map { OnboardingText.connection($0.github) } ?? "")
                HStack {
                    TextField("Your GitHub login(s), comma-separated", text: $github)
                    Button("Save") { Task { await store.setGithubLogin(github) } }
                        .disabled(github.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            SwiftUI.Section("Mailbox and Google") {
                MailboxRows(store: store)
                Row(ok: s?.calendar.connected == true, text: "Calendar: " + (s.map { OnboardingText.connection($0.calendar) } ?? ""))
                Row(ok: s?.drive.connected == true, text: "Drive: " + (s.map { OnboardingText.connection($0.drive) } ?? ""))
                Text("Gmail: one Google consent covers Gmail, Calendar and Drive. Any other mailbox: IMAP + SMTP with an app password.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            SwiftUI.Section("Optional") {
                Row(ok: s?.telegram.connected == true, text: "Telegram: " + (s.map { OnboardingText.connection($0.telegram) } ?? ""))
                Row(ok: s?.captcha.connected == true, text: "Captchas: " + (s.map { OnboardingText.connection($0.captcha) } ?? ""))
                Text("Both are in Settings.").font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }
}

private struct Row: View {
    let ok: Bool
    let text: String

    var body: some View {
        Label {
            Text(text).textSelection(.enabled)
        } icon: {
            Image(systemName: ok ? "checkmark.circle.fill" : "circle.dashed").foregroundStyle(ok ? .green : .secondary)
        }
    }
}

private struct ImportStep: View {
    @Bindable var store: AppStore
    @State private var link = ""
    @State private var github = ""
    @State private var picking = false
    @State private var editingProfile = false
    @State private var editingProjects = false

    var body: some View {
        Form {
            SwiftUI.Section("Your CV or LinkedIn PDF") {
                Button("Choose a file…") { picking = true }
                Text("Drafted into projects and facts in the background; you confirm facts before anything is sent.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            SwiftUI.Section("GitHub") {
                HStack {
                    TextField("Your GitHub login", text: $github)
                    Button("Save") { Task { await store.setGithubLogin(github) } }
                        .disabled(github.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                Text("Repositories belong to projects: add them under Projects and sources.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            SwiftUI.Section("Profile and projects") {
                HStack {
                    Text("Your name, contacts, work authorization and base CV; projects with their repos, files and pages.")
                        .font(.callout)
                    Spacer()
                    Button("Edit profile…") { editingProfile = true }
                    Button("Projects and sources…") { editingProjects = true }
                }
            }
            SwiftUI.Section("Links and Google Docs") {
                HStack {
                    TextField("A portfolio page, a case study, a Docs or Drive link (a Drive folder works too)", text: $link)
                    Button("Add") {
                        let value = link
                        Task { if await store.importSource(value) { link = "" } }
                    }
                    .disabled(link.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            SwiftUI.Section("So far") {
                Text(OnboardingText.importProgress(store.setup))
                Button("Refresh") { Task { await store.refreshSetup() } }
            }
        }
        .formStyle(.grouped)
        .fileImporter(isPresented: $picking, allowedContentTypes: [.pdf, .plainText, UTType(filenameExtension: "docx") ?? .data]) { result in
            if case let .success(url) = result { Task { await store.importSource(url.path) } }
        }
        .sheet(isPresented: $editingProfile) { ProfileSheet(store: store) { editingProfile = false } }
        .sheet(isPresented: $editingProjects) {
            ProjectsSheet(store: store) {
                editingProjects = false
                Task { await store.refreshSetup() }
            }
        }
    }
}

private struct PreferencesStep: View {
    @Bindable var store: AppStore
    @State private var values: [String: String] = [:]
    @State private var loaded = false

    /// The keys this step asks about, in order, with how to write them.
    private static let fields: [(key: String, label: String, hint: String)] = [
        ("roles", "Roles", "backend, ai_ml, fullstack, data, platform, founding …"),
        ("seniority", "Seniority", "senior, lead"),
        ("based_in", "Based in", "a country code: GR"),
        ("locations", "Also on-site/hybrid in", "country codes: CY, DE"),
        ("remote", "Remote", "required · preferred · any"),
        ("salary", "Target salary", "4500 EUR/month or 60k EUR/year"),
        ("languages", "Languages", "en:C1, el:native"),
        ("dealbreakers", "Dealbreakers", "outstaffing, onsite, location, language, employment, seniority"),
    ]

    var body: some View {
        Form {
            SwiftUI.Section("Pre-filled from your CV: adjust, then start searching") {
                ForEach(Self.fields, id: \.key) { field in
                    VStack(alignment: .leading, spacing: 2) {
                        TextField(field.label, text: Binding(
                            get: { values[field.key] ?? "" },
                            set: { values[field.key] = $0 }
                        ), prompt: Text(field.hint))
                        if let s = store.preferencesDraft.first(where: { $0.key == field.key }) {
                            Text(s.reason).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                }
            }
            HStack {
                Spacer()
                Button("Start searching") {
                    let pairs = Self.fields.map { (key: $0.key, value: values[$0.key] ?? "") }
                    Task { await store.confirmPreferences(pairs) }
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .formStyle(.grouped)
        .task {
            guard !loaded else { return }
            await store.loadPreferencesDraft()
            for s in store.preferencesDraft where (values[s.key] ?? "").isEmpty { values[s.key] = s.value }
            loaded = true
        }
    }
}

private struct InterviewStep: View {
    @Bindable var store: AppStore

    var body: some View {
        HSplitView {
            InterviewList(store: store)
                .frame(minWidth: 240, idealWidth: 280)
            Group {
                if let target = store.navigation.interview {
                    InterviewThreadView(store: store, target: target).id(target)
                } else {
                    ContentUnavailableView(
                        "Pick a project",
                        systemImage: ApplyantKit.Section.interview.symbol,
                        description: Text("The agent asks what your sources can't show. Or choose Later: the Interview section keeps the questions.")
                    )
                }
            }
            .frame(minWidth: 380)
        }
    }
}
