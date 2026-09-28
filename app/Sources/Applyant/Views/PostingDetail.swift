// The selected posting: why it scored what it did, and the next step.
import ApplyantAPI
import ApplyantKit
import SwiftUI

struct PostingDetail: View {
    let store: AppStore
    let postingId: Int64
    @State private var skipping = false
    @State private var skipReason = ""

    var body: some View {
        Group {
            if let p = store.postingDetails[postingId] {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        header(p)
                        actions(p)
                        if !p.breakdown.isEmpty { breakdown(p) }
                        if !p.requirements.isEmpty { requirements(p) }
                        issues(p)
                        facts(p)
                    }
                    .padding(20)
                    .frame(maxWidth: 820, alignment: .leading)
                }
            } else {
                ProgressView()
            }
        }
        .task(id: postingId) { await store.openPosting(postingId) }
        .sheet(isPresented: $skipping) { skipSheet }
    }

    private func header(_ p: Posting) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(p.hasTitle ? p.title : p.canonicalURL).font(.title2.weight(.semibold))
            Text(subtitle(p)).foregroundStyle(.secondary)
            if p.hasSummary { Text(p.summary).padding(.top, 4) }
        }
    }

    private func subtitle(_ p: Posting) -> String {
        var parts: [String] = []
        if p.hasCompany { parts.append(p.company) }
        if p.hasSalaryText { parts.append(p.salaryText) }
        parts.append("found " + p.firstSeenAt.date.formatted(.relative(presentation: .named)))
        if p.formStatus == "verified" { parts.append("✓ apply form verified") }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder
    private func actions(_ p: Posting) -> some View {
        HStack(spacing: 8) {
            if p.hasApplicationID {
                Button("Review application") {
                    store.navigation.reviewing = p.applicationID
                }
                .buttonStyle(.borderedProminent)
            } else if p.stage == .scored {
                Button("Prepare application") {
                    Task {
                        if let app = await store.prepare(posting: p.id) { store.navigation.reviewing = app }
                    }
                }
                .buttonStyle(.borderedProminent)
            }
            if p.decision != "interested" {
                Button("Interested") { Task { await store.markInterested(posting: p.id) } }
            }
            if p.stage != .skipped {
                Button("Skip…") { skipping = true }
            }
            if let url = URL(string: p.canonicalURL) {
                Link("Open posting ↗", destination: url)
            }
        }
    }

    private func breakdown(_ p: Posting) -> some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline) {
                    Text("Score").font(.headline)
                    Spacer()
                    Text(p.hasScore ? "\(p.score)" : "–").font(.system(size: 28, weight: .semibold, design: .rounded))
                }
                ForEach(p.breakdown.filter { $0.weight > 0 || $0.uncertain }, id: \.key) { c in
                    let points = Score.points(c)
                    HStack(alignment: .firstTextBaseline) {
                        Text(Score.componentTitles[c.key] ?? c.key).frame(width: 150, alignment: .leading)
                        ProgressView(value: c.value).frame(width: 120)
                        Text(c.uncertain ? "?" : "\(points.earned)/\(points.of)").monospacedDigit().frame(width: 50)
                        if c.hasNote { Text(c.note).foregroundStyle(.secondary).font(.callout) }
                    }
                }
            }
            .padding(6)
        }
    }

    private func requirements(_ p: Posting) -> some View {
        GroupBox("Requirements") {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(p.requirements.enumerated()), id: \.offset) { _, r in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(Score.verdictMark(r.verdict))
                            .foregroundStyle(r.verdict == "strong" ? .green : r.verdict == "missing" ? .red : .orange)
                            .frame(width: 14)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(r.text + (r.must ? "" : "  (nice to have)"))
                            let evidence = r.facts.map { f in
                                (f.hasProjectSlug ? "\(f.projectSlug): " : "") + f.text
                                    + (f.status == .unconfirmed ? " (unconfirmed)" : "")
                            }
                            if !evidence.isEmpty {
                                Text(evidence.prefix(2).joined(separator: " · ")).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                            }
                            if r.hasNote { Text(r.note).font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(6)
        }
    }

    @ViewBuilder
    private func issues(_ p: Posting) -> some View {
        let notes = p.dealbreakers.map { "Dealbreaker: \($0)" }
            + p.breakdown.filter { $0.uncertain && $0.hasNote }.map { "\(Score.componentTitles[$0.key] ?? $0.key): \($0.note)" }
        if !notes.isEmpty {
            GroupBox("Potential issues") {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(notes, id: \.self) { Text("! " + $0) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(6)
            }
        }
    }

    @ViewBuilder
    private func facts(_ p: Posting) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            if p.hasVerifyNote { Text("Verification: \(p.verifyNote)") }
            if p.hasFormNote { Text("Form: \(p.formNote)") }
            if p.hasDecisionReason { Text("Your note: \(p.decisionReason)") }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }

    private var skipSheet: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Skip this posting").font(.headline)
            Text("The reason decides which weight the feedback nudges (within bounds).")
                .font(.callout).foregroundStyle(.secondary)
            TextField("e.g. salary too low", text: $skipReason)
                .textFieldStyle(.roundedBorder)
                .frame(width: 360)
            HStack {
                Spacer()
                Button("Cancel") { skipping = false }
                Button("Skip") {
                    let reason = skipReason
                    skipping = false
                    skipReason = ""
                    Task { await store.skip(posting: postingId, reason: reason) }
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
    }
}
