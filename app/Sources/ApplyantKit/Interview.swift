// The interview as the app shows it: which thread is open, the rows of the Interview list, and
// what a thread lets the candidate do next. Plain values, tested without SwiftUI.
import ApplyantAPI
import Foundation

/// One conversation: a project's interview, or one application question (and its follow-up).
public enum InterviewTarget: Hashable, Sendable {
    case project(Int64)
    case question(Int64)
}

public struct InterviewRow: Identifiable, Equatable, Sendable {
    public let target: InterviewTarget
    public let title: String
    public let subtitle: String
    /// Only what sets the row apart from its group ("Reading your answer…"), never "Needs your answer".
    public let chips: [Chip]
    /// The header a waiting row sits under: its application ("Canonical · Python Software
    /// Engineer"), or "Project questions".
    public var group: String? = nil
    public var id: InterviewTarget { target }
}

/// Waiting rows under one header: an application's questions, or the projects' ones.
public struct InterviewGroup: Identifiable, Equatable, Sendable {
    public let title: String
    public let rows: [InterviewRow]
    public var id: String { title }
}

public enum InterviewText {
    public static let gapTitles: [String: String] = [
        "personal_contribution": "What you built",
        "role": "Your role",
        "team": "The team",
        "impact": "Results",
    ]

    /// "Waiting for you" (application questions first) and the projects, as the list shows them.
    public static func rows(questions: [InterviewQuestion], projects: [ProjectInterview]) -> (waiting: [InterviewRow], projects: [InterviewRow]) {
        var waiting: [InterviewRow] = []
        var seenProjects = Set<Int64>()
        for q in questions {
            // Everything here waits for an answer (the header says so): a chip only when not.
            let chips = q.status == "processing" ? [Chip(text: "Reading your answer…", tone: .neutral)] : []
            if q.hasApplicationID {
                let application = q.application.isEmpty ? "Application \(q.applicationID)" : q.application
                waiting.append(InterviewRow(
                    target: .question(q.id),
                    title: q.text,
                    subtitle: "For \(application)",
                    chips: chips,
                    group: application
                ))
            } else if q.hasProjectID, seenProjects.insert(q.projectID).inserted {
                waiting.append(InterviewRow(
                    target: .project(q.projectID),
                    title: q.hasProjectName ? q.projectName : "Project \(q.projectID)",
                    subtitle: q.text,
                    chips: chips,
                    group: projectsGroup
                ))
            }
        }
        let rest = projects
            .filter { !seenProjects.contains($0.project.id) }
            .sorted { ($0.gaps.count, $1.project.name) > ($1.gaps.count, $0.project.name) }
            .map { p in
                InterviewRow(
                    target: .project(p.project.id),
                    title: p.project.name,
                    subtitle: p.gaps.isEmpty
                        ? "Nothing missing"
                        : "Missing: " + p.gaps.map { gapTitles[$0] ?? $0 }.joined(separator: ", "),
                    chips: projectChips(p)
                )
            }
        return (waiting, rest)
    }

    /// The group of questions about the candidate's projects.
    public static let projectsGroup = "Project questions"

    /// The waiting rows under one header per application (or the projects), in the order
    /// their first question comes, so an application's questions stand together.
    public static func groups(_ waiting: [InterviewRow]) -> [InterviewGroup] {
        var order: [String] = []
        var rows: [String: [InterviewRow]] = [:]
        for row in waiting {
            let key = row.group ?? projectsGroup
            if rows[key] == nil { order.append(key) }
            rows[key, default: []].append(row)
        }
        return order.map { InterviewGroup(title: $0, rows: rows[$0] ?? []) }
    }

    static func projectChips(_ p: ProjectInterview) -> [Chip] {
        if p.busy { return [Chip(text: "Writing a question…", tone: .neutral)] }
        if p.asked > 0 { return [Chip(text: "\(p.asked) asked", tone: .good)] }
        if !p.gaps.isEmpty { return [Chip(text: "Not interviewed", tone: .accent)] }
        return []
    }

    /// The question waiting for the candidate's answer in a thread, if any.
    public static func openQuestion(_ thread: InterviewThread) -> InterviewQuestion? {
        thread.questions.last { $0.status == "open" }
    }

    /// Whether a project thread can ask for more (nothing open, nothing being worked on).
    public static func canAskMore(_ thread: InterviewThread) -> Bool {
        thread.hasProject && !thread.pending && openQuestion(thread) == nil
    }
}
