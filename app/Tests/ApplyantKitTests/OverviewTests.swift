import ApplyantAPI
import Foundation
import Testing
@testable import ApplyantKit

func overviewReport(_ window: OverviewWindow, found: Int64) -> OverviewReport {
    .with {
        $0.window = window
        if window != .all { $0.since = .init(date: Date(timeIntervalSince1970: 1_790_000_000)) }
        $0.funnel = [("found", "Found", found), ("verified", "Verified", found / 2), ("interested", "Interested", 0), ("prepared", "Prepared", 0)]
            .map { key, label, count in .with { $0.key = key; $0.label = label; $0.count = count } }
        $0.metrics = [
            .with { $0.key = "live_forms"; $0.label = "Live forms"; $0.target = "≥ 95%"; $0.display = "96% · 24 of 25"; $0.met = true },
            .with { $0.key = "review_time"; $0.label = "Review time"; $0.target = "≤ 5 min"; $0.display = "12 min median"; $0.met = false },
            .with { $0.key = "unsupported_claims"; $0.label = "Unsupported claims"; $0.target = "0"; $0.display = "—" },
            .with { $0.key = "interview_rate"; $0.label = "Interview rate"; $0.display = "10% · 1 of 10" },
        ]
    }
}

@MainActor
@Suite struct OverviewTests {
    @Test func whichStatusesCanBeSetByHand() {
        // Applied from anything not sent (sent outside Applyant); the reply statuses once sent.
        #expect(StageRules.targets(from: .readyForReview) == [.applied])
        #expect(StageRules.targets(from: .preparing) == [.applied])
        #expect(StageRules.targets(from: .approved) == [.applied])
        #expect(StageRules.targets(from: .applied) == [.interview, .offer, .rejected, .withdrawn])
        #expect(StageRules.targets(from: .interview) == [.applied, .offer, .rejected, .withdrawn])
        #expect(StageRules.targets(from: .rejected) == [.applied, .interview, .offer, .withdrawn])
        #expect(StageRules.targets(from: .withdrawn) == [.applied, .interview, .offer, .rejected])
        #expect(StageText.statusItem(.applied, from: .readyForReview) == "Applied (sent outside Applyant)")
        #expect(StageText.statusItem(.applied, from: .rejected) == "Applied")
        #expect(StageText.statusItem(.withdrawn, from: .applied) == "Withdrawn")
        #expect(StageText.chip(application(1, posting: 1, stage: .withdrawn)) == Chip(text: "Withdrawn", tone: .neutral))
        #expect(MailText.stageChip(.withdrawn)?.text == "Withdrawn")
        #expect(StageRules.isSent(.withdrawn) && !StageRules.isSent(.approved))
    }

    @Test func setStatusMovesTheApplicationAndShowsARefusal() async throws {
        let daemon = FakeDaemon(
            postings: [posting(5, score: 88, title: "Founding Engineer", appId: 9)],
            applications: [application(9, posting: 5, stage: .applied)]
        )
        let store = AppStore(connector: FakeConnector([daemon]), backoff: { _ in })
        let run = Task { await store.run() }
        defer { run.cancel() }
        try await eventually("connected") { store.connection == .connected }
        #expect(store.items(.applied).map(\.applicationId) == [9])

        #expect(await store.setStage(application: 9, to: .interview))
        #expect(daemon.calls.contains("setStage 9 interview"))
        #expect(store.items(.interviews).map(\.applicationId) == [9])
        #expect(store.items(.applied).isEmpty)
        #expect(store.lastError == nil)

        // Withdrawn stays with the sent ones, marked.
        #expect(await store.setStage(application: 9, to: .withdrawn))
        #expect(store.items(.applied).map(\.applicationId) == [9])
        #expect(store.items(.applied).first?.chips.first?.text == "Withdrawn")

        // The daemon says no (a delivery under way, a reply before it was sent): shown, nothing moves.
        daemon.stageRefusal = "application 9 is being delivered: wait for it to finish"
        #expect(await !store.setStage(application: 9, to: .applied))
        #expect(store.lastError == "application 9 is being delivered: wait for it to finish")
        #expect(store.applications[9]?.stage == .withdrawn)
    }

    @Test func rescoreSaysWhatWasEnqueued() async throws {
        let daemon = FakeDaemon(postings: [posting(1, score: 70, title: "A"), posting(2, score: 60, title: "B")])
        let store = AppStore(connector: FakeConnector([daemon]), backoff: { _ in })
        let run = Task { await store.run() }
        defer { run.cancel() }
        try await eventually("connected") { store.connection == .connected }

        #expect(await store.rescore([1]) == "Re-scoring 1 posting")
        #expect(daemon.calls.contains("scorePostings [1]"))
        #expect(await store.rescore([1]) == "Already being scored")
        // Re-score all: empty ids, and only what isn't being scored already is enqueued.
        #expect(await store.rescore() == "Re-scoring 1 posting")
        #expect(daemon.calls.contains("scorePostings []"))
        #expect(await store.rescore() == "Nothing to re-score: already being scored")
        #expect(Score.rescored(3, all: true) == "Re-scoring 3 postings")

        var closed = posting(3, score: 50, title: "C")
        closed.stage = .closed
        #expect(!Score.canRescore(closed))
        #expect(Score.canRescore(posting(4, score: 50, title: "D")))
    }

    @Test func theOverviewLoadsForItsWindowAndFollowsEvents() async throws {
        let daemon = FakeDaemon(
            postings: [posting(5, score: 88, title: "Founding Engineer", appId: 9)],
            applications: [application(9, posting: 5, stage: .applied)]
        )
        daemon.overviews = [
            .overviewWindow30Days: overviewReport(.overviewWindow30Days, found: 40),
            .overviewWindow7Days: overviewReport(.overviewWindow7Days, found: 10),
            .all: overviewReport(.all, found: 200),
        ]
        let store = AppStore(connector: FakeConnector([daemon]), backoff: { _ in })
        let run = Task { await store.run() }
        defer { run.cancel() }
        try await eventually("connected") { store.connection == .connected }
        #expect(Section.overview.isBuilt)
        #expect(store.overview == nil)

        // On appear: 30 days unless another window is picked.
        store.navigation.section = .overview
        await store.openOverview()
        #expect(daemon.calls.contains("overview overviewWindow30Days"))
        #expect(store.overview?.funnel.first?.count == 40)

        await store.openOverview(window: .overviewWindow7Days)
        #expect(store.overviewWindow == .overviewWindow7Days)
        #expect(store.overview?.funnel.first?.count == 10)
        await store.openOverview(window: .all)
        #expect(OverviewText.since(try #require(store.overview)) == "All time")

        // An application moving on while the Overview is on screen loads it again.
        daemon.overviews[.all] = overviewReport(.all, found: 201)
        daemon.applications[9]?.stage = .interview
        var stage = Applyant_V1_ApplicationEvent()
        stage.applicationID = 9
        stage.postingID = 5
        stage.stage = .interview
        daemon.feed.yield(event(70, .application(stage)))
        try await eventually("overview reloaded") { store.overview?.funnel.first?.count == 201 }

        // Setting a status loads it again.
        daemon.overviews[.all] = overviewReport(.all, found: 202)
        #expect(await store.setStage(application: 9, to: .offer))
        #expect(store.overview?.funnel.first?.count == 202)
    }

    @Test func theOverviewReadsAsAFunnelAndMetricCards() {
        let report = overviewReport(.overviewWindow30Days, found: 40)
        let rows = OverviewText.funnel(report.funnel)
        #expect(rows.map(\.count) == [40, 20, 0, 0])
        #expect(rows.map(\.conversion) == [nil, "50% of Found", "0% of Verified", nil])
        #expect(OverviewText.windows.map(OverviewText.title) == ["7 days", "30 days", "All"])
        #expect(OverviewText.title(.unspecified) == "30 days")
        #expect(OverviewText.since(report).hasPrefix("Since "))
        #expect(report.metrics.map(OverviewText.standing) == [.met, .missed, .noData, .watched])
        #expect(OverviewText.target(report.metrics[0]) == "Target ≥ 95%")
        #expect(OverviewText.target(report.metrics[3]) == "No target: watched")
    }

    /// The report on screen when the panel was redesigned (30 days to Oct 17).
    static let real: OverviewReport = .with {
        $0.window = .overviewWindow30Days
        $0.since = .init(date: Date(timeIntervalSince1970: 1_789_600_000))
        $0.funnel = [("found", "Found", 1229), ("verified", "Verified", 1078), ("interested", "Interested", 113), ("prepared", "Prepared", 109),
                     ("approved", "Approved", 5), ("applied", "Applied", 4), ("interview", "Interview", 0), ("offer", "Offer", 0)]
            .map { key, label, count in .with { $0.key = key; $0.label = label; $0.count = Int64(count) } }
        func ratio(_ n: Int64, _ d: Int64) -> Applyant_V1_OverviewRatio {
            .with { $0.numerator = n; $0.denominator = d; if d > 0 { $0.ratio = Double(n) / Double(d) } }
        }
        $0.metrics = [
            .with { $0.key = "live_forms"; $0.label = "Shortlist has no dead postings"; $0.target = "≥ 95%"; $0.display = "96% · 113 of 118"
                $0.met = true; $0.value = 113.0 / 118; $0.ratio = ratio(113, 118) },
            .with { $0.key = "interested"; $0.label = "Shortlist is relevant"; $0.target = "≥ 50%"; $0.display = "36% · 5 of 14"
                $0.met = false; $0.value = 5.0 / 14; $0.ratio = ratio(5, 14) },
            .with { $0.key = "review_time"; $0.label = "An application takes little of your time"; $0.target = "≤ 15 min"
                $0.display = "2504 min median · 5 reviews"; $0.met = false; $0.value = 2504 },
            .with { $0.key = "unsupported_claims"; $0.label = "The agent never invents experience"; $0.target = "0"
                $0.display = "0 of 26 sent · 8 corrected in review"; $0.met = true; $0.value = 0; $0.ratio = ratio(0, 26) },
            .with { $0.key = "applications_per_week"; $0.label = "Applications per week"; $0.display = "0.9 / week · 4 sent"; $0.value = 4.0 / (30.0 / 7) },
            .with { $0.key = "interview_rate"; $0.label = "Interview rate"; $0.display = "0% · 0 of 4"; $0.value = 0; $0.ratio = ratio(0, 4) },
        ]
    }

    @Test func theFunnelWritesItsShareOnTheArrowAndNamesItsStepsAsNouns() {
        let rows = OverviewText.funnel(Self.real.funnel)
        #expect(rows.map(\.shortConversion) == [nil, "88%", "10%", "96%", "5%", "80%", "0%", nil])
        #expect(rows[1].conversion == "88% of Found")
        #expect(rows.map { OverviewText.stepLabel($0.id) }
            == ["found", "verified", "interested", "prepared", "approved", "applied", "interviews", "offers"])
        #expect(OverviewText.summary(Self.real) == "4 sent from 1,229 found · 2 of 4 goals met")
    }

    @Test func aMetricCardIsFourShortLines() {
        let m = Self.real.metrics
        #expect(m.map(OverviewText.name) == ["Live postings", "Relevance", "Review time", "Invented claims", "Pace", "Interview rate"])
        #expect(m.map(OverviewText.headline) == ["96%", "36%", "1d 17h", "0", "0.9 / week", "0%"])
        #expect(m.map(OverviewText.detail) == ["113 of 118", "5 of 14", "median · 5 reviews", "of 26 sentences · 8 corrected", "4 sent", "0 of 4 sent"])
        #expect(m.map(OverviewText.goal) == ["Goal ≥ 95%", "Goal ≥ 50%", "Goal ≤ 15 min", "Goal = 0", "Watched", "Watched"])

        // Nothing to measure yet: a dash, and the goal says so.
        let empty: [OverviewMetric] = [
            .with { $0.key = "review_time"; $0.target = "≤ 15 min"; $0.display = "—" },
            .with { $0.key = "unsupported_claims"; $0.target = "0"; $0.display = "— · 3 corrected in review"; $0.value = 0
                $0.ratio = .with { $0.numerator = 0; $0.denominator = 0 } },
            .with { $0.key = "live_forms"; $0.target = "≥ 95%"; $0.display = "—"; $0.ratio = .with { $0.denominator = 0 } },
        ]
        #expect(empty.map(OverviewText.headline) == ["—", "—", "—"])
        #expect(empty.map(OverviewText.detail) == ["no reviews yet", "nothing sent yet · 3 corrected", "no forms read yet"])
        #expect(OverviewText.goal(empty[0]) == "Goal ≤ 15 min · no data yet")
        #expect(OverviewText.goal(empty[1]) == "Goal = 0 · no data yet")
        #expect(OverviewText.name(.with { $0.key = "new_one"; $0.label = "Something new" }) == "Something new")
    }
}
