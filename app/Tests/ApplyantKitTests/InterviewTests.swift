import ApplyantAPI
import Foundation
import Testing
@testable import ApplyantKit

func question(
    _ id: Int64,
    _ text: String,
    status: String = "open",
    project: (Int64, String)? = nil,
    application: (Int64, String)? = nil
) -> InterviewQuestion {
    .with {
        $0.id = id
        $0.text = text
        $0.status = status
        if let project {
            $0.projectID = project.0
            $0.projectName = project.1
            $0.origin = "project"
        }
        if let application {
            $0.applicationID = application.0
            $0.application = application.1
            $0.origin = "application"
        }
    }
}

func projectInterview(_ id: Int64, _ name: String, gaps: [String], asked: Int32 = 0, busy: Bool = false) -> ProjectInterview {
    .with {
        $0.project = .with {
            $0.id = id
            $0.name = name
            $0.slug = name.lowercased()
        }
        $0.gaps = gaps
        $0.asked = asked
        $0.busy = busy
    }
}

@MainActor
@Suite struct InterviewTests {
    @Test func listsWhatWaitsFirstThenProjectsWithTheMostToAsk() {
        let rows = InterviewText.rows(
            questions: [
                question(3, "How big was the team?", project: (1, "Harbor")),
                question(7, "Have you led a team?", application: (9, "Acme · Senior AI Engineer")),
                question(8, "Kubernetes in production?", status: "processing", application: (9, "Acme · Senior AI Engineer")),
            ],
            projects: [
                projectInterview(1, "Harbor", gaps: ["team"], asked: 1),
                projectInterview(2, "Lantern", gaps: ["personal_contribution", "role", "team", "impact"]),
                projectInterview(4, "Beacon", gaps: [], asked: 2),
                projectInterview(5, "Quay", gaps: ["impact"], busy: true),
            ]
        )
        #expect(rows.waiting.map(\.target) == [.project(1), .question(7), .question(8)])
        #expect(rows.waiting.map(\.title) == ["Harbor", "Have you led a team?", "Kubernetes in production?"])
        #expect(rows.waiting[1].subtitle == "For Acme · Senior AI Engineer")
        #expect(rows.waiting.map { $0.chips.first?.text } == ["Needs your answer", "Needs your answer", "Reading your answer…"])
        // Harbor is already waiting above; the rest by how much is missing.
        #expect(rows.projects.map(\.title) == ["Lantern", "Quay", "Beacon"])
        #expect(rows.projects[0].subtitle == "Missing: What you built, Your role, The team, Results")
        #expect(rows.projects.map { $0.chips.first?.text } == ["Not interviewed", "Writing a question…", "2 asked"])
        #expect(rows.projects[2].subtitle == "Nothing missing")
    }

    @Test func loadsTheInterviewCountsOpenQuestionsAndFollowsItsEvents() async throws {
        let daemon = FakeDaemon()
        daemon.questions = [question(3, "How big was the team?", project: (1, "Harbor"))]
        daemon.projectInterviews = [projectInterview(1, "Harbor", gaps: ["team"], asked: 1)]
        daemon.threads[.project(1)] = .with {
            $0.questions = daemon.questions
            $0.project = daemon.projectInterviews[0]
        }
        let store = AppStore(connector: FakeConnector([daemon]), backoff: { _ in })
        let run = Task { await store.run() }
        defer { run.cancel() }
        try await eventually("connected") { store.connection == .connected }
        #expect(store.count(.interview) == 1)
        #expect(Section.interview.isBuilt)

        await store.openInterview(.project(1))
        let thread = try #require(store.interviewThreads[.project(1)])
        #expect(InterviewText.openQuestion(thread)?.id == 3)
        #expect(!InterviewText.canAskMore(thread))

        // Answering: the question is being read, nothing waits on the candidate.
        await store.answerInterview(.project(1), question: 3, text: "Three of us.")
        #expect(daemon.calls.contains("answerInterview 3 Three of us."))
        #expect(store.count(.interview) == 0)
        #expect(store.interviewThreads[.project(1)]?.questions.first?.status == "processing")

        // The daemon reads it and asks a follow-up; an interview event brings both.
        _ = try daemon.setQuestion(3) { $0.status = "answered" }
        let followUp = question(4, "What did you build yourself?", project: (1, "Harbor"))
        daemon.questions.append(followUp)
        daemon.threads[.project(1)]?.questions.append(followUp)
        var e = Applyant_V1_InterviewEvent()
        e.questionID = 4
        e.status = "open"
        daemon.feed.yield(event(90, .interview(e)))
        try await eventually("follow-up") { store.count(.interview) == 1 }
        try await eventually("thread refreshed") {
            store.interviewThreads[.project(1)].flatMap(InterviewText.openQuestion)?.id == 4
        }

        // "Later": nothing open; the project can be asked about again.
        await store.dismissInterview(.project(1), question: 4)
        #expect(store.count(.interview) == 0)
        let after = try #require(store.interviewThreads[.project(1)])
        #expect(InterviewText.canAskMore(after))
        await store.startInterview(project: 1)
        #expect(daemon.calls.contains("startInterview 1"))
        #expect(store.interviewThreads[.project(1)]?.pending == true)
    }

    @Test func aNeedsYouAnswerOpensItsInterviewQuestion() {
        var nav = Navigation()
        nav.showReview(application: 9, posting: 5)
        nav.showInterview(.question(7))
        #expect(nav.section == .interview)
        #expect(nav.interview == .question(7))
        #expect(nav.reviewing == nil && nav.postingId == nil)
    }
}
