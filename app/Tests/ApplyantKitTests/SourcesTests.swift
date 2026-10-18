import ApplyantAPI
import Foundation
import Testing
@testable import ApplyantKit

func kind(_ k: String, _ label: String, enabled: Bool = true) -> Applyant_V1_SearchSourceKind {
    .with { $0.kind = k; $0.label = label; $0.enabled = enabled }
}

/// Every kind of source, as a daemon with the index would list them.
func everySource() -> SearchList {
    .with {
        $0.sources = [
            source("greenhouse:gitlab", "GitLab", kind: "greenhouse", complete: true),
            source("ashby:openai", "OpenAI", kind: "ashby", complete: true),
            source("personio:acme", "Acme", kind: "personio", complete: true),
            source("page:https://acme.com/careers", "Acme careers", kind: "page", complete: false),
            source("board:hn", "Hacker News · Who is hiring", kind: "board", complete: false),
            source("board:ats-index", "Every company on ATS", kind: "board", complete: false),
            source("board:ats-web-search", "Web search · Greenhouse, Ashby and Lever jobs", kind: "board", complete: false, enabled: false),
            source("board:workable-search", "Workable job search · every company", kind: "board", complete: false),
            source("linkedin:jobs", "LinkedIn Jobs", kind: "linkedin", complete: false),
        ]
        $0.kinds = [
            kind("greenhouse", "Greenhouse"), kind("ashby", "Ashby"), kind("lever", "Lever"),
            kind("page", "Career pages and feeds"), kind("board", "Job boards"),
            kind("linkedin", "LinkedIn"), kind("xing", "Xing"), kind("telegram", "Telegram channels"),
        ]
    }
}

func atsEntry(_ ats: String, companies: Int32, hiring: Int32, jobs: Int32, matching: Int32, due: Int32 = 0, failing: Int32 = 0, enabled: Bool = true) -> AtsIndexAts {
    .with {
        $0.ats = ats
        $0.label = SourcesText.kindTitle(ats)
        $0.enabled = enabled
        $0.companies = companies
        $0.hiring = hiring
        $0.jobs = jobs
        $0.matching = matching
        $0.due = due
        $0.failing = failing
    }
}

func index() -> AtsIndex {
    .with {
        $0.enabled = true
        $0.ats = [
            atsEntry("greenhouse", companies: 3204, hiring: 2100, jobs: 41_250, matching: 64, due: 120, failing: 3),
            atsEntry("lever", companies: 1, hiring: 1, jobs: 1, matching: 0, enabled: false),
        ]
        $0.companies = 3205
        $0.jobs = 41_251
        $0.matching = 64
        $0.discoveries = [.with { $0.id = 2; $0.trigger = "schedule"; $0.status = "done"; $0.found = 1200; $0.added = 34 }]
    }
}

func indexCompany(_ id: Int64, _ token: String, ats: String = "greenhouse", status: String = "hiring", jobs: Int32 = 12, matching: Int32 = 3, name: String? = nil) -> IndexCompany {
    .with {
        $0.id = id
        $0.ats = ats
        $0.token = token
        if let name { $0.name = name }
        $0.enabled = true
        $0.status = status
        $0.jobs = jobs
        $0.matching = matching
        $0.foundVia = "common-crawl"
        $0.boardURL = "https://boards.greenhouse.io/\(token)"
    }
}

@MainActor
@Suite struct SourcesTests {
    @Test func everySourceSitsInItsGroupInTheScreensOrder() {
        let groups = SourcesText.groups(everySource())
        // The index's group is drawn from GetAtsIndex; the rest follow in order. No Career page
        // group without pages… here there is one; Telegram stays with no channel followed.
        #expect(groups.map(\.id) == [.acrossCompanies, .watched, .pages, .boards, .telegram, .platforms])
        #expect(groups.map(\.title) == ["Searches across companies", "Watched companies", "Career pages and feeds", "Job boards", "Telegram", "LinkedIn and Xing"])
        // The searches across companies in their own order, without a kind switch.
        #expect(groups[0].rows.map(\.title) == ["Workable job search · every company", "Web search · Greenhouse, Ashby and Lever jobs"])
        #expect(groups[0].blocks.first?.kind == nil)
        // Watched: every ATS kind with sources (a new one, Personio, too), each under its switch;
        // Lever has none and is left out.
        #expect(groups[1].blocks.map(\.title) == ["Greenhouse", "Ashby", "Personio"])
        #expect(groups[1].blocks.map { $0.kind?.kind } == ["greenhouse", "ashby", "personio"])
        // Job boards leave out the index and the searches across companies.
        #expect(groups[3].rows.map(\.title) == ["Hacker News · Who is hiring"])
        #expect(groups[3].blocks.first?.kind?.kind == "board")
        #expect(groups[4].rows.isEmpty && groups[4].blocks.first?.kind?.kind == "telegram")
        #expect(groups[5].blocks.map(\.title) == ["LinkedIn"])
        #expect(SourcesText.onLine(everySource()) == "8 of 9 sources on")
        #expect(SourcesText.onLine(SearchList()) == "0 of 0 sources on")
    }

    @Test func anEmptyListStillOffersWatchingAndTelegram() {
        let groups = SourcesText.groups(SearchList())
        #expect(groups.map(\.id) == [.watched, .telegram])
        #expect(groups[0].rows.isEmpty)
    }

    @Test func newATSKindsHaveTitles() {
        for (kind, title) in [("personio", "Personio"), ("recruitee", "Recruitee"), ("teamtailor", "Teamtailor"), ("join", "JOIN"), ("breezy", "Breezy HR")] {
            #expect(SourcesText.kindTitle(kind) == title)
            #expect(SourcesText.isAts(kind))
        }
        #expect(SourcesText.kindTitle("workday", label: "Workday") == "Workday")
        #expect(SourcesText.kindTitle("rippling") == "Rippling")
        #expect(!SourcesText.isAts("board") && !SourcesText.isAts("page") && !SourcesText.isAts("telegram"))
        #expect(Source.ats("https://join.com/companies/acme/123") == "JOIN")
        #expect(Source.ats("https://acme.breezy.hr/p/123") == "Breezy HR")
        #expect(Section.sources.title == "Sources" && Section.sources.group == .system)
        #expect(Section.search.neighbour(1) == .sources)
    }

    @Test func theIndexReadsInCountsAndChips() {
        let i = index()
        #expect(SourcesText.indexLine(i) == "3,205 companies · 41,251 open jobs · 64 matching")
        #expect(SourcesText.indexLine(AtsIndex()) == "No companies yet")
        #expect(SourcesText.indexTotals(i).map(\.label) == ["Companies", "Open jobs", "Matching your searches", "Due to read", "Failing"])
        #expect(SourcesText.indexTotals(i).map(\.value) == ["3,205", "41,251", "64", "120", "3"])
        let rows = i.ats.map(SourcesText.atsRow)
        #expect(rows[0].title == "Greenhouse")
        #expect(rows[0].subtitle == "3,204 companies · 2,100 hiring · 41,250 jobs · 64 matching")
        #expect(rows[0].chips.map(\.text) == ["120 due", "3 failing"])
        #expect(rows[1].subtitle == "1 company · 1 hiring · 1 job · 0 matching")
        // Off says so; what's due waits for it to be on.
        #expect(rows[1].chips.map(\.text) == ["Off"] && !rows[1].on)
        #expect(rows[0].lastReadAt == nil)
        // The master switch: the index says, else the index's own source.
        #expect(SourcesText.indexOn(i, list: SearchList()))
        #expect(SourcesText.indexOn(nil, list: everySource()))
        #expect(!SourcesText.indexOn(nil, list: SearchList()))
        // Only its own switch: "Job boards" off leaves the index on.
        var boardsOff = everySource()
        for i in boardsOff.sources.indices where boardsOff.sources[i].kind == "board" { boardsOff.sources[i].kindEnabled = false }
        #expect(SourcesText.indexOn(nil, list: boardsOff))
    }

    @Test func discoveryRunsReadInOneLine() {
        var d = AtsIndexDiscovery.with { $0.trigger = "schedule"; $0.status = "done"; $0.found = 1200; $0.added = 34 }
        #expect(SourcesText.discoveryLine(d) == "Last discovery (weekly) · 1,200 boards found, 34 new")
        d.trigger = "manual"
        d.found = 0
        #expect(SourcesText.discoveryLine(d) == "Last discovery (by you) · nothing found")
        d.status = "queued"
        #expect(SourcesText.discoveryLine(d) == "Looking for more companies…")
        d.status = "failed"
        #expect(SourcesText.discoveryLine(d) == "The last discovery failed")
        #expect(!SourcesText.discovering(index()) && !SourcesText.discovering(nil))
        // A run the daemon reads as failed (its task gone) doesn't hold Find More Companies.
        var i = index()
        i.discoveries = [.with { $0.status = "queued" }]
        #expect(SourcesText.discovering(i))
        i.discoveries = [.with { $0.status = "failed"; $0.note = "stopped: its task failed or was lost (the next discovery starts again)" }]
        #expect(!SourcesText.discovering(i))
        #expect(SourcesText.indexUnavailable("this needs a newer Applyant (its background service is older than the app)").hasPrefix("Applyant's background service is older than the app"))
        #expect(SourcesText.indexUnavailable("disk full") == "Applyant's background service couldn't give it: disk full. The sources on the left read as before.")
        // A built-in board off by default says why under its name.
        var web = source("board:ats-web-search", "Web search", kind: "board", complete: false, enabled: false)
        web.stats = stats(0, 0, 0)
        #expect(SearchText.sourceRow(web).subtitle == "board:ats-web-search")
        web.lastNote = "off by default: it reads Brave's result pages"
        #expect(SearchText.sourceRow(web).subtitle == "off by default: it reads Brave's result pages")
    }

    @Test func aCompanySaysItsStatusCountsAndHowItWasFound() {
        let c = indexCompany(1, "gitlab", name: "GitLab")
        #expect(SourcesText.companyTitle(c) == "GitLab")
        #expect(SourcesText.companyTitle(indexCompany(2, "acme")) == "acme")
        #expect(SourcesText.companyLine(c) == "Greenhouse · 12 jobs · 3 matching")
        #expect(SourcesText.companyLine(c, showsAts: false) == "12 jobs · 3 matching")
        #expect(SourcesText.companyLine(indexCompany(3, "quiet", status: "empty", jobs: 0, matching: 0), showsAts: false) == "quiet")
        #expect(SourcesText.companyChips(c).map(\.text) == ["Hiring"])
        var off = indexCompany(4, "gone", status: "gone", jobs: 0, matching: 0)
        off.enabled = false
        #expect(SourcesText.companyChips(off).map(\.text) == ["Off", "Gone"])
        #expect(SourcesText.statusChip(indexCompany(5, "x", status: "failing")).tone == .warning)
        #expect(SourcesText.statusChip(indexCompany(5, "x", status: "new")).text == "Not read yet")
        #expect(SourcesText.foundVia("common-crawl") == "found in Common Crawl")
        #expect(SourcesText.foundVia("candidate") == "added by you")
        #expect(SourcesText.foundVia("") == "")
    }

    @Test func companiesComeAHundredAtATime() {
        let filter = IndexCompanyFilter(ats: "greenhouse", query: "  git ", matchingOnly: true)
        #expect(filter.request.ats == "greenhouse" && filter.request.query == "git" && filter.request.matchingOnly)
        #expect(filter.request.limit == 100 && filter.request.offset == 0)
        #expect(!IndexCompanyFilter().request.hasAts)

        let companies = (1...100).map { indexCompany(Int64($0), "c\($0)") }
        let first = IndexCompanyPage(filter: IndexCompanyFilter(), companies: companies, total: 4210)
        #expect(first.line == "1–100 of 4,210")
        #expect(first.previous == nil)
        #expect(first.next?.offset == 100)
        var lastFilter = IndexCompanyFilter()
        lastFilter.offset = 4200
        let last = IndexCompanyPage(filter: lastFilter, companies: Array(companies.prefix(10)), total: 4210)
        #expect(last.line == "4,201–4,210 of 4,210")
        #expect(last.next == nil && last.previous?.offset == 4100)
        #expect(IndexCompanyPage(filter: IndexCompanyFilter(), companies: [], total: 0).line == "No companies")
        #expect(lastFilter.firstPage.offset == 0)
    }

    @Test func theIndexThroughTheDaemon() async throws {
        let daemon = FakeDaemon()
        daemon.searchList = everySource()
        daemon.atsIndexResponse = index()
        daemon.indexCompanyList = [indexCompany(1, "gitlab"), indexCompany(2, "quiet", status: "empty", jobs: 0, matching: 0), indexCompany(3, "lever-co", ats: "lever")]
        let store = AppStore(connector: FakeConnector([daemon]), backoff: { _ in })
        let run = Task { await store.run() }
        defer { run.cancel() }
        try await eventually("connected") { store.connection == .connected }
        // The index loads with Sources, not before.
        #expect(store.atsIndex == nil && !daemon.calls.contains("atsIndex"))
        await store.openSources()
        #expect(store.atsIndex?.companies == 3205 && store.atsIndexProblem == nil)

        await store.loadIndexCompanies(IndexCompanyFilter(ats: "greenhouse", matchingOnly: true))
        #expect(daemon.calls.contains("listIndexCompanies greenhouse '' true 0"))
        #expect(store.indexCompanies?.companies.map(\.token) == ["gitlab"])
        #expect(store.indexCompanies?.line == "1–1 of 1")

        // One company left out: its row follows, and the index's counts are asked again.
        let asked = daemon.calls.filter { $0 == "atsIndex" }.count
        await store.setIndexCompany(1, enabled: false)
        #expect(daemon.calls.contains("setIndexCompany 1 false"))
        #expect(store.indexCompanies?.companies.first?.enabled == false)
        #expect(daemon.calls.filter { $0 == "atsIndex" }.count == asked + 1)

        // An ATS's kind switch takes it out of the index; the master switch is the index's source.
        await store.setSource("greenhouse", enabled: false)
        #expect(store.atsIndex?.ats.first?.enabled == false)
        await store.setSource(SourcesText.indexKey, enabled: false)
        #expect(store.atsIndex?.enabled == false)

        // Find More Companies: once; again while it runs does nothing. Sources has a badge then.
        #expect(await store.discoverIndexCompanies())
        #expect(SourcesText.discovering(store.atsIndex))
        #expect(store.count(.sources) == 1)
        #expect(await store.discoverIndexCompanies() == false)
        #expect(store.lastError == nil)
    }

    @Test func anOlderDaemonLeavesTheIndexEmptyWithoutAnAlert() async throws {
        let daemon = FakeDaemon()
        daemon.searchList = everySource()
        let store = AppStore(connector: FakeConnector([daemon]), backoff: { _ in })
        let run = Task { await store.run() }
        defer { run.cancel() }
        try await eventually("connected") { store.connection == .connected }
        await store.openSources()
        #expect(store.atsIndex == nil)
        #expect(store.atsIndexProblem?.contains("newer Applyant") == true)
        await store.loadIndexCompanies(IndexCompanyFilter())
        #expect(store.indexCompanies == nil && store.indexCompaniesProblem != nil)
        #expect(store.lastError == nil)
        #expect(store.count(.sources) == 0)
        // The sources themselves read as before.
        #expect(SourcesText.groups(store.search).count == 6)
    }
}
