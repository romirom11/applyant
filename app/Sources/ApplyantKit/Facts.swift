// The facts browser (Profile and Projects) and the tailored CV's editable lines (the review's CV
// card): how a fact, its evidence and a CV line read.
import ApplyantAPI
import Foundation

public enum FactsText {
    /// The facts browser's filter.
    public enum Filter: String, CaseIterable, Sendable {
        case toConfirm = "To confirm"
        case all = "All"
    }

    /// Unconfirmed first when showing all; rejected ones only under All, last.
    public static func shown(_ facts: [Fact], filter: Filter) -> [Fact] {
        switch filter {
        case .toConfirm: facts.filter { $0.status == .unconfirmed }
        case .all:
            facts.filter { $0.status == .unconfirmed } + facts.filter { $0.status == .confirmed }
                + facts.filter { $0.status == .rejected }
        }
    }

    public static func chip(_ f: Fact) -> Chip {
        switch f.status {
        case .unconfirmed: Chip(text: "Unconfirmed", tone: .warning)
        case .confirmed: Chip(text: "Confirmed", tone: .good)
        case .rejected: Chip(text: "Rejected", tone: .neutral)
        default: Chip(text: "?", tone: .neutral)
        }
    }

    /// "Personal contribution" from "personal_contribution".
    public static func kind(_ f: Fact) -> String {
        f.kind.isEmpty ? "Other" : RolesText.title(f.kind)
    }

    /// "From the interview" / "Your edit" / nothing for extracted facts (their evidence says).
    public static func origin(_ f: Fact) -> String? {
        switch f.origin {
        case "interview": "From the interview"
        case "review_edit": "Your words"
        default: nil
        }
    }

    /// "GitHub · github.com/me/solovei · commit:1a2b3c4d".
    public static func evidence(_ e: Applyant_V1_Evidence) -> String {
        let source = KnowledgeText.title(.with { $0.kind = e.sourceKind; $0.locator = e.sourceLocator })
        return ([KnowledgeText.kindName(e.sourceKind), source] + (e.hasLocator ? [e.locator] : [])).joined(separator: " · ")
    }

    /// "3 to confirm · 12 confirmed".
    public static func counts(_ facts: [Fact]) -> String {
        let open = facts.filter { $0.status == .unconfirmed }.count
        let confirmed = facts.filter { $0.status == .confirmed }.count
        return "\(open) to confirm · \(confirmed) confirmed"
    }

    /// The ref ListFacts takes: a project id, or "profile" for the profile's own facts.
    public static func ref(_ project: Int64?) -> String { project.map(String.init) ?? "profile" }
}

/// One line of the tailored CV the candidate can edit (EditCv's handle).
public struct CvEditableLine: Identifiable, Equatable, Sendable {
    public var id: String { handle }
    public let handle: String
    /// "Summary", a project's name, "Education", or "Left out · <reason>".
    public let section: String
    public let text: String
    /// A left-out line: new words put it back; it can't be removed again.
    public let dropped: Bool
}

public enum CvText {
    /// Every line in CV order, then the left-out ones.
    public static func lines(_ cv: Applyant_V1_Cv) -> [CvEditableLine] {
        var out = cv.summary.map { CvEditableLine(handle: $0.handle, section: "Summary", text: $0.text, dropped: false) }
        for p in cv.projects {
            out += p.bullets.map { CvEditableLine(handle: $0.handle, section: p.name, text: $0.text, dropped: false) }
        }
        out += cv.education.map { CvEditableLine(handle: $0.handle, section: "Education", text: $0.text, dropped: false) }
        out += cv.dropped.map {
            CvEditableLine(handle: $0.line.handle, section: "Left out · \($0.reason)", text: $0.line.text, dropped: true)
        }
        return out
    }

    /// The tailored CV can be edited: ready or planned, not yet approved or sent.
    public static func canEdit(_ app: Application) -> Bool {
        app.hasCv && app.cv.mode == "tailored" && ["ready", "planned"].contains(app.cv.status)
            && app.stage != .approved && !StageRules.isSent(app.stage)
    }
}
