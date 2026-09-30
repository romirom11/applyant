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
            if i > 0, steps[i - 1].count > 0 {
                let share = Double(step.count) / Double(steps[i - 1].count)
                conversion = "\(Int((share * 100).rounded()))% of \(steps[i - 1].label)"
            }
            return FunnelRow(id: step.key, label: step.label, count: step.count, conversion: conversion)
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
}
