import ApplyantAPI
import Foundation
import Testing
@testable import ApplyantKit

func company(_ id: Int64, _ name: String, flags: [(String, String)] = [], researching: Bool = false, fresh: Bool = true, postings: [Int64] = []) -> Company {
    .with {
        $0.id = id
        $0.name = name
        $0.status = "done"
        $0.fresh = fresh
        $0.researching = researching
        $0.summary = "\(name) sells call analytics to clinics."
        $0.researchedAt = .init(date: Date(timeIntervalSince1970: 1_790_000_000))
        $0.redFlags = flags.map { kind, severity in
            .with {
                $0.kind = kind
                $0.severity = severity
                $0.text = "\(kind) in 2026"
                $0.sources = ["https://www.news.example/acme/layoffs"]
            }
        }
        $0.postings = postings.map { pid in .with { $0.id = pid } }
    }
}

@MainActor
@Suite struct CompaniesTests {
    @Test func aCompanyReadsAsItsStateAndRedFlags() {
        let clean = company(1, "Acme")
        #expect(CompanyText.flags(clean) == "No red flags")
        #expect(CompanyText.chips(clean).map(\.text) == ["No red flags"])
        let flagged = company(2, "Globex", flags: [("layoffs", "high"), ("reviews", "medium")], fresh: false)
        #expect(CompanyText.flags(flagged) == "2 red flags")
        #expect(CompanyText.chips(flagged).map(\.text) == ["2 red flags", "Stale"])
        #expect(CompanyText.state(flagged).hasSuffix("· stale"))
        #expect(CompanyText.flagTitle(flagged.redFlags[1]) == "Employee reviews · medium")
        #expect(CompanyText.sourceLabel("https://www.news.example/acme/layoffs") == "news.example/acme/layoffs")
        var queued = Company.with { $0.id = 3; $0.name = "Initech"; $0.status = "queued"; $0.researching = true }
        #expect(CompanyText.state(queued) == "Researching…")
        #expect(CompanyText.flags(queued) == nil)
        #expect(CompanyText.buttonTitle(nil) == "Company research")
        #expect(CompanyText.buttonTitle(clean) == "Research again")
        queued.researching = false
        queued.status = "failed"
        #expect(CompanyText.chips(queued).map(\.text) == ["Failed"])
        #expect(Section.companies.isBuilt)
        #expect(Score.componentTitles["company"] == "Company")
    }

    @Test func companiesLoadAndFollowResearchEvents() async throws {
        let daemon = FakeDaemon(postings: [posting(1, score: 88, title: "Senior AI Engineer", company: "Acme")])
        daemon.companies = [company(1, "Globex", flags: [("layoffs", "high")], postings: [7])]
        let store = AppStore(connector: FakeConnector([daemon]), backoff: { _ in })
        let run = Task { await store.run() }
        defer { run.cancel() }
        try await eventually("connected") { store.connection == .connected }
        #expect(daemon.calls.contains("listCompanies"))
        #expect(store.companies.map(\.name) == ["Globex"])
        #expect(store.count(.companies) == 0)

        // Company research on a posting: a new company, researching; the Companies badge counts it.
        await store.openPosting(1)
        let started = await store.researchCompany(.posting(1))
        #expect(started?.name == "Acme")
        #expect(started?.researching == true)
        #expect(daemon.calls.contains("researchCompany posting(1) false"))
        #expect(store.companies.map(\.name) == ["Globex", "Acme"])
        #expect(store.count(.companies) == 1)
        #expect(store.postingDetails[1]?.companyResearch.researching == true)

        // The research finishes: the event refreshes the list and what's open on screen.
        await store.openCompany(2)
        daemon.companies[1].researching = false
        daemon.companies[1].status = "done"
        daemon.companies[1].fresh = true
        daemon.companies[1].summary = "Acme builds call analytics."
        daemon.companies[1].sections = [.with { $0.key = "product"; $0.label = "Product"; $0.findings = [.with { $0.text = "Per-seat SaaS"; $0.sources = ["https://acme.example"] }] }]
        daemon.postings[1]?.companyResearch = daemon.companies[1]
        daemon.feed.yield(event(10, .company(.with { $0.companyID = 2; $0.status = "done" })))
        try await eventually("research done") { store.companies.last?.researching == false }
        #expect(store.count(.companies) == 0)
        try await eventually("details") { store.companyDetails[2]?.sections.count == 1 }
        #expect(store.postingDetails[1]?.companyResearch.summary == "Acme builds call analytics.")

        // Fresh: asking again without refresh queues nothing.
        let again = await store.researchCompany(.id(2))
        #expect(again?.researching == false)
        _ = await store.researchCompany(.id(2), refresh: true)
        #expect(daemon.calls.contains("researchCompany id(2) true"))
    }
}
