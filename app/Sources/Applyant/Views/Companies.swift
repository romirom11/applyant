// Companies: one research profile per company, shared by its postings. The list, a company's
// profile (every finding with its sources, red flags in their own block), and the short card
// a posting and the review screen show.
import ApplyantAPI
import ApplyantKit
import SwiftUI

struct CompaniesList: View {
    let store: AppStore

    var body: some View {
        let researching = store.companies.filter(\.researching).count
        VStack(alignment: .leading, spacing: 0) {
            ModuleHeader(section: .companies, subtitle: "\(store.companies.count) researched" + (researching > 0 ? " · \(researching) researching now" : ""))
                .columnHeader()
            if store.companies.isEmpty {
                EmptyState(
                    title: "No company researched yet",
                    systemImage: ApplyantKit.Section.companies.symbol,
                    detail: "Preparing an application researches its company. Company research on a posting does it now.",
                    art: .companies
                )
            } else {
                CardList(
                    selection: Binding(get: { store.navigation.company }, set: { store.navigation.company = $0 }),
                    order: store.companies.map(\.id),
                    tint: Theme.world(.companies).main
                ) {
                    ForEach(store.companies, id: \.id) { c in
                        SelectableCard(id: c.id) {
                            HStack(alignment: .top, spacing: 12) {
                                CompanyAvatar(name: c.name, size: 34)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(c.name).font(.system(size: 13.5, weight: .bold)).foregroundStyle(Theme.text)
                                    Text(CompanyText.state(c) + " · \(c.postings.count) posting\(c.postings.count == 1 ? "" : "s")")
                                        .font(.system(size: 12)).foregroundStyle(Theme.secondaryText)
                                    let chips = CompanyText.chips(c)
                                    if !chips.isEmpty {
                                        HStack(spacing: 4) { ForEach(chips, id: \.text) { ChipView(chip: $0) } }.padding(.top, 2)
                                    }
                                }
                                .shimmer(c.researching)
                            }
                        }
                        .sheen(c.researching, radius: 15)
                    }
                }
            }
        }
        .navigationTitle("Companies")
    }
}

struct CompanyDetail: View {
    let store: AppStore

    var body: some View {
        if let id = store.navigation.company {
            CompanyProfile(store: store, companyId: id).id(id)
        } else {
            EmptyState(
                title: "Companies",
                systemImage: ApplyantKit.Section.companies.symbol,
                detail: "Pick a company on the left: what it does, its red flags, and where each finding comes from.",
                art: .companies
            )
        }
    }
}

struct CompanyProfile: View {
    let store: AppStore
    let companyId: Int64

    var body: some View {
        Group {
            if let c = store.companyDetails[companyId] ?? store.companyListing(companyId) {
                ScrollView {
                    VStack(alignment: .leading, spacing: Theme.blockSpacing) {
                        header(c)
                        if c.hasSummary { SummaryLine(text: c.summary).entrance(1) }
                        if c.hasSummary { RedFlagsBox(flags: c.redFlags).entrance(2) }
                        ForEach(Array(c.sections.enumerated()), id: \.element.key) { index, section in
                            CompanyFindings(section: section).entrance(3 + index)
                        }
                        if c.hasNote {
                            Text(c.note).font(.caption).foregroundStyle(.secondary)
                        }
                        if !c.postings.isEmpty { postings(c).entrance(4 + c.sections.count) }
                    }
                    .padding(Theme.pagePadding)
                    .frame(maxWidth: Theme.readableWidth, alignment: .leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                ProgressView()
            }
        }
        .task(id: companyId) { await store.openCompany(companyId) }
    }

    private func header(_ c: Company) -> some View {
        HStack(alignment: .center, spacing: 14) {
            CompanyAvatar(name: c.name, size: 60).popIn(0)
            VStack(alignment: .leading, spacing: 4) {
                Text(c.name).font(Theme.pageTitle).foregroundStyle(Theme.text)
                HStack(spacing: 8) {
                    Text(CompanyText.state(c)).foregroundStyle(Theme.secondaryText)
                    if c.hasWebsite, let url = URL(string: c.website) { Link(CompanyText.sourceLabel(c.website), destination: url) }
                }
            }
            Spacer()
            if c.researching {
                HStack(spacing: 6) {
                    LiveDot(color: Theme.world(.companies).main, size: 6)
                    Text("Researching…").foregroundStyle(Theme.secondaryText)
                }
                .shimmer()
            } else {
                Button {
                    Task { await store.researchCompany(.id(c.id), refresh: true) }
                } label: {
                    Label(c.hasSummary ? "Research again" : "Research", systemImage: "sparkle.magnifyingglass")
                }
                .buttonStyle(.secondary)
            }
        }
    }

    private func postings(_ c: Company) -> some View {
        Card(title: "Postings", systemImage: "list.bullet.rectangle") {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(c.postings, id: \.id) { p in
                    Button {
                        store.showPosting(p.id)
                    } label: {
                        HStack(spacing: 10) {
                            ScoreRing(score: p.hasScore ? p.score : nil, size: 26)
                            Text(p.hasTitle ? p.title : "Posting \(p.id)").font(.system(size: 13.5, weight: .semibold)).foregroundStyle(Theme.text)
                            Spacer(minLength: 0)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

/// One section of a company's research, every finding with its sources.
struct CompanyFindings: View {
    let section: CompanySection

    var body: some View {
        Card(title: section.label) {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(section.findings.enumerated()), id: \.offset) { _, f in
                    VStack(alignment: .leading, spacing: 2) {
                        Text((f.hasDate ? "\(f.date) · " : "") + f.text).textSelection(.enabled)
                        SourceLinks(urls: f.sources)
                    }
                }
            }
        }
    }
}

struct RedFlagsBox: View {
    let flags: [CompanyRedFlag]

    var body: some View {
        Card(tint: flags.isEmpty ? Theme.good : Theme.warning) {
            VStack(alignment: .leading, spacing: 8) {
                Label(flags.isEmpty ? "No red flags found" : "Red flags", systemImage: flags.isEmpty ? "checkmark.shield.fill" : "exclamationmark.triangle.fill")
                    .font(.headline)
                    .foregroundStyle(flags.isEmpty ? Theme.good : Theme.warning)
                ForEach(Array(flags.enumerated()), id: \.offset) { _, f in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(CompanyText.flagTitle(f)).font(.callout.weight(.semibold))
                        Text(f.text).textSelection(.enabled)
                        SourceLinks(urls: f.sources)
                    }
                }
            }
        }
    }
}

struct SourceLinks: View {
    let urls: [String]

    var body: some View {
        HStack(spacing: 8) {
            ForEach(urls, id: \.self) { u in
                if let url = URL(string: u) {
                    Link(CompanyText.sourceLabel(u), destination: url).font(.caption)
                }
            }
        }
    }
}

/// The short version: the job detail's Company tab, and the review's evidence panel.
struct CompanyCard: View {
    let store: AppStore
    let company: Company?
    /// Set on a posting: the button researches this posting's company.
    var postingId: Int64?
    var compact = false

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline) {
                    CardTitle(title: company.map { "About \($0.name)" } ?? "Company research", systemImage: "building.2")
                    Spacer()
                    if let c = company { Text(CompanyText.state(c)).font(.caption).foregroundStyle(.secondary) }
                }
                if let c = company, c.hasSummary {
                    Text(c.summary).lineLimit(compact ? 5 : nil).textSelection(.enabled)
                    if c.redFlags.isEmpty {
                        Text("No red flags found").font(.caption).foregroundStyle(Theme.good)
                    } else {
                        ForEach(Array(c.redFlags.enumerated()), id: \.offset) { _, f in
                            Text("! \(CompanyText.flagTitle(f)): \(f.text)").font(.caption).foregroundStyle(Theme.warning)
                        }
                    }
                } else if company?.researching == true {
                    Text("Researching the company…").foregroundStyle(.secondary)
                } else if let c = company, c.hasNote {
                    Text(c.note).font(.caption).foregroundStyle(.secondary)
                } else {
                    Text("Not researched yet. Preparing an application researches the company.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                HStack {
                    if let c = company, c.hasSummary {
                        Button("Open in Companies") {
                            store.navigation.section = .companies
                            store.navigation.company = c.id
                            store.navigation.postingId = nil
                            store.navigation.reviewing = nil
                        }
                    }
                    if let postingId, company?.researching != true {
                        Button(CompanyText.buttonTitle(company)) {
                            Task { await store.researchCompany(.posting(postingId), refresh: company?.hasSummary == true) }
                        }
                    }
                    if company?.researching == true { ProgressView().controlSize(.small) }
                }
                .buttonStyle(.secondary)
                .controlSize(compact ? .small : .regular)
                .padding(.top, 2)
            }
        }
    }
}
