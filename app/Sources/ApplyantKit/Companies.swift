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

    /// A row's chips: only what sets it apart. No red flags is the usual case, so it has none.
    public static func chips(_ c: Company) -> [Chip] {
        var chips: [Chip] = []
        if c.researching { chips.append(Chip(text: "Researching…", tone: .accent)) }
        if !c.redFlags.isEmpty, let flags = flags(c) { chips.append(Chip(text: flags, tone: .warning)) }
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

    /// "Layoffs": a red flag's heading in a callout (its severity is a chip beside it).
    public static func flagKind(_ f: CompanyRedFlag) -> String {
        switch f.kind {
        case "layoffs": "Layoffs"
        case "reviews": "Employee reviews"
        case "outstaffing": "Outstaffing"
        case "pay": "Pay"
        case "funding": "Funding"
        case "legal": "Legal"
        default: "Other"
        }
    }

    /// "High" (warning), "Medium" (warning), "Low" (neutral).
    public static func severityChip(_ f: CompanyRedFlag) -> Chip {
        let word = f.severity.prefix(1).uppercased() + f.severity.dropFirst()
        return Chip(text: word.isEmpty ? "Unrated" : word, tone: f.severity == "low" || f.severity.isEmpty ? .neutral : .warning)
    }

    /// "2 sources", "1 source": a finding's margin.
    public static func sourcesLabel(_ count: Int) -> String? {
        count == 0 ? nil : count == 1 ? "1 source" : "\(count) sources"
    }

    /// "2022-05-17" or "2022-05" → "MAY 2022"; a year alone stays as it is.
    public static func eyebrow(date: String) -> String? {
        let parts = date.split(separator: "-").map(String.init)
        guard let year = parts.first, year.count == 4, Int(year) != nil else { return date.isEmpty ? nil : date.uppercased() }
        guard parts.count > 1, let month = Int(parts[1]), (1 ... 12).contains(month) else { return year }
        let names = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
        return "\(names[month - 1]) \(year)"
    }

    /// The profile's facts at a glance, for its strip: Founded, Funding, Size and Offices, each
    /// short (the finding itself is the tooltip). Only the ones research found.
    public static func keyFacts(_ c: Company) -> [KeyFact] {
        func first(_ keys: [String]) -> String? {
            c.sections.first { keys.contains($0.key) }?.findings.first?.text
        }
        var facts: [KeyFact] = []
        let founding = c.sections.filter { ["founders", "product", "funding"].contains($0.key) }.flatMap(\.findings).map(\.text)
        if let year = founding.lazy.compactMap(foundedYear).first {
            facts.append(KeyFact("Founded", year, full: founding.first { foundedYear($0) == year }))
        }
        if let funding = first(["funding"]) { facts.append(KeyFact("Funding", fundingValue(funding), full: funding)) }
        if let size = first(["size"]) { facts.append(KeyFact("Size", sizeValue(size), full: size)) }
        if let offices = first(["remote"]) { facts.append(KeyFact("Offices", Score.clipped(offices, to: 28), full: offices)) }
        return facts
    }

    /// "Founded in 2015 in Berlin" → "2015".
    static func foundedYear(_ text: String) -> String? {
        guard text.lowercased().contains("found"),
              let r = text.range(of: #"\b(19|20)\d{2}\b"#, options: .regularExpression) else { return nil }
        return String(text[r])
    }

    /// "Raised a $40M Series B in 2023 led by …" → "$40M Series B"; else the sentence, short.
    static func fundingValue(_ text: String) -> String {
        let money = text.range(of: #"[$€£]\s?\d[\d.,]*\s?(?:[MBK]|million|billion)?"#, options: .regularExpression).map { String(text[$0]) }
        let round = text.range(of: #"(Series [A-H]\+?|[Ss]eed|[Pp]re-seed|IPO|[Bb]ootstrapped|[Pp]ublic)"#, options: .regularExpression).map { String(text[$0]) }
        let value = [money?.trimmingCharacters(in: .whitespaces), round].compactMap { $0 }.joined(separator: " ")
        return value.isEmpty ? Score.clipped(text, to: 28) : value
    }

    /// "About 250 employees across …" → "250 employees"; else the sentence, short.
    static func sizeValue(_ text: String) -> String {
        if let r = text.range(of: #"\d[\d,]*\s?(?:[–-]\s?\d[\d,]*)?\+?\s(?:employees|people|staff|engineers)"#, options: .regularExpression) {
            return String(text[r])
        }
        return Score.clipped(text, to: 28)
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
        guard let c else { return "Research Company" }
        if c.researching { return "Researching…" }
        return c.hasSummary ? "Research Again" : "Research Company"
    }
}
