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
    public let chips: [Chip]
    public var id: InterviewTarget { target }
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
            let chip = q.status == "processing"
                ? Chip(text: "Reading your answer…", tone: .neutral)
                : Chip(text: "Needs your answer", tone: .warning)
            if q.hasApplicationID {
                waiting.append(InterviewRow(
                    target: .question(q.id),
                    title: q.text,
                    subtitle: q.hasApplication ? "For \(q.application)" : "For application \(q.applicationID)",
                    chips: [chip]
                ))
            } else if q.hasProjectID, seenProjects.insert(q.projectID).inserted {
                waiting.append(InterviewRow(
                    target: .project(q.projectID),
                    title: q.hasProjectName ? q.projectName : "Project \(q.projectID)",
                    subtitle: q.text,
                    chips: [chip]
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
