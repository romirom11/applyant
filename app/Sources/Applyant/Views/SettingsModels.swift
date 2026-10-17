// Settings (gap audit): Models (each role's route, default, fallback and what it does, with
// Change and Reset, and the opt-in to read email with a cloud model), Sites (sign in to any site
// in Applyant's browser, optionally keeping its login like the CLI's `--save-login`), and Stored
// keys (secret names only, never values, each with Delete after a confirmation).
import ApplyantAPI
import ApplyantKit
import SwiftUI

struct ModelsCard: View {
    let store: AppStore
    @State private var codexModels: [String] = []

    var body: some View {
        Card(title: "Models", accessory: {
            if store.roles.contains(where: \.overridden) {
                Button("Reset All to Defaults") { Task { await store.resetRoles() } }.controlSize(.small)
            }
        }) {
            Text("Which model does each job. A change applies to the next run, no restart needed.")
                .textRole(.meta)
            LabeledRow("Replies", note: RolesText.emailPrivacy) {
                Toggle("Read replies with a cloud model", isOn: Binding(
                    get: { RolesText.cloudEmail(store.roles) },
                    set: { on in Task { await store.setCloudEmail(on) } }
                ))
                .textRole(.body)
                .disabled(store.roles.isEmpty)
                .fixedSize()
            }
            ForEach(store.roles, id: \.role) { role in
                Divider().overlay(Theme.hairline)
                RoleRow(store: store, role: role, codexModels: codexModels)
            }
        }
        .task {
            codexModels = CodexModels.available()
            await store.openModels()
        }
    }
}

private struct RoleRow: View {
    let store: AppStore
    let role: RoleRoute
    let codexModels: [String]
    @State private var customModel = ""
    @State private var enteringModel = false

    private var provider: String { RolesText.provider(role.route) }

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(RolesText.title(role.role)).textRole(.itemTitle)
                Text(role.description_p).textRole(.meta).fixedSize(horizontal: false, vertical: true)
                Text(RolesText.line(role)).font(.system(size: 11).monospaced()).foregroundStyle(Theme.secondaryText)
            }
            .frame(maxWidth: Theme.measure, alignment: .leading)
            Spacer()
            if provider == "jev" || provider == "apple" {
                Menu(RolesText.routeName(role.route)) {
                    ForEach(RolesText.routes(for: role), id: \.self) { route in
                        Button {
                            Task { await store.setRole(role.role, route: route) }
                        } label: {
                            if route == role.route { Label(RolesText.routeName(route), systemImage: "checkmark") }
                            else { Text(RolesText.routeName(route)) }
                        }
                        .disabled(route == role.route)
                    }
                }
                .fixedSize()
            } else {
                Menu("Provider: \(provider.capitalized)") {
                    ForEach(RolesText.providers(for: role), id: \.self) { choice in
                        let route = RolesText.defaultRoute(for: choice, role: role)
                        Button(choice == "apple" ? "On-device" : choice.capitalized) {
                            Task { await store.setRole(role.role, route: route) }
                        }
                        .disabled(choice == provider)
                    }
                }
                .fixedSize()
                Menu("Model: \(RolesText.model(role.route))") {
                    ForEach(RolesText.routes(for: role, provider: provider, codexModels: codexModels), id: \.self) { route in
                        Button {
                            Task { await store.setRole(role.role, route: route) }
                        } label: {
                            if route == role.route { Label(RolesText.model(route), systemImage: "checkmark") }
                            else { Text(RolesText.model(route)) }
                        }
                        .disabled(route == role.route)
                    }
                    Divider()
                    Button("Other Model…") {
                        customModel = RolesText.model(role.route) == "Default" ? "" : RolesText.model(role.route)
                        enteringModel = true
                    }
                }
                .fixedSize()
            }
            if role.overridden {
                Button("Reset") { Task { await store.resetRoles(role.role) } }.controlSize(.small)
            }
        }
        .alert("Model for \(provider.capitalized)", isPresented: $enteringModel) {
            TextField("Model ID", text: $customModel)
            Button("Cancel", role: .cancel) {}
            Button("Save") {
                let model = customModel.trimmingCharacters(in: .whitespacesAndNewlines)
                if !model.isEmpty { Task { await store.setRole(role.role, route: "\(provider):\(model)") } }
            }
        } message: {
            Text("Use a model ID supported by your \(provider.capitalized) account.")
        }
    }
}

struct SitesCard: View {
    let store: AppStore
    @State private var signingIn = false

    var body: some View {
        Card(title: "Sites") {
            LabeledRow("Sign-ins", note: "Workday, Djinni or any site that needs an account: sign in once in Applyant's browser and the session is reused.") {
                Button("Sign In to a Site…") { signingIn = true }.fixedSize()
            }
        }
        .sheet(isPresented: $signingIn) { SiteSignInSheet(store: store) { signingIn = false }.worldSheet() }
    }
}

struct SiteSignInSheet: View {
    let store: AppStore
    let close: () -> Void
    @State private var site = ""
    @State private var saveLogin = false
    @State private var username = ""
    @State private var password = ""
    @State private var opened: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Sign in to a site").textRole(.title)
            if let opened {
                Prose("Sign in at \(opened) in the Chrome window that opened, then close that window. Deliveries wait until it is closed; the session stays in Applyant's browser.")
                HStack {
                    Spacer()
                    Button("Done", action: close).keyboardShortcut(.defaultAction)
                }
            } else {
                TextField("Site", text: $site, prompt: Text("https://acme.wd3.myworkdayjobs.com · djinni.co · linkedin"))
                    .textFieldStyle(.roundedBorder)
                Toggle("Also keep this site's login in Applyant's secrets (the Keychain)", isOn: $saveLogin)
                if saveLogin {
                    TextField("Username or email", text: $username).textFieldStyle(.roundedBorder)
                    SecureField("Password", text: $password).textFieldStyle(.roundedBorder)
                    if let target = SiteLogin.target(site) {
                        Text("Stored as \"\(SiteLogin.secretName(target))\"; it's never shown again.")
                            .textRole(.meta)
                    }
                }
                Text("Applyant's browser opens as plain Chrome, with no automation, while you sign in.")
                    .textRole(.meta)
                HStack {
                    Spacer()
                    Button("Cancel", action: close).keyboardShortcut(.cancelAction)
                    Button("Open Sign-In Window") {
                        let (s, u, p) = (site, saveLogin ? username : "", saveLogin ? password : "")
                        password = ""
                        Task { opened = await store.signIn(site: s, username: u, password: p) }
                    }
                    .keyboardShortcut(.defaultAction)
                    .disabled(SiteLogin.target(site) == nil || (saveLogin && (username.trimmingCharacters(in: .whitespaces).isEmpty || password.isEmpty)))
                }
            }
        }
        .padding(20)
        .frame(width: 520)
        .showsErrors(store)
    }
}

struct StoredKeysCard: View {
    let store: AppStore
    @State private var deleting: String?

    var body: some View {
        Card(title: "Stored keys") {
            Text("Names only: values stay in the Keychain and are never shown.").textRole(.meta)
            if store.secretNames.isEmpty {
                Text("No keys stored.").textRole(.body, color: Theme.secondaryText)
            }
            ForEach(store.secretNames, id: \.self) { name in
                LabeledRow(SecretsText.purpose(name), note: name) {
                    Button("Delete…") { deleting = name }
                        .foregroundStyle(Theme.bad)
                        .controlSize(.small)
                        .fixedSize()
                }
            }
        }
        .task { await store.openSecrets() }
        .confirmationDialog(
            "Delete \(deleting.map(SecretsText.purpose) ?? "this key")?",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })
        ) {
            Button("Delete", role: .destructive) {
                if let name = deleting { Task { await store.deleteSecret(name) } }
                deleting = nil
            }
        } message: {
            Text(deleting.map(SecretsText.deleteWarning) ?? "")
        }
    }
}
