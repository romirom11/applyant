// Home: the greeting, the line under it, the tile that lights up while Applyant works and what
// it says, the tiles' numbers and what they count, the round button, the compact grid, Up next
// and the funnel's tile. Also the rail's order and every section's colour world.
import ApplyantAPI
import Foundation
import Testing
@testable import ApplyantKit

@MainActor
@Suite struct HomeTests {
    private func at(hour: Int) -> Date {
        var c = DateComponents()
        (c.year, c.month, c.day, c.hour, c.minute) = (2026, 10, 17, hour, 5)
        return Calendar.current.date(from: c)!
    }

    @Test func theGreetingFollowsTheTimeOfDayAndTheFirstName() {
        #expect(HomeText.greeting(name: "Roman Kudin", at: at(hour: 8)) == "Good morning, Roman")
        #expect(HomeText.greeting(name: "Roman", at: at(hour: 13)) == "Good afternoon, Roman")
        #expect(HomeText.greeting(name: " Roman ", at: at(hour: 19)) == "Good evening, Roman")
        #expect(HomeText.greeting(name: nil, at: at(hour: 2)) == "Good night")
        #expect(HomeText.greeting(name: "", at: at(hour: 23)) == "Good night")
    }

    @Test func theLineUnderItSaysWhatWaitsOrThatItsPaused() {
        var input = HomeInput()
        #expect(HomeText.state(input) == "You're all caught up. Your searches run on their schedule.")
        input.newMatches = 3
        #expect(HomeText.state(input) == "Nothing waits for you. 3 new good matches to look at.")
        input.ready = 1
        #expect(HomeText.state(input) == "1 application is ready to send.")
        input.needsYou = 19
        input.ready = 80
        #expect(HomeText.state(input) == "19 applications need you and 80 are ready to send.")
        input.needsYou = 1
        input.ready = 0
        #expect(HomeText.state(input) == "1 application needs you.")
        input.waiting = "Waiting for claude limit · resumes 15:45"
        #expect(HomeText.state(input) == "1 application needs you. Waiting for claude limit · resumes 15:45.")
        // Paused: the queue still leads; the date is the toolbar pill's.
        input.waiting = nil
        input.pausedAt = Date()
        input.needsYou = 19
        input.ready = 80
        #expect(HomeText.state(input) == "19 applications need you and 80 are ready to send. Searching is paused.")
        input = HomeInput()
        input.pausedAt = Date()
        #expect(HomeText.state(input) == "You're all caught up. Searching is paused.")
    }

    @Test func aDeliveryLightsUpAppliedEvenWhilePaused() {
        var input = HomeInput()
        input.pausedAt = Date()
        input.preparing = [("Kalepa", "Staff Engineer")]
        #expect(HomeText.live(input) == nil)
        var progress = DeliveryProgress()
        progress.apply("16 fields")
        progress.apply("filling 12/16: Email")
        input.deliveries = [("Djinni", progress), ("Helix", DeliveryProgress())]
        let live = try! #require(HomeText.live(input))
        #expect(live.tile == .applied)
        #expect(live.title == "Sending to Djinni…")
        #expect(live.note == "Filling 12/16 fields")
        #expect(live.fraction == 0.75)
        #expect(live.items.map(\.title) == ["Helix"])
    }

    @Test func aRunningSearchReadsItsSourcesOneAfterAnother() {
        var input = HomeInput()
        input.searching = [("Backend Europe", [("Djinni", "38 listed · 3 new"), ("Workable job search", nil), ("Ashby", nil)])]
        input.preparing = [("Kalepa", "Staff Engineer")]
        let live = try! #require(HomeText.live(input))
        #expect(live.tile == .search)
        #expect(live.title == "Reading Workable job search…")
        #expect(live.note == "Backend Europe")
        #expect(live.items.map(\.done) == [true, false, false])
        #expect(live.items.first?.detail == "38 listed · 3 new")
        // Every source read: the search itself.
        input.searching = [("Backend Europe", [("Djinni", "38 listed")])]
        #expect(HomeText.live(input)?.title == "Searching Backend Europe…")
    }

    @Test func writingAnswersLightsUpReadyToSend() {
        var input = HomeInput()
        input.preparing = [("Kalepa", "Staff Engineer"), ("LiveKit", "Software Engineer")]
        let live = try! #require(HomeText.live(input))
        #expect(live.tile == .ready)
        #expect(live.title == "Writing answers for Kalepa…")
        #expect(live.note == "Staff Engineer")
        #expect(live.items.map(\.detail) == ["Staff Engineer", "waiting…"])
        // One alone: no list, the title says it.
        input.preparing = [("Kalepa", "Staff Engineer")]
        #expect(HomeText.live(input)?.items.isEmpty == true)
    }

    @Test func otherWorkLightsUpTheTileItBelongsTo() {
        var input = HomeInput()
        #expect(HomeText.live(input) == nil)
        input.running = ["score_posting", "score_posting", "sync_mail"]
        #expect(HomeText.live(input) == HomeLive(tile: .new, title: "Scoring 2 postings…"))
        input.running = ["plan_search"]
        #expect(HomeText.live(input)?.tile == .search)
        input.running = ["interview_turn"]
        #expect(HomeText.live(input) == HomeLive(tile: .questions, title: "Reading your answers…"))
        input.running = ["sync_mail"]
        #expect(HomeText.live(input) == HomeLive(tile: .applied, title: "Reading the mailbox…"))
        input.running = ["research_company"]
        #expect(HomeText.live(input)?.tile == .ready)
        // A limit's pause: nothing lights up.
        input.waiting = "Waiting for claude limit"
        #expect(HomeText.live(input) == nil)
    }

    @Test func tilesShowTheirNumberOrThatNothingIsLeft() {
        var input = HomeInput()
        input.ready = 80
        input.newMatches = 1
        #expect(HomeText.figure(.ready, input) == HomeFigure(value: 80, caption: "applications to send"))
        #expect(HomeText.figure(.new, input) == HomeFigure(value: 1, caption: "good match"))
        #expect(HomeText.figure(.needsYou, input).done == "Nothing waits")
        input.needsYou = 19
        #expect(HomeText.figure(.needsYou, input).caption == "applications need you")
        input.applied = 1
        #expect(HomeText.figure(.applied, input).caption == "application sent")
        #expect(HomeText.figure(.questions, input).done == "All answered")
        input.ready = 0
        #expect(HomeText.figure(.ready, input).done == "All sent")
        input.preparing = [("Kalepa", "")]
        #expect(HomeText.figure(.ready, input).done == nil)
        input.searches = 2
        #expect(HomeText.figure(.search, input).caption == "searches on their schedule")
        // The number says what it counts: "14 searches · paused", never "14 / paused".
        input.searches = 14
        input.pausedAt = Date()
        #expect(HomeText.figure(.search, input).caption == "searches · paused")
        input.searches = 1
        #expect(HomeText.figure(.search, input).caption == "search · paused")
    }

    @Test func upNextIsTheFirstFewReadyToSendInTheListsOrder() {
        var input = HomeInput()
        #expect(HomeText.upNext(input).isEmpty)
        #expect(HomeText.upNextLine(shown: 0, total: 0) == nil)
        #expect(HomeText.upNextEmpty(input) == "Nothing is ready to send.")
        input.needsYou = 2
        #expect(HomeText.upNextEmpty(input) == "Nothing is ready to send: 2 applications need you first.")
        let jobs = (1...6).map { i in
            ListItem(posting: Posting.with { $0.id = Int64(i); $0.title = "Job \(i)"; $0.company = "Co \(i)"; $0.salaryText = "€\(i)0k"; $0.score = Int32(90 - i) }, application: nil)
        }
        input.upNext = jobs
        input.ready = 80
        let shown = HomeText.upNext(input)
        #expect(shown.map(\.title) == ["Job 1", "Job 2", "Job 3", "Job 4"])
        #expect(shown.first?.subtitle == "Co 1 · €10k")
        #expect(HomeText.upNext(input, limit: 5).count == 5)
        #expect(HomeText.upNextLine(shown: 4, total: 80) == "4 of 80 ready to send")
        #expect(HomeText.upNextLine(shown: 3, total: 3) == "All 3 ready to send")
        #expect(HomeText.upNextLine(shown: 1, total: 1) == "The one ready to send")
    }

    @Test func theFunnelsTileShowsTheFirstStepAndTheLastOnes() {
        let rows = ["found", "verified", "interested", "prepared", "applied", "interview", "offer"].enumerated().map { i, key in
            FunnelRow(id: key, label: key.capitalized, count: Int64(100 - i * 10), conversion: nil)
        }
        #expect(HomeText.funnelSummary(rows).map(\.id) == ["found", "applied", "interview", "offer"])
        #expect(HomeText.funnelSummary(Array(rows.prefix(3))).map(\.id) == ["found", "verified", "interested"])
        #expect(HomeText.funnelSummary([]).isEmpty)
    }

    @Test func theRoundButtonReviewsThenBrowsesThenSearches() {
        var input = HomeInput()
        #expect(HomeText.action(input) == .search)
        input.newMatches = 4
        #expect(HomeText.action(input) == .browse)
        input.needsYou = 1
        #expect(HomeText.action(input) == .review)
        #expect(HomeAction.review.section == .toReview && HomeAction.browse.section == .new)
        #expect(HomeTile.questions.section == .interview && HomeTile.needsYou.section == .toReview)
    }

    @Test func theGridIsThreeColumnsOrFourWithTheFunnelWhenWide() {
        #expect(HomeGrid.columns(width: 900) == 3)
        #expect(HomeGrid.columns(width: 1300) == 4)
        let narrow = HomeGrid.rows(columns: 3)
        #expect(narrow.map(\.count) == [3, 3])
        #expect(narrow.flatMap { $0 } == HomeTile.allCases.map(HomeGrid.Slot.tile))
        let wide = HomeGrid.rows(columns: 4)
        #expect(wide.map { $0.map(HomeGrid.span).reduce(0, +) } == [4, 4])
        #expect(wide.last?.last == .funnel)
        // Every tile once, whatever the width.
        #expect(Set(wide.flatMap { $0 }).count == HomeTile.allCases.count + 1)
        // A column's share of the row, and the funnel's two with the gap between them.
        #expect(HomeGrid.width(.tile(.ready), columns: 4, total: 1042, spacing: 14) == 250)
        #expect(HomeGrid.width(.funnel, columns: 4, total: 1042, spacing: 14) == 514)
        // Compact: tiles 150–170 points tall, so the grid stays under about 360.
        #expect(HomeGrid.tileHeight(window: 600) == 150)
        #expect(HomeGrid.tileHeight(window: 900) == 162)
        #expect(HomeGrid.tileHeight(window: 2000) == 170)
        #expect(HomeGrid.tileHeight(window: 2000) * 2 + 14 <= 360)
    }

    @Test func theRailStepsThroughTheSectionsAndOpensOnHome() {
        #expect(Navigation().section == .overview)
        #expect(Section.overview.railTitle == "Home" && Section.new.railTitle == "New")
        #expect(Section.overview.neighbour(1) == .toReview)
        #expect(Section.toReview.neighbour(-1) == .overview)
        #expect(Section.overview.neighbour(-1) == nil)
        #expect(Section.settings.neighbour(1) == nil)
    }

    @Test func everySectionHasItsColourWorld() {
        for section in Section.allCases {
            let tone = WorldTone.of(section)
            #expect((0...1).contains(tone.hue) && (0...1).contains(tone.secondHue) && tone.saturation > 0, "\(section)")
        }
        // The job and application lists each have their own; the system ones share a quiet one.
        let lists: [Section] = [.toReview, .new, .saved, .skipped, .applied, .interviews, .offers, .whichApplication]
        #expect(Set(lists.map { WorldTone.of($0).hue }).count == lists.count)
        #expect(WorldTone.of(.search) == WorldTone.of(.settings))
        #expect(WorldTone.of(.skipped).saturation < WorldTone.of(.new).saturation)
        // No pink, magenta or violet world: the chrome stays in the blues.
        for section in Section.allCases {
            let tone = WorldTone.of(section)
            #expect(!(0.7...0.97).contains(tone.hue) && !(0.7...0.97).contains(tone.secondHue), "\(section)")
        }
    }

    @Test func homeReadsTheStore() async throws {
        let daemon = FakeDaemon(
            postings: [posting(1, score: 90, title: "Staff Engineer", appId: 11), posting(2, score: 75, title: "Backend"), posting(3, score: 88, title: "Lead", appId: 12)],
            applications: [application(11, posting: 1, stage: .readyForReview), application(12, posting: 3, stage: .preparing)]
        )
        let store = AppStore(connector: FakeConnector([daemon]), backoff: { _ in })
        let run = Task { await store.run() }
        defer { run.cancel() }
        try await eventually("connected") { store.connection == .connected }
        let input = store.homeInput
        #expect(input.ready == 1 && input.needsYou == 0 && input.newMatches == 1)
        #expect(input.preparing.map(\.company) == ["Acme"])
        #expect(input.upNext.map(\.postingId) == [1])
        #expect(HomeText.live(input)?.title == "Writing answers for Acme…")
    }
}
