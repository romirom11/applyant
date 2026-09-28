import ApplyantAPI
import Foundation
import Testing
@testable import ApplyantKit

func stats(_ found: Int32, _ verified: Int32, _ interested: Int32) -> Applyant_V1_SearchStats {
    .with {
        $0.found = found
        $0.verified = verified
        $0.interested = interested
    }
}

func strategy(_ id: Int64, _ name: String, state: String = "active", running: Bool = false, keys: [String] = ["board:hn"]) -> SearchStrategy {
    .with {
        $0.id = id
        $0.name = name
        $0.state = state
        $0.origin = "candidate"
        $0.everyMinutes = 360
        $0.running = running
        $0.sources = ["board"]
        $0.sourceKeys = keys
        $0.stats = stats(38, 29, 12)
    }
}

func source(_ key: String, _ label: String, kind: String, complete: Bool, enabled: Bool = true) -> SearchSource {
    .with {
        $0.key = key
        $0.kind = kind
        $0.label = label
        $0.enabled = enabled
        $0.kindEnabled = true
        $0.completeList = complete
        $0.stats = stats(5, 4, 0)
    }
}

func searchList() -> SearchList {
    .with {
        $0.strategies = [
            strategy(1, "AI / ML · Remote EU"),
            strategy(2, "Greece / Cyprus", state: "paused"),
        ]
        $0.sources = [
            source("greenhouse:gitlab", "GitLab", kind: "greenhouse", complete: true),
            source("board:hn", "Hacker News · Who is hiring", kind: "board", complete: false),
            source("board:remoteok", "RemoteOK", kind: "board", complete: false, enabled: false),
        ]
        $0.kinds = [
            .with { $0.kind = "greenhouse"; $0.label = "Greenhouse"; $0.enabled = true; $0.sources = 1 },
            .with { $0.kind = "lever"; $0.label = "Lever"; $0.enabled = true; $0.sources = 0 },
            .with { $0.kind = "board"; $0.label = "Job boards"; $0.enabled = true; $0.sources = 2 },
        ]
    }
}

@MainActor
@Suite struct SearchTests {
    @Test func strategiesAndSourcesReadAsThePRDsTable() {
        let list = searchList()
        let rows = SearchText.strategyRows(list)
        #expect(rows.map(\.title) == ["AI / ML · Remote EU", "Greece / Cyprus"])
        #expect(rows[0].subtitle == "38 found · 29 verified · 12 interested (41%)")
        #expect(rows[0].chips.map(\.text) == ["Every 6 h"])
        #expect(rows[1].chips.map(\.text) == ["Paused"])
        #expect(!rows[1].on)
        // Kinds with no sources are left out; each source says whether its list is complete.
        let groups = SearchText.sourceGroups(list)
        #expect(groups.map(\.kind.kind) == ["greenhouse", "board"])
        #expect(groups[1].rows.map { $0.chips.map(\.text) } == [["Latest jobs"], ["Off", "Latest jobs"]])
        #expect(groups[0].rows[0].chips.map(\.text) == ["Complete list"])
        #expect(SearchText.every(90) == "90 min")
        #expect(SearchText.every(1440) == "1 day")
        #expect(Section.search.isBuilt && Section.agentRuns.isBuilt)
    }

    @Test func runsSayWhatEachSourceGave() {
        let ok = Applyant_V1_SearchRunSource.with {
            $0.sourceKey = "greenhouse:gitlab"
            $0.listed = 198
            $0.matched = 4
            $0.added = 1
            $0.attached = 3
            $0.complete = true
            $0.closed = 2
        }
        #expect(SearchText.runSource(ok) == "198 listed · 4 matched · 1 new · 3 already known · complete list · 2 closed")
        let failed = Applyant_V1_SearchRunSource.with { $0.error = "HTTP 500 from …" }
        #expect(SearchText.runSource(failed) == "Failed: HTTP 500 from …")
        let run = SearchRun.with { $0.trigger = "wake"; $0.status = "done"; $0.added = 3 }
        #expect(SearchText.runChips(run).map(\.text) == ["3 new", "After wake"])
        #expect(SearchText.trigger("wake") == "missed while the Mac slept")
    }

    @Test func pauseRunAndSwitchSourcesThroughTheDaemon() async throws {
        let daemon = FakeDaemon()
        daemon.searchList = searchList()
        let store = AppStore(connector: FakeConnector([daemon]), backoff: { _ in })
        let run = Task { await store.run() }
        defer { run.cancel() }
        try await eventually("connected") { store.connection == .connected }
        #expect(store.search.strategies.count == 2)
        #expect(daemon.calls.contains("listSearch") && daemon.calls.contains("listSearchRuns"))

        await store.setStrategy(2, paused: false)
        #expect(daemon.calls.contains("setStrategy 2 active"))
        #expect(store.strategy(2)?.state == "active")

        let started = await store.runStrategy(1)
        #expect(started == 101)
        #expect(store.strategy(1)?.running == true)
        #expect(store.count(.search) == 1)
        #expect(store.runs(of: 1).map(\.id) == [101])
        // Already going: nothing new.
        #expect(await store.runStrategy(1) == nil)

        await store.setSource("board:hn", enabled: false)
        #expect(store.source("board:hn")?.enabled == false)
        await store.setSource("greenhouse", enabled: false)
        #expect(store.source("greenhouse:gitlab")?.kindEnabled == false)
        #expect(SearchText.sourceRow(try #require(store.source("greenhouse:gitlab"))).chips.first?.text == "Off (Greenhouse)")
    }

    @Test func searchEventsRefreshAndAnOpenRunFollowsItsEvents() async throws {
        let daemon = FakeDaemon()
        daemon.searchList = searchList()
        daemon.searchRuns = [.with { $0.id = 7; $0.strategyID = 1; $0.status = "queued"; $0.strategyName = "AI / ML · Remote EU" }]
        daemon.eventsByRun[7] = [event(10, .search(.with { $0.runID = 7; $0.strategyID = 1; $0.status = "queued" }))]
        let store = AppStore(connector: FakeConnector([daemon]), backoff: { _ in })
        let run = Task { await store.run() }
        defer { run.cancel() }
        try await eventually("connected") { store.connection == .connected }
        await store.openRun(7)
        #expect(store.runEvents[7]?.count == 1)
        #expect(SearchText.eventLine(try #require(store.runEvents[7]?.first)) == "search queued")

        // The run finds a posting and finishes: its events arrive with its run id.
        var found = event(11, .posting(.with { $0.postingID = 3; $0.stage = .found }))
        found.runID = 7
        daemon.eventsByRun[7]?.append(found)
        daemon.postings[3] = posting(3, score: 0, title: "Senior AI Engineer")
        daemon.feed.yield(found)
        try await eventually("run events") { store.runEvents[7]?.count == 2 }
        #expect(SearchText.eventLine(try #require(store.runEvents[7]?.last)) == "posting 3 → found")

        daemon.searchRuns[0].status = "done"
        daemon.searchRuns[0].added = 1
        daemon.searchList.strategies[0].stats = stats(39, 29, 12)
        var done = event(12, .search(.with { $0.runID = 7; $0.strategyID = 1; $0.status = "done" }))
        done.runID = 7
        daemon.feed.yield(done)
        try await eventually("search refreshed") { store.searchRuns.first?.status == "done" }
        #expect(store.strategy(1)?.stats.found == 39)
    }
}
