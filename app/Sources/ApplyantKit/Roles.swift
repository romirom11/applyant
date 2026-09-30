// Settings → Models, Sites and Stored keys (gap audit): which model runs each role and the
// opt-in to read email with a cloud model; signing in to any site, with its login kept like the
// CLI's `--save-login`; the names of stored secrets (never their values) to delete.
import ApplyantAPI
import Foundation

public enum RolesText {
    /// The roles the Jev model can answer (bounded decisions); the daemon refuses it elsewhere.
    public static let decisionRoles: Set<String> = ["field_classify", "option_match", "posting_liveness", "listing_check"]
    public static let emailRole = "email_classify"
    /// The cloud route the email opt-in uses (the CLI's example: `config roles set email_classify claude:haiku`).
    public static let cloudEmailRoute = "claude:haiku"
    public static let emailPrivacy =
        "Off: replies are read by the on-device model and never leave this Mac. On: the text of each reply to an application is sent to \(cloudEmailRoute) to classify it."

    /// The routes offered for a role (the current one always among them).
    public static func routes(for role: RoleRoute) -> [String] {
        var routes: [String]
        if role.role == emailRole {
            routes = ["apple", "claude:haiku", "claude:sonnet", "codex"]
        } else {
            routes = ["claude:haiku", "claude:sonnet", "claude:opus", "codex"]
            if decisionRoles.contains(role.role) { routes.insert("jev", at: 0) }
        }
        for r in [role.route, role.defaultRoute] where !r.isEmpty && !routes.contains(r) { routes.append(r) }
        return routes
    }

    /// "Email classify" from "email_classify".
    public static func title(_ role: String) -> String {
        let words = role.split(separator: "_").map(String.init)
        guard let first = words.first else { return role }
        return ([first.prefix(1).uppercased() + first.dropFirst()] + words.dropFirst()).joined(separator: " ")
    }

    /// "codex · default claude:sonnet · falls back to claude:haiku".
    public static func line(_ role: RoleRoute) -> String {
        var parts = [role.overridden ? "\(role.route) · default \(role.defaultRoute)" : "\(role.route) (default)"]
        if role.hasFallback { parts.append("falls back to \(role.fallback)") }
        return parts.joined(separator: " · ")
    }

    public static func routeName(_ route: String) -> String {
        switch route {
        case "apple": "On-device (apple)"
        case "jev": "Jev"
        default: route
        }
    }

    /// Email is read by a cloud model (the candidate opted in).
    public static func cloudEmail(_ roles: [RoleRoute]) -> Bool {
        guard let email = roles.first(where: { $0.role == emailRole }) else { return false }
        return !email.route.hasPrefix("apple")
    }
}

public enum SiteLogin {
    /// The secret a site's login is kept under: the same name as the daemon's `loginSecretName`
    /// (`browser/login-window.ts`), so `applyant platforms signin --save-login` and the app agree.
    public static func secretName(_ site: String) -> String {
        var key = site.lowercased()
        if key.hasPrefix("https://") { key.removeFirst(8) } else if key.hasPrefix("http://") { key.removeFirst(7) }
        let allowed = Set("abcdefghijklmnopqrstuvwxyz0123456789.-")
        var out = ""
        var inRun = false
        for ch in key {
            if allowed.contains(ch) {
                out.append(ch)
                inRun = false
            } else if !inRun {
                out.append("-")
                inRun = true
            }
        }
        while out.hasPrefix("-") { out.removeFirst() }
        while out.hasSuffix("-") { out.removeLast() }
        return "login." + String(out.prefix(56))
    }

    /// The value kept in Secrets: `{"username":…,"password":…}` (what the daemon reads back).
    public static func secretValue(username: String, password: String) -> String {
        let data = (try? JSONSerialization.data(
            withJSONObject: ["username": username, "password": password], options: [.sortedKeys]
        )) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }

    /// Sign-in targets: linkedin, xing, or an http(s) URL (a bare host gets https://).
    public static func target(_ input: String) -> String? {
        let s = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty, !s.contains(" ") else { return nil }
        if ["linkedin", "xing"].contains(s.lowercased()) { return s.lowercased() }
        let url = s.contains("://") ? s : "https://" + s
        guard let parsed = URL(string: url), ["http", "https"].contains(parsed.scheme?.lowercased() ?? ""),
              let host = parsed.host, host.contains(".")
        else { return nil }
        return url
    }
}

public enum SecretsText {
    /// What a stored secret is for, from its name (values are never read).
    public static func purpose(_ name: String) -> String {
        if name.hasPrefix("login.") { return "Login for \(name.dropFirst(6))" }
        return switch name {
        case "capmonster": "Captcha solver (CapMonster)"
        case "jev": "Jev key"
        case "google.client_secret": "Google client secret"
        case "google.oauth": "Google sign-in (mailbox, Calendar, Drive)"
        case "mail.password": "Mailbox password"
        case "telegram.session": "Telegram session"
        case "telegram.account": "Telegram account"
        case "telegram.api_id", "telegram.api_hash": "Telegram app credentials"
        default: "Stored key"
        }
    }

    /// What stops working once it's gone.
    public static func deleteWarning(_ name: String) -> String {
        "\(purpose(name)) is removed from Applyant's secrets (the Keychain). Anything that needs it stops until you store it again."
    }
}
