// Settings (phase 14): the captcha solver's key (set or not, never shown), and LinkedIn/Xing:
// sign-in, a pause and Resume, the daily caps against today's use. Phase 15: Telegram connect
// (phone → code → the 2FA password), for private channels and Telegram applications. Mailbox:
// connect Gmail or IMAP/SMTP (MailboxConnect.swift), reconnect, disconnect. Models, Sites and
// Stored keys are in SettingsModels.swift.
import ApplyantAPI
import ApplyantKit
import SwiftUI

struct SettingsView: View {
    @Bindable var store: AppStore
    @State private var captchaKey = ""
    @State private var editingProfile = false
    @State private var editingProjects = false
    @State private var editingPreferences = false

    var body: some View {
        Form {
            SwiftUI.Section("Setup") {
                HStack {
                    Text(OnboardingText.search(store.onboarding)).font(.callout)
                    Spacer()
                    Button("Open the setup…") { Task { await store.openOnboarding() } }
                }
            }
            SwiftUI.Section("Profile") {
                HStack {
                    Text(profileLine).font(.callout).lineLimit(2)
                    Spacer()
                    Button("Edit profile…") { editingProfile = true }
                }
                HStack {
                    Text("\(store.knowledgeProjects.count) projects").font(.callout)
                    Spacer()
                    Button("Projects and sources…") { editingProjects = true }
                }
            }
            SwiftUI.Section("Preferences") {
                HStack {
                    Text(PreferencesText.summary(store.searchPreferences)).font(.callout).lineLimit(3)
                    Spacer()
                    Button("Edit preferences…") { editingPreferences = true }
                }
            }
            SwiftUI.Section {
                MailboxRows(store: store)
            } header: {
                Text("Mailbox")
            } footer: {
                Text("Replies move applications on, security codes are read during delivery, and approved email applications are sent from it. Passwords and secrets stay in Applyant's secrets (the Keychain).")
                    .font(.caption).foregroundStyle(.secondary)
            }
            SwiftUI.Section("Captcha solver") {
                Text(PlatformText.captcha(store.platforms)).font(.callout)
                HStack {
                    SecureField("CapMonster key", text: $captchaKey)
                    Button(store.platforms?.captchaSolver == true ? "Replace key" : "Save key") {
                        let key = captchaKey
                        captchaKey = ""
                        Task { await store.setCaptchaKey(key) }
                    }
                    .disabled(captchaKey.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                Text("Stored with Applyant's secrets (the Keychain); it's never shown again.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let open = PlatformText.signInOpen(store.platforms) {
                Text(open).font(.callout).foregroundStyle(.orange)
            }
            ForEach(store.platforms?.platforms ?? [], id: \.platform) { platform in
                PlatformSection(store: store, platform: platform)
            }
            SitesSection(store: store)
            TelegramSection(store: store)
            ModelsSection(store: store)
            StoredKeysSection(store: store)
        }
        .formStyle(.grouped)
        .navigationTitle("Settings")
        .task {
            await store.openSettings()
            await store.openProfile()
            await store.openPreferences()
        }
        .sheet(isPresented: $editingProfile) { ProfileSheet(store: store) { editingProfile = false } }
        .sheet(isPresented: $editingProjects) { ProjectsSheet(store: store) { editingProjects = false } }
        .sheet(isPresented: $editingPreferences) {
            PreferencesSheet(store: store) {
                editingPreferences = false
                Task { await store.openPreferences() }
            }
        }
    }

    private var profileLine: String {
        let entries = store.candidateProfile?.profile ?? []
        let value = { (key: String) in entries.first { $0.key == key }?.values.first }
        return [value("full_name"), value("email"), value("location")].compactMap { $0 }.joined(separator: " · ")
            .nonEmpty ?? "Name, contacts and the base CV that application forms use"
    }
}

extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}

struct PlatformSection: View {
    let store: AppStore
    let platform: Platform
    @State private var searches = 0
    @State private var applications = 0

    var body: some View {
        SwiftUI.Section {
            HStack {
                Text(PlatformText.status(platform)).font(.callout)
                Spacer()
                ChipView(chip: PlatformText.chip(platform))
            }
            HStack {
                Button(platform.hasSignedInAt ? "Sign in again" : "Sign in") {
                    Task { await store.signIn(platform.platform) }
                }
                if platform.hasPausedAt {
                    Button("Resume") { Task { await store.resumePlatform(platform.platform) } }
                }
            }
            Text(PlatformText.usage(platform)).font(.caption).foregroundStyle(.secondary)
            Stepper("Searches a day: \(searches)", value: $searches, in: 0 ... 50)
            Stepper("Applications a day: \(applications)", value: $applications, in: 0 ... 50)
            if searches != Int(platform.searchesPerDay) || applications != Int(platform.applicationsPerDay) {
                Button("Save caps") {
                    Task {
                        await store.setPlatformCaps(
                            platform.platform, searches: Int32(searches), applications: Int32(applications)
                        )
                    }
                }
            }
        } header: {
            Text(platform.name)
        }
        .onAppear { reset() }
        .onChange(of: platform) { reset() }
    }

    private func reset() {
        searches = Int(platform.searchesPerDay)
        applications = Int(platform.applicationsPerDay)
    }
}

struct TelegramSection: View {
    let store: AppStore
    @State private var phone = ""
    @State private var apiId = ""
    @State private var apiHash = ""
    @State private var code = ""
    @State private var password = ""

    var body: some View {
        let t = store.telegram
        SwiftUI.Section {
            HStack(alignment: .firstTextBaseline) {
                Text(TelegramText.status(t)).font(.callout)
                Spacer()
                ChipView(chip: TelegramText.chip(t))
            }
            switch t?.state {
            case .connected?:
                Button("Disconnect") { Task { await store.disconnectTelegram() } }
            case .waitingCode?:
                HStack {
                    TextField("Code", text: $code)
                    Button("Send code") {
                        let value = code
                        code = ""
                        Task { await store.connectTelegram(.code(value)) }
                    }
                    .disabled(code.trimmingCharacters(in: .whitespaces).isEmpty)
                    Button("Cancel") { Task { await store.connectTelegram(.cancel(true)) } }
                }
            case .waitingPassword?:
                HStack {
                    SecureField("Two-step verification password", text: $password)
                    Button("Sign in") {
                        let value = password
                        password = ""
                        Task { await store.connectTelegram(.password(value)) }
                    }
                    .disabled(password.isEmpty)
                    Button("Cancel") { Task { await store.connectTelegram(.cancel(true)) } }
                }
            default:
                if t?.apiConfigured != true {
                    TextField("api_id (my.telegram.org → API development tools)", text: $apiId)
                    SecureField("api_hash", text: $apiHash)
                }
                HStack {
                    TextField("Phone (+30…)", text: $phone)
                    Button("Connect") {
                        let start = Applyant_V1_ConnectTelegramStart.with {
                            $0.phone = phone
                            if !apiId.isEmpty { $0.apiID = apiId }
                            if !apiHash.isEmpty { $0.apiHash = apiHash }
                        }
                        apiHash = ""
                        Task { await store.connectTelegram(.start(start)) }
                    }
                    .disabled(phone.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            Text("Only the session is kept, in Applyant's secrets (the Keychain). Telegram applications are sent from this account after you approve them.")
                .font(.caption).foregroundStyle(.secondary)
        } header: {
            Text("Telegram")
        }
    }
}
