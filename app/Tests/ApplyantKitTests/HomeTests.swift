// Home: the greeting, the line under it, the tile that lights up while Applyant works and what
// it says, the tiles' numbers, the round button, and the grid making room for the live tile.
// Also the rail's order and every section's colour world.
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
        #expect(HomeText.state(input) == "Waiting for claude limit · resumes 15:45.")
        input.pausedAt = Date()
        #expect(HomeText.state(input).hasPrefix("Paused since "))
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
        #expect(HomeText.figure(.questions, input).done == "All answered")
        input.ready = 0
        #expect(HomeText.figure(.ready, input).done == "All sent")
        input.preparing = [("Kalepa", "")]
        #expect(HomeText.figure(.ready, input).done == nil)
        input.searches = 2
        #expect(HomeText.figure(.search, input).caption == "searches on their schedule")
        input.pausedAt = Date()
        #expect(HomeText.figure(.search, input).caption == "paused")
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

    @Test func theGridMakesRoomForTheLiveTile() {
        let even = Bento.widths([.ready, .needsYou, .new], live: nil, total: 920, spacing: 10)
        #expect(even == [300, 300, 300])
        let grown = Bento.widths([.ready, .needsYou, .new], live: .needsYou, total: 920, spacing: 10)
        #expect(grown == [225, 450, 225])
        #expect(abs(grown.reduce(0, +) - 900) < 0.001)
        // Narrow: the others keep their minimum.
        let narrow = Bento.widths([.ready, .needsYou, .new], live: .ready, total: 520, spacing: 10, minimum: 150)
        #expect(narrow == [200, 150, 150])
        #expect(Bento.heights(live: nil, total: 410, spacing: 10) == [200, 200])
        let tall = Bento.heights(live: .search, total: 410, spacing: 10, share: 0.6)
        #expect(abs(tall[0] - 160) < 0.001 && abs(tall[1] - 240) < 0.001)
        #expect(Bento.rows.flatMap { $0 }.count == HomeTile.allCases.count)
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
        #expect(HomeText.live(input)?.title == "Writing answers for Acme…")
    }
}
