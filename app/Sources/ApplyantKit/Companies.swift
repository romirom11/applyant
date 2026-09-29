// How company research reads on screen: the Companies list, a company's profile, and the
// short version on a posting and in review's evidence panel.
import ApplyantAPI
import Foundation

public typealias CompanyRedFlag = Applyant_V1_CompanyRedFlag
public typealias CompanySection = Applyant_V1_CompanySection

public enum CompanyText {
    /// "Researching…", "Researched 28 Sep", "Researched 2 Aug · stale", "Research failed".
    public static func state(_ c: Company, now: Date = Date()) -> String {
        if c.researching { return c.hasSummary ? "Researching again…" : "Researching…" }
        if !c.hasSummary { return c.status == "failed" ? "Research failed" : "Not researched" }
        let when = c.hasResearchedAt
            ? c.researchedAt.date.formatted(.dateTime.day().month(.abbreviated))
            : ""
        return "Researched \(when)" + (c.fresh ? "" : " · stale")
    }

    /// "No red flags" · "1 red flag" · "3 red flags"; nil before there's a profile.
    public static func flags(_ c: Company) -> String? {
        guard c.hasSummary else { return nil }
        let n = c.redFlags.count
        return n == 0 ? "No red flags" : n == 1 ? "1 red flag" : "\(n) red flags"
    }

    public static func chips(_ c: Company) -> [Chip] {
        var chips: [Chip] = []
        if c.researching { chips.append(Chip(text: "Researching…", tone: .accent)) }
        if let flags = flags(c) { chips.append(Chip(text: flags, tone: c.redFlags.isEmpty ? .good : .warning)) }
        if c.hasSummary && !c.fresh { chips.append(Chip(text: "Stale", tone: .neutral)) }
        if !c.hasSummary && c.status == "failed" && !c.researching { chips.append(Chip(text: "Failed", tone: .warning)) }
        return chips
    }

    /// "Layoffs · high": a red flag's heading.
    public static func flagTitle(_ f: CompanyRedFlag) -> String {
        let kind: String = switch f.kind {
        case "layoffs": "Layoffs"
        case "reviews": "Employee reviews"
        case "outstaffing": "Outstaffing"
        case "pay": "Pay"
        case "funding": "Funding"
        case "legal": "Legal"
        default: "Other"
        }
        return "\(kind) · \(f.severity)"
    }

    /// "acme.example.test/blog": a source link's short text.
    public static func sourceLabel(_ url: String) -> String {
        guard let u = URL(string: url), let host = u.host() else { return url }
        let host2 = host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
        let path = u.path()
        return path.count > 1 ? "\(host2)\(path.count > 30 ? String(path.prefix(30)) + "…" : path)" : host2
    }

    /// What the Company research button says for a posting's company (nil = not researched).
    public static func buttonTitle(_ c: Company?) -> String {
        guard let c else { return "Company research" }
        if c.researching { return "Researching…" }
        return c.hasSummary ? "Research again" : "Company research"
    }
}
