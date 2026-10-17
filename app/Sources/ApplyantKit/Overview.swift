// How the Overview reads on screen: the window picker, the funnel with each step's conversion
// from the one before, and the success metrics as cards (target held, missed, or only watched).
import ApplyantAPI
import Foundation

public typealias OverviewReport = Applyant_V1_GetOverviewResponse
public typealias OverviewWindow = Applyant_V1_OverviewWindow
public typealias OverviewMetric = Applyant_V1_OverviewMetric
public typealias FunnelStep = Applyant_V1_FunnelStep

/// One funnel step as a row: its count and the share of the step before it.
public struct FunnelRow: Identifiable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let count: Int64
    /// "62% of Verified"; nil for the first step, or when the step before it is empty.
    public let conversion: String?
    /// The same share written on the funnel strip's arrow: "88%".
    public var shortConversion: String? = nil
}

public enum OverviewText {
    /// The picker's windows, in order.
    public static let windows: [OverviewWindow] = [.overviewWindow7Days, .overviewWindow30Days, .all]

    public static func title(_ window: OverviewWindow) -> String {
        switch window {
        case .overviewWindow7Days: "7 days"
        case .all: "All"
        default: "30 days"
        }
    }

    /// "Since 1 Sep" for a window, "All time" without one.
    public static func since(_ report: OverviewReport) -> String {
        guard report.hasSince else { return "All time" }
        return "Since " + report.since.date.formatted(.dateTime.day().month(.abbreviated))
    }

    public static func funnel(_ steps: [FunnelStep]) -> [FunnelRow] {
        steps.enumerated().map { i, step in
            var conversion: String?
            var short: String?
            if i > 0, steps[i - 1].count > 0 {
                let share = Double(step.count) / Double(steps[i - 1].count)
                let pct = percent(share)
                short = pct
                conversion = "\(pct) of \(steps[i - 1].label)"
            }
            return FunnelRow(id: step.key, label: step.label, count: step.count, conversion: conversion, shortConversion: short)
        }
    }

    /// The list a funnel step's postings are in now, for the row's link.
    public static func section(forStep key: String) -> Section? {
        switch key {
        case "found", "verified": .new
        case "interested", "prepared": .toReview
        case "approved", "applied": .applied
        case "interview": .interviews
        case "offer": .offers
        default: nil
        }
    }

    public enum Standing: Equatable, Sendable {
        /// The target holds.
        case met
        /// The target is missed.
        case missed
        /// A target, but nothing to measure yet.
        case noData
        /// A number the funnel watches, with no target.
        case watched
    }

    public static func standing(_ m: OverviewMetric) -> Standing {
        if m.target.isEmpty { return .watched }
        guard m.hasMet else { return .noData }
        return m.met ? .met : .missed
    }

    /// "Target ≥ 95%" · "No target: watched".
    public static func target(_ m: OverviewMetric) -> String {
        m.target.isEmpty ? "No target: watched" : "Target \(m.target)"
    }

    // MARK: The metric card's four lines

    /// The card's name, a few words ("Live postings"); the daemon's label is a whole claim.
    public static func name(_ m: OverviewMetric) -> String {
        switch m.key {
        case "live_forms": "Live postings"
        case "interested": "Relevance"
        case "review_time": "Review time"
        case "unsupported_claims": "Invented claims"
        case "applications_per_week": "Pace"
        case "interview_rate": "Interview rate"
        default: m.label
        }
    }

    /// The card's number: "96%", "1d 17h", "0", "0.9 / week"; "—" with nothing to measure.
    public static func headline(_ m: OverviewMetric) -> String {
        guard m.hasValue else { return "—" }
        switch m.key {
        case "live_forms", "interested", "interview_rate":
            return percent(m.value)
        case "review_time":
            return minutes(m.value)
        case "unsupported_claims":
            // Nothing sent, nothing to count yet.
            return m.hasRatio && m.ratio.denominator == 0 ? "—" : "\(Int(m.value))"
        case "applications_per_week":
            return String(format: "%.1f / week", m.value)
        default:
            return m.display
        }
    }

    /// The line under the number: what it's out of ("113 of 118", "median · 5 reviews",
    /// "of 26 sentences · 8 corrected", "4 sent", "0 of 4 sent").
    public static func detail(_ m: OverviewMetric) -> String {
        let r = m.ratio
        switch m.key {
        case "live_forms", "interested":
            guard r.denominator > 0 else { return m.key == "live_forms" ? "no forms read yet" : "none decided yet" }
            return "\(r.numerator) of \(r.denominator)"
        case "interview_rate":
            return r.denominator > 0 ? "\(r.numerator) of \(r.denominator) sent" : "none sent yet"
        case "review_time":
            // The display's tail is the count: "2504 min median · 5 reviews".
            guard m.hasValue, let reviews = tail(m.display) else { return "no reviews yet" }
            return "median · " + reviews
        case "unsupported_claims":
            let corrected = correctedCount(m.display).map { " · \($0) corrected" } ?? ""
            return (r.denominator > 0 ? "of \(r.denominator) sentences" : "nothing sent yet") + corrected
        case "applications_per_week":
            return tail(m.display) ?? m.display
        default:
            return m.definition
        }
    }

    /// The card's last line: "Goal ≥ 95%", "Goal ≤ 15 min · no data yet", "Watched".
    public static func goal(_ m: OverviewMetric) -> String {
        guard !m.target.isEmpty else { return "Watched" }
        // A bare number ("0") reads as an equation; the others carry their comparison.
        let target = m.target.first.map { $0.isNumber } == true ? "= " + m.target : m.target
        return "Goal \(target)" + (standing(m) == .noData ? " · no data yet" : "")
    }

    /// The panel's one-line take: "4 sent from 1,229 found · 2 of 4 goals met".
    public static func summary(_ report: OverviewReport) -> String {
        let count = { (key: String) in report.funnel.first { $0.key == key }?.count ?? 0 }
        let goals = report.metrics.filter { !$0.target.isEmpty }
        let met = goals.filter { standing($0) == .met }.count
        var line = "\(count("applied").formatted()) sent from \(count("found").formatted()) found"
        if !goals.isEmpty { line += " · \(met) of \(goals.count) goal\(goals.count == 1 ? "" : "s") met" }
        return line
    }

    /// A funnel step's word under its number, a plural noun ("found", "interviews").
    public static func stepLabel(_ key: String) -> String {
        switch key {
        case "interview": "interviews"
        case "offer": "offers"
        default: key
        }
    }

    private static func percent(_ share: Double) -> String { "\(Int((share * 100).rounded()))%" }

    /// Minutes as the largest two units: 2504 → "1d 17h", 12 → "12m".
    private static func minutes(_ value: Double) -> String {
        guard value >= 1 else { return "< 1m" }
        return Duration.seconds(value * 60).formatted(
            .units(allowed: [.days, .hours, .minutes], width: .narrow, maximumUnitCount: 2, fractionalPart: .hide(rounded: .towardZero)))
    }

    /// What follows the display's last " · ".
    private static func tail(_ display: String) -> String? {
        guard let range = display.range(of: " · ", options: .backwards) else { return nil }
        return String(display[range.upperBound...])
    }

    /// "8" from "… · 8 corrected in review".
    private static func correctedCount(_ display: String) -> Int? {
        guard let range = display.range(of: #"\d+(?= corrected)"#, options: .regularExpression) else { return nil }
        return Int(display[range])
    }
}
