// Settings (gap audit): Models (each role's route, default, fallback and what it does, with
// Change and Reset, and the opt-in to read email with a cloud model), Sites (sign in to any site
// in Applyant's browser, optionally keeping its login like the CLI's `--save-login`), and Stored
// keys (secret names only, never values, each with Delete after a confirmation).
import ApplyantAPI
import ApplyantKit
import SwiftUI

struct ModelsSection: View {
    let store: AppStore

    var body: some View {
        SwiftUI.Section {
            Toggle("Read replies with a cloud model", isOn: Binding(
                get: { RolesText.cloudEmail(store.roles) },
                set: { on in Task { await store.setCloudEmail(on) } }
            ))
            .disabled(store.roles.isEmpty)
            Text(RolesText.emailPrivacy).font(.caption).foregroundStyle(.secondary)
            ForEach(store.roles, id: \.role) { role in
                RoleRow(store: store, role: role)
            }
            if store.roles.contains(where: \.overridden) {
                HStack {
                    Spacer()
                    Button("Reset all to defaults") { Task { await store.resetRoles() } }
                }
            }
        } header: {
            Text("Models")
        } footer: {
            Text("Which model does each job. A change applies to the next run, no restart needed.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .task { await store.openModels() }
    }
}

private struct RoleRow: View {
    let store: AppStore
    let role: RoleRoute

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(RolesText.title(role.role))
                Text(role.description_p).font(.caption).foregroundStyle(.secondary)
                Text(RolesText.line(role)).font(.caption.monospaced()).foregroundStyle(.secondary)
            }
            Spacer()
            Menu(RolesText.routeName(role.route)) {
                ForEach(RolesText.routes(for: role), id: \.self) { route in
                    Button {
                        Task { await store.setRole(role.role, route: route) }
                    } label: {
                        if route == role.route { Label(RolesText.routeName(route), systemImage: "checkmark") } else { Text(RolesText.routeName(route)) }
                    }
                    .disabled(route == role.route)
                }
            }
            .fixedSize()
            if role.overridden {
                Button("Reset") { Task { await store.resetRoles(role.role) } }.controlSize(.small)
            }
        }
    }
}

struct SitesSection: View {
    let store: AppStore
    @State private var signingIn = false

    var body: some View {
        SwiftUI.Section {
            HStack {
                Text("Workday, Djinni or any site that needs an account: sign in once in Applyant's browser and the session is reused.")
                    .font(.callout)
                Spacer()
                Button("Sign in to a site…") { signingIn = true }
            }
        } header: {
            Text("Sites")
        }
        .sheet(isPresented: $signingIn) { SiteSignInSheet(store: store) { signingIn = false } }
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
            Text("Sign in to a site").font(.title2.bold())
            if let opened {
                Text("Sign in at \(opened) in the Chrome window that opened, then close that window. Deliveries wait until it is closed; the session stays in Applyant's browser.")
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
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                Text("Applyant's browser opens as plain Chrome, with no automation, while you sign in.")
                    .font(.caption).foregroundStyle(.secondary)
                HStack {
                    Spacer()
                    Button("Cancel", action: close).keyboardShortcut(.cancelAction)
                    Button("Open the sign-in window") {
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

struct StoredKeysSection: View {
    let store: AppStore
    @State private var deleting: String?

    var body: some View {
        SwiftUI.Section {
            if store.secretNames.isEmpty {
                Text("No keys stored.").font(.callout).foregroundStyle(.secondary)
            }
            ForEach(store.secretNames, id: \.self) { name in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(SecretsText.purpose(name))
                        Text(name).font(.caption.monospaced()).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Delete…", role: .destructive) { deleting = name }.controlSize(.small)
                }
            }
        } header: {
            Text("Stored keys")
        } footer: {
            Text("Names only: values stay in the Keychain and are never shown.").font(.caption).foregroundStyle(.secondary)
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
