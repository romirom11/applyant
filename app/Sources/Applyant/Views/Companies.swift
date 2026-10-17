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
                                    Text(c.name).textRole(.rowTitle).lineLimit(1)
                                    Text(CompanyText.state(c) + " · \(c.postings.count) posting\(c.postings.count == 1 ? "" : "s")")
                                        .textRole(.meta).lineLimit(1)
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
                let facts = CompanyText.keyFacts(c)
                ScrollView {
                    VStack(alignment: .leading, spacing: Theme.blockSpacing) {
                        header(c)
                        if c.hasSummary { Lead(c.summary).entrance(1) }
                        if !facts.isEmpty {
                            StatStrip(facts.map { StatStrip.Item(label: $0.label, value: $0.value, help: $0.full) }).entrance(1)
                        }
                        if !c.redFlags.isEmpty { RedFlagsList(flags: c.redFlags).entrance(2) }
                        ForEach(Array(c.sections.enumerated()), id: \.element.key) { index, section in
                            CompanyFindings(section: section).entrance(3 + index)
                        }
                        if c.hasNote {
                            Text(c.note).textRole(.body, color: Theme.secondaryText).fixedSize(horizontal: false, vertical: true)
                        }
                        if !c.postings.isEmpty { postings(c).entrance(4 + c.sections.count) }
                    }
                    .pageColumn()
                }
            } else {
                ProgressView()
            }
        }
        .task(id: companyId) { await store.openCompany(companyId) }
    }

    private func header(_ c: Company) -> some View {
        HStack(alignment: .center, spacing: 14) {
            CompanyAvatar(name: c.name, size: 56).popIn(0)
            VStack(alignment: .leading, spacing: 4) {
                Text(c.name).textRole(.title)
                HStack(spacing: 8) {
                    Text(CompanyText.state(c)).textRole(.meta)
                    if c.hasWebsite, let url = URL(string: c.website) {
                        Link(CompanyText.sourceLabel(c.website), destination: url).font(.system(size: 12)).foregroundStyle(Theme.accent)
                    }
                    // Nothing found is worth saying, quietly: a chip, not a card.
                    if c.hasSummary && c.redFlags.isEmpty && !c.researching {
                        ChipView(chip: Chip(text: "No red flags", tone: .good), help: "The research found nothing worrying")
                    }
                }
            }
            Spacer()
            if c.researching {
                HStack(spacing: 6) {
                    LiveDot(color: Theme.world(.companies).main, size: 6)
                    Text("Researching…").textRole(.meta)
                }
                .shimmer()
            } else {
                Button {
                    Task { await store.researchCompany(.id(c.id), refresh: true) }
                } label: {
                    Label(c.hasSummary ? "Research Again" : "Research", systemImage: "sparkle.magnifyingglass")
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
                            Text(p.hasTitle ? p.title : "Posting \(p.id)").textRole(.itemTitle)
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

/// One section of a company's research: each finding a claim, its date over it and its sources
/// in the margin.
struct CompanyFindings: View {
    let section: CompanySection

    var body: some View {
        Card(title: section.label) {
            VStack(alignment: .leading, spacing: Theme.rowSpacing + 4) {
                ForEach(Array(section.findings.enumerated()), id: \.offset) { _, f in
                    FindingRow(finding: f)
                }
            }
        }
    }
}

private struct FindingRow: View {
    let finding: Applyant_V1_CompanyFinding
    @State private var open = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let eyebrow = finding.hasDate ? CompanyText.eyebrow(date: finding.date) : nil
        if let margin = CompanyText.sourcesLabel(finding.sources.count) {
            EvidenceRow(
                finding.text,
                eyebrow: eyebrow,
                margin: margin,
                isExpanded: $open.animation(Theme.Motion.pick(Theme.Motion.disclose, reduceMotion: reduceMotion))
            ) {
                SourceLinks(urls: finding.sources)
            }
        } else {
            EvidenceRow(finding.text, eyebrow: eyebrow)
        }
    }
}

/// The red flags, each the one way a condition is stated: what kind, what was found, how bad,
/// and where it was read.
struct RedFlagsList: View {
    let flags: [CompanyRedFlag]

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.rowSpacing) {
            ForEach(Array(flags.enumerated()), id: \.offset) { _, f in
                RedFlagCallout(flag: f)
            }
        }
    }
}

struct RedFlagCallout: View {
    let flag: CompanyRedFlag
    @Environment(\.openURL) private var openURL

    var body: some View {
        Callout(.warning, title: CompanyText.flagKind(flag), detail: flag.text, systemImage: "exclamationmark.triangle.fill") {
            HStack(spacing: 8) {
                ChipView(chip: CompanyText.severityChip(flag), help: "How serious the research thinks it is")
                if let label = CompanyText.sourcesLabel(flag.sources.count) {
                    Menu(label) {
                        ForEach(flag.sources, id: \.self) { u in
                            if let url = URL(string: u) {
                                Button(CompanyText.sourceLabel(u)) { openURL(url) }
                            }
                        }
                    }
                    .menuStyle(.button)
                    .buttonStyle(.secondary)
                    .controlSize(.small)
                    .fixedSize()
                    .help("Where it was read")
                }
            }
        }
    }
}

/// A finding's sources, as short links.
struct SourceLinks: View {
    let urls: [String]

    var body: some View {
        FlowRow(spacing: 10) {
            ForEach(urls, id: \.self) { u in
                if let url = URL(string: u) {
                    Link(CompanyText.sourceLabel(u) + " ↗", destination: url)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.accent)
                        .help(u)
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
            VStack(alignment: .leading, spacing: Theme.rowSpacing + 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    CardTitle(title: company.map { "About \($0.name)" } ?? "Company research", systemImage: "building.2")
                    Spacer(minLength: 0)
                    if let c = company, c.hasSummary, c.redFlags.isEmpty, !c.researching {
                        ChipView(chip: Chip(text: "No red flags", tone: .good), help: "The research found nothing worrying")
                    }
                    if let c = company { Text(CompanyText.state(c)).textRole(.meta).lineLimit(1) }
                }
                if let c = company, c.hasSummary {
                    Prose(c.summary, size: compact ? .compact : .regular, collapsedLines: 4)
                    if !c.redFlags.isEmpty { RedFlagsList(flags: c.redFlags) }
                } else if company?.researching == true {
                    Text("Researching the company…").textRole(.body, color: Theme.secondaryText)
                } else if let c = company, c.hasNote {
                    Text(c.note).textRole(.body, color: Theme.secondaryText).fixedSize(horizontal: false, vertical: true)
                } else {
                    Text("Not researched yet. Preparing an application researches the company.")
                        .textRole(.body, color: Theme.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                }
                FlowRow(spacing: 8) {
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
