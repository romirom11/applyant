// What the app says so nobody has to guess: running work in plain words, what an empty list
// is waiting for, what Approve is about to do, which connections are required, and the
// readable names of preference choices. Plain values, tested without SwiftUI.
import ApplyantAPI
import Foundation

// MARK: Running work

public enum TaskText {
    /// A task kind as the candidate would say it ("checking 2 postings").
    public static func phrase(_ kind: String, count: Int = 1) -> String {
        let n = count
        func things(_ one: String, _ many: String) -> String { n == 1 ? one : "\(n) \(many)" }
        switch kind {
        case "verify_posting": return "checking " + things("a posting", "postings")
        case "score_posting": return "scoring " + things("a posting", "postings")
        case "read_form": return "reading " + things("an application form", "application forms")
        case "prepare_application": return "preparing " + things("an application", "applications")
        case "deliver_application": return "sending " + things("an application", "applications")
        case "sync_source": return "reading " + things("a source", "sources")
        case "interview_open", "interview_turn": return "reading your answers"
        case "embed_facts": return "indexing your facts"
        case "rematch_postings": return "matching postings against your new facts"
        case "search": return things("a search", "searches") + " running"
        case "build_recipe": return "learning to read " + things("a career page", "career pages")
        case "plan_search": return "planning searches"
        case "research_company": return "researching " + things("a company", "companies")
        case "sync_mail": return "reading the mailbox"
        case "interview_event": return "adding an interview to the calendar"
        default: return kind.replacingOccurrences(of: "_", with: " ")
        }
    }

    /// "checking 2 postings, scoring a posting" for the running tasks, in a stable order.
    public static func summary(_ running: [Int64: String], skipping: Set<String> = []) -> String {
        Dictionary(grouping: running.values.filter { !skipping.contains($0) }, by: { $0 })
            .map { phrase($0.key, count: $0.value.count) }
            .sorted()
            .joined(separator: ", ")
    }
}

public enum ActivityText {
    /// The main window's status line: a pause first, then what's running; nil when idle.
    public static func line(_ activity: Activity, deliveries: [Int64: DeliveryProgress], name: (Int64) -> String) -> String? {
        if let paused = activity.paused { return paused + " · work continues on its own after that" }
        let text = WorkingLine.text(running: activity.running, deliveries: deliveries, name: name)
        return text.isEmpty ? nil : text.replacingOccurrences(of: "\n", with: " · ")
    }

    public struct Empty: Equatable, Sendable {
        public let title: String
        public let detail: String
    }

    /// What an empty list is waiting for, and what to do about it.
    public static func empty(
        _ section: Section,
        activity: Activity,
        postings: [Posting],
        strategies: Int,
        searchStarted: Bool
    ) -> Empty {
        switch section {
        case .inbox:
            if let paused = activity.paused {
                return Empty(title: "Waiting", detail: paused + ". Postings are scored again once the limit is over.")
            }
            let pending = postings.filter { [.found, .verified].contains($0.stage) }.count
            if pending > 0 {
                return Empty(
                    title: "No scored postings yet",
                    detail: "\(pending) posting\(pending == 1 ? " is" : "s are") being checked and scored; they appear here with a score."
                )
            }
            if !activity.running.isEmpty {
                return Empty(title: "No scored postings yet", detail: "Working: \(TaskText.summary(activity.running)).")
            }
            if strategies == 0 {
                return Empty(
                    title: "No postings yet",
                    detail: searchStarted
                        ? "No search is set up. Add one in Search (New strategy or Plan searches), or add a posting by its link with Add posting…"
                        : "Finish the setup's Preferences step to start searching, or add a posting by its link with Add posting…"
                )
            }
            return Empty(title: "No scored postings yet", detail: "Your searches run on their schedule; new postings appear here once they're checked and scored. Search shows when each ran last.")
        case .readyToReview:
            return Empty(title: "Nothing to review", detail: "Applications appear here when a posting scores at or above your threshold, or when you press Prepare application on a posting.")
        case .preparing:
            return Empty(title: "Nothing being prepared", detail: activity.paused ?? "Answers and the CV are drafted here before they're ready to review.")
        case .interested:
            return Empty(title: "Nothing marked interested", detail: "Press Interested on a posting to keep it here.")
        case .skipped:
            return Empty(title: "Nothing skipped", detail: "Postings you skip land here; Back to Inbox undoes it.")
        case .applied:
            return Empty(title: "No applications sent yet", detail: "An application is sent right after you approve it, and stays here with what was sent.")
        case .interviews:
            return Empty(title: "No interviews yet", detail: "Invitations read from your mailbox move applications here. You can also set the status by hand.")
        case .offers:
            return Empty(title: "No offers yet", detail: "Offers read from your mailbox, or set by hand, appear here.")
        default:
            return Empty(title: "Nothing here yet", detail: "")
        }
    }
}

// MARK: Approve and deliver

public enum ApproveText {
    /// "its web form", "email", "Telegram".
    public static func channel(_ app: Application) -> String {
        switch app.channel {
        case "web_form", "": app.applyForm == .platform ? "the platform's form (Easy Apply / Xing)" : "the company's application form"
        case "email": "email from your mailbox"
        case "telegram": "Telegram, from your account"
        default: app.channel.replacingOccurrences(of: "_", with: " ")
        }
    }

    public static func company(_ app: Application) -> String {
        app.hasCompany ? app.company : (app.hasTitle ? app.title : "this posting")
    }

    public static func title(_ app: Application) -> String { "Send this application to \(company(app))?" }

    public static func message(_ app: Application) -> String {
        "It goes through \(channel(app)). Applyant submits it on its own right after; this can't be undone."
    }

    public static let retryTitle = "Try delivery again?"
    public static let retryMessage =
        "Applyant opens the form again, fills it and submits it on its own. If you already pressed submit in the browser, choose “I submitted it” instead, or it may be sent twice."

    /// The hand-off says submit may already have gone through: "I submitted it" comes first.
    public static func mayHaveBeenSent(_ app: Application) -> Bool {
        guard app.hasHandOff else { return false }
        let reason = (app.handOff.reason + " " + (app.handOff.hasDetail ? app.handOff.detail : "")).lowercased()
        return reason.contains("may have been sent") || reason.contains("may already be sent") || reason.contains("pressed submit")
    }

    public static let retryAfterSubmitMessage =
        "Submit was already pressed once, so this application may have been sent. Check the site or your mailbox for a confirmation first: trying again fills the form and submits it a second time."

    /// An approved application whose delivery stopped can go back to review to be corrected.
    public static func canReturnToReview(_ app: Application) -> Bool { app.stage == .approved && app.hasHandOff }
}

// MARK: Review: readable sources

public enum FieldText {
    /// Where a field's value came from, as the review shows it.
    public static func source(_ source: String) -> String {
        switch source {
        case "profile": "from your profile"
        case "override": "set for this application"
        case "answer": "written answer"
        case "file": "file"
        case "rule": "default choice"
        case "none", "": ""
        default: source.replacingOccurrences(of: "_", with: " ")
        }
    }

    /// A verifier flag's issue in plain words ("verifier:scope" → "claims more than the fact says").
    public static func verifierIssue(_ issue: String) -> String {
        switch issue {
        case "scope": "Claims more than its facts say"
        case "role": "Presents someone else's work as yours"
        case "unsupported": "Nothing in your facts supports this"
        case "number": "A number its facts don't back"
        case "inferred": "Draws a conclusion its facts don't state"
        default: "The check found a problem (\(issue.replacingOccurrences(of: "_", with: " ")))"
        }
    }
}

// MARK: Imported files

public enum ImportedFile {
    /// `<dataDir>/files/imports`: copies of what the candidate picked, where the background
    /// service may always read (macOS keeps it out of Desktop, Documents and Downloads).
    public static func folder(dataDir: URL) -> URL { dataDir.appendingPathComponent("files/imports", isDirectory: true) }

    /// Copies a picked file into the imports folder and returns the copy. The name is kept; a
    /// different file already there under that name gets "name 2.pdf". A folder, or a file
    /// already inside the data directory, is returned as it is.
    public static func copy(_ url: URL, dataDir: URL, fileManager fm: FileManager = .default) throws -> URL {
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: url.path, isDirectory: &isDir) else {
            throw APIError("\(url.lastPathComponent) isn't there any more.")
        }
        if isDir.boolValue || url.standardizedFileURL.path.hasPrefix(dataDir.standardizedFileURL.path + "/") { return url }
        let dir = folder(dataDir: dataDir)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let ext = url.pathExtension
        let stem = url.deletingPathExtension().lastPathComponent
        var n = 1
        while true {
            let name = (n == 1 ? stem : "\(stem) \(n)") + (ext.isEmpty ? "" : ".\(ext)")
            let target = dir.appendingPathComponent(name)
            if !fm.fileExists(atPath: target.path) {
                try fm.copyItem(at: url, to: target)
                try? fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
                return target
            }
            // The same file picked again: reuse the copy.
            if fm.contentsEqual(atPath: url.path, andPath: target.path) { return target }
            n += 1
        }
    }

    /// A file that can be sent as a CV.
    public static func isCv(_ path: String) -> Bool {
        ["pdf", "docx", "doc"].contains((path as NSString).pathExtension.lowercased())
    }
}

// MARK: Connections: required or optional

public struct ConnectionNote: Equatable, Sendable {
    public let required: Bool
    /// One line on what it's for.
    public let purpose: String
    public var tag: String { required ? "Required" : "Optional" }
}

public enum ConnectionText {
    public static let claude = ConnectionNote(
        required: true,
        purpose: "Reads your CV, scores postings and writes answers, on your Claude subscription. Nothing works without it."
    )
    public static let codex = ConnectionNote(
        required: false,
        purpose: "Plans searches and researches companies. Without it those two are skipped; everything else runs on Claude."
    )
    public static let jev = ConnectionNote(
        required: false,
        purpose: "Jev is a cheap decision API for small choices, like which form field is which. Without a key those use Claude Haiku on your subscription."
    )
    public static let github = ConnectionNote(
        required: false,
        purpose: "Tells Applyant which commits are yours when it reads a repository."
    )
    public static let mailbox = ConnectionNote(
        required: false,
        purpose: "Replies move applications on by themselves, and emailed security codes are read during sending."
    )
    public static let telegram = ConnectionNote(
        required: false,
        purpose: "Only for private Telegram job channels and applications sent over Telegram."
    )
    public static let captcha = ConnectionNote(
        required: false,
        purpose: "CapMonster solves captchas on application forms. Without a key, a captcha is handed to you in the browser."
    )

    /// The GitHub CLI's sign-in, as the GitHub section shows it: whether private repositories and
    /// pull requests can be read, as which account, and the Terminal command that fixes it.
    public struct GithubCli: Equatable, Sendable {
        public var ok: Bool
        public var text: String
        public var command: String?
    }

    public static func githubCli(_ t: Applyant_V1_ToolStatus) -> GithubCli {
        if !t.found {
            return GithubCli(
                ok: false,
                text: "GitHub CLI isn't installed · public repositories are read without it; private ones and your pull requests need it",
                command: "brew install gh && gh auth login"
            )
        }
        if !t.signedIn {
            return GithubCli(
                ok: false,
                text: "GitHub CLI isn't signed in · public repositories are read without it; private ones and your pull requests need it",
                command: "gh auth login"
            )
        }
        let who = t.account.isEmpty ? "" : " as \(t.account)"
        return GithubCli(
            ok: true,
            text: "GitHub CLI signed in\(who) · private repositories and your pull requests can be read",
            command: nil
        )
    }

    /// The signed-in GitHub account, offered as the login when none is saved yet.
    public static func suggestedGithubLogin(saved: String, _ t: Applyant_V1_ToolStatus) -> String? {
        saved.isEmpty && t.signedIn && !t.account.isEmpty ? t.account : nil
    }

    /// Claude Code is found and signed in.
    public static func claudeReady(_ status: OnboardingStatus?) -> Bool {
        guard let status else { return false }
        return status.claude.found && status.claude.signedIn
    }

    /// What to do when Claude isn't ready; nil when it is (or the daemon hasn't answered).
    public static func claudeProblem(_ status: OnboardingStatus?) -> String? {
        guard let status, !claudeReady(status) else { return nil }
        return status.claude.found
            ? "Claude Code isn't signed in. Run `claude` in Terminal, sign in, then press Check again in Connections. Until then nothing is read, scored or written."
            : "Claude Code wasn't found on this Mac. Install it (claude.com/claude-code), sign in, then press Check again in Connections. Until then nothing is read, scored or written."
    }

    /// The command that signs a tool in, for a Copy button; nil when it's signed in.
    public static func signInCommand(_ name: String, _ t: Applyant_V1_ToolStatus) -> String? {
        guard t.found, !t.signedIn else { return nil }
        return name == "Codex" ? "codex login" : "claude"
    }
}

// MARK: Preferences: readable choices

public struct Choice: Hashable, Sendable {
    public let key: String
    public let title: String
}

public enum PreferenceChoices {
    public static let seniority: [Choice] = [
        .init(key: "intern", title: "Intern"), .init(key: "junior", title: "Junior"), .init(key: "mid", title: "Mid"),
        .init(key: "senior", title: "Senior"), .init(key: "lead", title: "Lead"), .init(key: "staff", title: "Staff"),
        .init(key: "principal", title: "Principal"), .init(key: "head", title: "Head"),
    ]
    public static let employment: [Choice] = [
        .init(key: "full_time", title: "Full-time"), .init(key: "part_time", title: "Part-time"),
        .init(key: "contract", title: "Contract"), .init(key: "freelance", title: "Freelance"),
        .init(key: "internship", title: "Internship"),
    ]
    public static let remote: [Choice] = [
        .init(key: "required", title: "Remote only"), .init(key: "preferred", title: "Remote preferred"),
        .init(key: "any", title: "Doesn't matter"),
    ]
    public static let dealbreakers: [Choice] = [
        .init(key: "outstaffing", title: "Outstaffing or agency work"),
        .init(key: "onsite", title: "On-site only"),
        .init(key: "location", title: "A location you can't work from"),
        .init(key: "language", title: "A language you don't speak well enough"),
        .init(key: "employment", title: "An employment type you don't want"),
        .init(key: "seniority", title: "A seniority level you didn't pick"),
    ]

    /// The cap on applications Applyant starts by itself, as the stepper reads.
    public static func dailyCap(_ n: Int) -> String {
        n == 0 ? "Applications started on their own per day: none" : "Applications started on their own per day: \(n)"
    }
    public static let dailyCapNote =
        "Each one costs a writer run, a tailored CV and company research on your subscriptions. 0 means only the ones you ask for with Prepare application."

    public static func dealbreaker(_ key: String) -> String { dealbreakers.first { $0.key == key }?.title ?? key }
    public static func weight(_ key: String) -> String { Score.componentTitles[key] ?? key }

    /// "senior, Lead" → its keys, lower-cased, in the order typed.
    public static func keys(_ text: String) -> [String] {
        text.components(separatedBy: CharacterSet(charactersIn: ",\n"))
            .map { $0.trimmingCharacters(in: .whitespaces).lowercased() }.filter { !$0.isEmpty }
    }

    /// Toggles a key in a comma-separated list, keeping the choices' own order.
    public static func toggled(_ text: String, _ key: String, among choices: [Choice]) -> String {
        var set = Set(keys(text))
        if set.contains(key) { set.remove(key) } else { set.insert(key) }
        let known = choices.map(\.key).filter(set.contains)
        let unknown = keys(text).filter { k in set.contains(k) && !choices.contains { $0.key == k } }
        return (known + unknown).joined(separator: ", ")
    }

}
