// Minor gaps: adding a posting by URL, when the apply form was read, model runs, an
// application's notes and contacts, interview prep, and the CV template. Plain values, tested
// without SwiftUI.
import ApplyantAPI
import Foundation

public typealias AgentRun = Applyant_V1_AgentRun
public typealias ApplicationContact = Applyant_V1_ApplicationContact
public typealias CvTemplateInfo = Applyant_V1_CvTemplateInfo
public typealias CvTemplateFile = Applyant_V1_CvTemplateFile

// MARK: Add posting

/// What the Add posting sheet says after AddPosting (the same call as `applyant jobs add`).
public enum AddPostingOutcome: Equatable, Sendable {
    case added(title: String?, company: String?, url: String)
    case alreadyKnown(title: String?, company: String?, url: String, stage: String)
    case refused(String)

    public static func from(_ posting: Posting, created: Bool) -> AddPostingOutcome {
        let title = posting.hasTitle ? posting.title : nil
        let company = posting.hasCompany ? posting.company : nil
        if created { return .added(title: title, company: company, url: posting.canonicalURL) }
        return .alreadyKnown(title: title, company: company, url: posting.canonicalURL, stage: SearchText.stageWord(posting.stage))
    }

    /// "Added: Backend Engineer at Helix — it'll be verified and scored" · "Already in Applyant ·
    /// scored" · the daemon's refusal.
    public var line: String {
        switch self {
        case let .added(title, company, url):
            "Added: \(ShareOutcome.describe(title, company) ?? url) — it'll be verified and scored"
        case let .alreadyKnown(_, _, _, stage):
            "Already in Applyant · \(stage)"
        case let .refused(message):
            message
        }
    }

    /// The posting it names, under the line (nil when the line already says it).
    public var detail: String? {
        switch self {
        case let .alreadyKnown(title, company, url, _): ShareOutcome.describe(title, company) ?? url
        default: nil
        }
    }

    public var ok: Bool {
        if case .refused = self { return false }
        return true
    }
}

// MARK: Relative time

public enum Ago {
    /// "just now" · "12 min ago" · "3 h ago" · "2 d ago" · "12 Aug" (older than two weeks).
    public static func text(_ date: Date, now: Date = Date()) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        if seconds < 60 { return "just now" }
        if seconds < 3600 { return "\(Int(seconds / 60)) min ago" }
        if seconds < 86400 { return "\(Int(seconds / 3600)) h ago" }
        if seconds < 14 * 86400 { return "\(Int(seconds / 86400)) d ago" }
        return date.formatted(.dateTime.day().month(.abbreviated))
    }
}

public enum PostingText {
    /// "✓ apply form verified 3 h ago" (without the time when the daemon didn't say when); nil
    /// unless the form is verified.
    public static func formVerified(_ p: Posting, now: Date = Date()) -> String? {
        guard p.formStatus == "verified" else { return nil }
        return "✓ apply form verified" + (p.hasFormReadAt ? " " + Ago.text(p.formReadAt.date, now: now) : "")
    }
}

// MARK: Model runs

public enum AgentRunText {
    /// "Application writer".
    public static func role(_ r: AgentRun) -> String {
        let words = r.role.replacingOccurrences(of: "_", with: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }

    /// "claude/sonnet" · "apple".
    public static func route(_ r: AgentRun) -> String {
        r.hasModel && !r.model.isEmpty ? "\(r.provider)/\(r.model)" : r.provider
    }

    /// "12k" · "1.2k" · "830".
    static func count(_ n: Int64) -> String {
        n >= 10000 ? "\(n / 1000)k" : n >= 1000 ? String(format: "%.1fk", Double(n) / 1000) : "\(n)"
    }

    /// "12k in · 1.1k out"; nil when the provider didn't say.
    public static func tokens(_ r: AgentRun) -> String? {
        guard r.hasInputTokens || r.hasOutputTokens else { return nil }
        return [r.hasInputTokens ? "\(count(r.inputTokens)) in" : nil, r.hasOutputTokens ? "\(count(r.outputTokens)) out" : nil]
            .compactMap { $0 }.joined(separator: " · ")
    }

    /// "850 ms" · "4.2 s" · "2 min 5 s".
    public static func duration(_ ms: Int64) -> String {
        if ms < 1000 { return "\(ms) ms" }
        if ms < 60000 { return String(format: "%.1f s", Double(ms) / 1000) }
        let s = ms / 1000
        return s % 60 == 0 ? "\(s / 60) min" : "\(s / 60) min \(s % 60) s"
    }

    /// "Backend Engineer at Helix" · "posting 12" · nil.
    public static func entity(_ r: AgentRun) -> String? {
        if r.hasEntityLabel, !r.entityLabel.isEmpty { return r.entityLabel }
        if r.hasEntityKind, !r.entityKind.isEmpty {
            return r.hasEntityID ? "\(r.entityKind) \(r.entityID)" : r.entityKind
        }
        return nil
    }

    public static func outcome(_ r: AgentRun) -> Chip {
        switch r.outcome {
        case "ok": Chip(text: "OK", tone: .good)
        case "limit": Chip(text: "Limit", tone: .warning)
        case "invalid_output": Chip(text: "Invalid output", tone: .warning)
        case "aborted": Chip(text: "Aborted", tone: .neutral)
        default: Chip(text: r.outcome.isEmpty ? "Error" : r.outcome.prefix(1).uppercased() + r.outcome.dropFirst(), tone: .warning)
        }
    }

    /// "claude/sonnet · 12k in · 1.1k out · 4.2 s · $0.03".
    public static func line(_ r: AgentRun) -> String {
        var parts = [route(r)]
        if let t = tokens(r) { parts.append(t) }
        parts.append(duration(r.durationMs))
        if r.hasCostUsd, r.costUsd > 0 { parts.append(String(format: "$%.2f", r.costUsd)) }
        return parts.joined(separator: " · ")
    }

    /// The error, shown when the run didn't end ok.
    public static func problem(_ r: AgentRun) -> String? {
        guard r.outcome != "ok", r.hasError, !r.error.isEmpty else { return nil }
        return r.error
    }
}

// MARK: Notes and contacts

/// The Add contact form: name, role, email, LinkedIn, a note.
public struct ContactForm: Equatable, Sendable {
    public var name = ""
    public var role = ""
    public var email = ""
    public var linkedin = ""
    public var note = ""

    public init(name: String = "", role: String = "", email: String = "", linkedin: String = "", note: String = "") {
        self.name = name
        self.role = role
        self.email = email
        self.linkedin = linkedin
        self.note = note
    }

    static func clean(_ s: String) -> String? {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }

    /// Why it can't be added yet (the daemon wants a name, an email or a LinkedIn link).
    public var problem: String? {
        if Self.clean(name) == nil && Self.clean(email) == nil && Self.clean(linkedin) == nil {
            return "Give at least a name, an email or a LinkedIn link."
        }
        if let e = Self.clean(email), !e.contains("@") { return "That email address has no @." }
        return nil
    }

    /// The request for `application` (empty fields left out).
    public func request(_ application: Int64) -> Applyant_V1_AddApplicationContactRequest {
        .with {
            $0.applicationID = application
            if let v = Self.clean(name) { $0.name = v }
            if let v = Self.clean(role) { $0.role = v }
            if let v = Self.clean(email) { $0.email = v }
            if let v = Self.clean(linkedin) { $0.linkedin = v }
            if let v = Self.clean(note) { $0.note = v }
        }
    }
}

public enum ContactText {
    /// "Anna Berg · recruiter" (the email when there's no name).
    public static func title(_ c: ApplicationContact) -> String {
        let name = c.hasName && !c.name.isEmpty ? c.name : c.hasEmail && !c.email.isEmpty ? c.email : "LinkedIn contact"
        return c.hasRole && !c.role.isEmpty ? "\(name) · \(c.role)" : name
    }

    public static func mailto(_ c: ApplicationContact) -> URL? {
        guard c.hasEmail, !c.email.isEmpty else { return nil }
        return URL(string: "mailto:\(c.email)")
    }

    /// The LinkedIn link, with https:// added when it was pasted without it.
    public static func linkedin(_ c: ApplicationContact) -> URL? {
        guard c.hasLinkedin, !c.linkedin.isEmpty else { return nil }
        let s = c.linkedin.lowercased().hasPrefix("http") ? c.linkedin : "https://" + c.linkedin
        return URL(string: s)
    }
}

// MARK: Interview prep

public struct PrepSource: Equatable, Sendable, Identifiable {
    public let label: String
    public let url: URL
    public var id: String { url.absoluteString }
}

public struct PrepItem: Equatable, Sendable, Identifiable {
    public let id: Int
    public let text: String
    public let sources: [PrepSource]
}

public struct PrepSection: Equatable, Sendable, Identifiable {
    public let title: String
    public let items: [PrepItem]
    public var id: String { title }
}

public struct PrepAnswer: Equatable, Sendable, Identifiable {
    public let id: Int32
    public let question: String
    public let answer: String
}

/// The Interview prep card: the company profile (summary, product, news, stack, red flags, each
/// finding with its sources) and what the candidate told them in the application. No model run.
public struct InterviewPrep: Equatable, Sendable {
    public let company: String?
    public let sections: [PrepSection]
    public let answers: [PrepAnswer]
    /// Said when there's no researched profile yet.
    public let note: String?

    /// Shown on the application's screen at these stages.
    public static func applies(_ app: Application) -> Bool { app.stage == .interview || app.stage == .offer }

    static func sources(_ urls: [String]) -> [PrepSource] {
        urls.compactMap { u in URL(string: u).map { PrepSource(label: CompanyText.sourceLabel(u), url: $0) } }
    }

    public static func build(company c: Company?, application app: Application) -> InterviewPrep {
        var sections: [PrepSection] = []
        var note: String?
        if let c, c.hasSummary {
            sections.append(PrepSection(title: "Summary", items: [PrepItem(id: 0, text: c.summary, sources: [])]))
            for (key, title) in [("product", "Product"), ("news", "News"), ("stack", "Stack")] {
                guard let s = c.sections.first(where: { $0.key == key }), !s.findings.isEmpty else { continue }
                let items = s.findings.enumerated().map { i, f in
                    PrepItem(id: i, text: (f.hasDate && !f.date.isEmpty ? "\(f.date): " : "") + f.text, sources: sources(f.sources))
                }
                sections.append(PrepSection(title: title, items: items))
            }
            if !c.redFlags.isEmpty {
                let items = c.redFlags.enumerated().map { i, f in
                    PrepItem(id: i, text: "\(CompanyText.flagTitle(f)): \(f.text)", sources: sources(f.sources))
                }
                sections.append(PrepSection(title: "Red flags", items: items))
            }
        } else if let c, c.researching {
            note = "Company research is running; the profile shows here when it's done."
        } else {
            note = "No company profile yet: run Company research to prepare with it."
        }
        let answers = ReviewRules.activeAnswers(app).compactMap { a -> PrepAnswer? in
            let text = a.kind == "choice" && a.hasChoice ? a.choice : a.sentences.map(\.text).joined(separator: " ")
            guard a.status != "needs_candidate", !text.isEmpty else { return nil }
            return PrepAnswer(id: a.number, question: a.question, answer: text)
        }
        let name = c.map(\.name) ?? (app.hasCompany ? app.company : nil)
        return InterviewPrep(company: name, sections: sections, answers: answers, note: note)
    }
}

// MARK: The CV template

public enum CvTemplateText {
    /// Folders bigger than this aren't sent (fonts and images included).
    public static let maxBytes = 5 * 1024 * 1024

    /// "Clean · default" · "Acme letterhead · custom".
    public static func title(_ t: CvTemplateInfo) -> String {
        t.custom ? "\(t.name.isEmpty ? "cv-template" : t.name) · custom" : "\(t.name.isEmpty ? "Clean" : t.name) · default"
    }

    /// "index.html, style.css, fonts/Inter.woff2" (the first few, then "+ 3 more").
    public static func files(_ t: CvTemplateInfo, shown: Int = 6) -> String {
        guard !t.files.isEmpty else { return "no files" }
        let head = t.files.prefix(shown).joined(separator: ", ")
        return t.files.count > shown ? head + " + \(t.files.count - shown) more" : head
    }

    public enum ReadError: Error, LocalizedError, Equatable {
        case empty
        case tooBig
        case noIndex
        case unreadable(String)

        public var errorDescription: String? {
            switch self {
            case .empty: "That folder has no files."
            case .tooBig: "That folder holds more than 5 MB; a template can be at most 5 MB."
            case .noIndex: "A template needs an index.html (with {{cv}} where the CV goes)."
            case let .unreadable(path): "Couldn't read \(path)."
            }
        }
    }

    /// Reads a picked folder for SetCvTemplate: every file under it by relative path, hidden
    /// files and folders skipped, at most `maxBytes` in all. The daemon checks {{cv}}.
    public static func read(folder: URL, maxBytes: Int = maxBytes) throws -> [CvTemplateFile] {
        let root = folder.standardizedFileURL.resolvingSymlinksInPath()
        guard let walker = FileManager.default.enumerator(
            at: root, includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey], options: [.skipsHiddenFiles]
        ) else { throw ReadError.unreadable(root.path) }
        var files: [CvTemplateFile] = []
        var total = 0
        for case let url as URL in walker {
            let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
            guard values?.isRegularFile == true else { continue }
            let path = url.standardizedFileURL.resolvingSymlinksInPath().path
            guard path.hasPrefix(root.path + "/") else { continue }
            let relative = String(path.dropFirst(root.path.count + 1))
            if relative.split(separator: "/").contains(where: { $0.hasPrefix(".") }) { continue }
            total += values?.fileSize ?? 0
            if total > maxBytes { throw ReadError.tooBig }
            guard let data = try? Data(contentsOf: url) else { throw ReadError.unreadable(relative) }
            files.append(.with { $0.path = relative; $0.content = data })
        }
        guard !files.isEmpty else { throw ReadError.empty }
        guard files.contains(where: { $0.path == "index.html" }) else { throw ReadError.noIndex }
        return files.sorted { $0.path < $1.path }
    }
}
