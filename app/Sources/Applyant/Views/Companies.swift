// Companies: one research profile per company, shared by its postings. The list, a company's
// profile (every finding with its sources, red flags in their own block), and the short card
// a posting and the review screen show.
import ApplyantAPI
import ApplyantKit
import SwiftUI

struct CompaniesList: View {
    let store: AppStore

    var body: some View {
        Group {
            if store.companies.isEmpty {
                ContentUnavailableView(
                    "No company researched yet",
                    systemImage: ApplyantKit.Section.companies.symbol,
                    description: Text("Preparing an application researches its company. Company research on a posting does it now.")
                )
            } else {
                List(store.companies, id: \.id, selection: Binding(
                    get: { store.navigation.company },
                    set: { store.navigation.company = $0 }
                )) { c in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(c.name).font(.headline)
                        Text(CompanyText.state(c) + " · \(c.postings.count) posting\(c.postings.count == 1 ? "" : "s")")
                            .font(.subheadline).foregroundStyle(.secondary)
                        let chips = CompanyText.chips(c)
                        if !chips.isEmpty {
                            HStack(spacing: 4) { ForEach(chips, id: \.text) { ChipView(chip: $0) } }
                        }
                    }
                    .padding(.vertical, 3)
                    .tag(c.id)
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
            ContentUnavailableView(
                "Companies",
                systemImage: ApplyantKit.Section.companies.symbol,
                description: Text("Pick a company on the left: what it does, its red flags, and where each finding comes from.")
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
                    VStack(alignment: .leading, spacing: 16) {
                        header(c)
                        if c.hasSummary { Text(c.summary).textSelection(.enabled) }
                        if c.hasSummary { RedFlagsBox(flags: c.redFlags) }
                        ForEach(c.sections, id: \.key) { section($0) }
                        if c.hasNote {
                            Text(c.note).font(.caption).foregroundStyle(.secondary)
                        }
                        if !c.postings.isEmpty { postings(c) }
                    }
                    .padding(20)
                    .frame(maxWidth: 820, alignment: .leading)
                }
            } else {
                ProgressView()
            }
        }
        .task(id: companyId) { await store.openCompany(companyId) }
    }

    private func header(_ c: Company) -> some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 4) {
                Text(c.name).font(.title2.weight(.semibold))
                HStack(spacing: 8) {
                    Text(CompanyText.state(c)).foregroundStyle(.secondary)
                    if c.hasWebsite, let url = URL(string: c.website) { Link(CompanyText.sourceLabel(c.website), destination: url) }
                }
            }
            Spacer()
            if c.researching {
                ProgressView().controlSize(.small)
            } else {
                Button(c.hasSummary ? "Research again" : "Research") {
                    Task { await store.researchCompany(.id(c.id), refresh: true) }
                }
            }
        }
    }

    private func section(_ s: CompanySection) -> some View {
        GroupBox(s.label) {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(s.findings.enumerated()), id: \.offset) { _, f in
                    VStack(alignment: .leading, spacing: 2) {
                        Text((f.hasDate ? "\(f.date) · " : "") + f.text).textSelection(.enabled)
                        SourceLinks(urls: f.sources)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(6)
        }
    }

    private func postings(_ c: Company) -> some View {
        GroupBox("Postings") {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(c.postings, id: \.id) { p in
                    Button {
                        store.navigation.section = .inbox
                        store.navigation.postingId = p.id
                        store.navigation.reviewing = nil
                    } label: {
                        HStack {
                            Text(p.hasScore ? "\(p.score)" : "–").monospacedDigit().frame(width: 30, alignment: .leading)
                            Text(p.hasTitle ? p.title : "Posting \(p.id)")
                        }
                    }
                    .buttonStyle(.link)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(6)
        }
    }
}

struct RedFlagsBox: View {
    let flags: [CompanyRedFlag]

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                Label(flags.isEmpty ? "No red flags found" : "Red flags", systemImage: flags.isEmpty ? "checkmark.shield" : "exclamationmark.triangle")
                    .font(.headline)
                    .foregroundStyle(flags.isEmpty ? .green : .orange)
                ForEach(Array(flags.enumerated()), id: \.offset) { _, f in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(CompanyText.flagTitle(f)).font(.callout.weight(.semibold))
                        Text(f.text).textSelection(.enabled)
                        SourceLinks(urls: f.sources)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(6)
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

/// The short version: on a posting (with Company research) and in review's evidence panel.
struct CompanyCard: View {
    let store: AppStore
    let company: Company?
    /// Set on a posting: the button researches this posting's company.
    var postingId: Int64?
    var compact = false

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline) {
                    Text(company.map { "About \($0.name)" } ?? "Company research").font(.headline)
                    Spacer()
                    if let c = company { Text(CompanyText.state(c)).font(.caption).foregroundStyle(.secondary) }
                }
                if let c = company, c.hasSummary {
                    Text(c.summary).lineLimit(compact ? 5 : nil).textSelection(.enabled)
                    if c.redFlags.isEmpty {
                        Text("No red flags found").font(.caption).foregroundStyle(.green)
                    } else {
                        ForEach(Array(c.redFlags.enumerated()), id: \.offset) { _, f in
                            Text("! \(CompanyText.flagTitle(f)): \(f.text)").font(.caption).foregroundStyle(.orange)
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
                .controlSize(compact ? .small : .regular)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(6)
        }
    }
}
