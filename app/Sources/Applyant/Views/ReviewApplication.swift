// Reviewing an application, answers first: routine fields fold into one line, the CV has its
// card, each answer shows its flagged sentences, and the evidence for the selected answer sits
// on the right. Approve is on only when the daemon reports nothing blocking it.
import AppKit
import ApplyantAPI
import ApplyantKit
import SwiftUI

typealias Answer = Applyant_V1_Answer
typealias Sentence = Applyant_V1_AnswerSentence
typealias FormFieldValue = Applyant_V1_ApplicationField

struct ReviewApplication: View {
    let store: AppStore
    let applicationId: Int64
    @State private var selectedAnswer: Int32?
    @State private var editing: EditRequest?
    @State private var showAllFields = false
    @State private var confirmRegenerate = false

    var body: some View {
        Group {
            if let app = store.applicationDetails[applicationId] {
                HStack(spacing: 0) {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 16) {
                            header(app)
                            if app.hasHandOff { HandOffCard(store: store, app: app) }
                            if app.hasReceipt { receipt(app.receipt) }
                            if app.hasNote && !app.hasHandOff { note(app.note) }
                            needsYou(app)
                            standardFields(app)
                            if app.hasCv { CvCard(store: store, app: app) }
                            questions(app)
                        }
                        .padding(20)
                        .frame(maxWidth: 820, alignment: .leading)
                    }
                    Divider()
                    EvidencePanel(store: store, app: app, answer: selected(app))
                        .frame(width: 300)
                }
            } else {
                ProgressView()
            }
        }
        .task(id: applicationId) { await store.openApplication(applicationId) }
        .sheet(item: $editing) { request in
            EditSheet(request: request) { text in
                Task { await request.save(text) }
            }
        }
    }

    private func selected(_ app: Application) -> Answer? {
        let answers = ReviewRules.activeAnswers(app)
        return answers.first { $0.number == selectedAnswer } ?? answers.first
    }

    // MARK: Header

    private func header(_ app: Application) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(app.hasTitle ? app.title : "Application \(app.id)").font(.title2.weight(.semibold))
                    Text([app.hasCompany ? app.company : nil, app.channel.replacingOccurrences(of: "_", with: " "),
                          app.hasScore ? "score \(app.score)" : nil].compactMap { $0 }.joined(separator: " · "))
                        .foregroundStyle(.secondary)
                }
                Spacer()
                ChipView(chip: StageText.chip(app))
            }
            HStack(spacing: 8) {
                if !app.blockers.isEmpty && app.stage != .approved && app.stage != .applied {
                    Label(app.blockers.joined(separator: " · "), systemImage: "exclamationmark.circle")
                        .foregroundStyle(.orange)
                        .lineLimit(2)
                }
                Spacer()
                if app.stage == .readyForReview || app.stage == .needsCandidate {
                    Button("Regenerate…") { confirmRegenerate = true }
                    Button("Approve") { Task { await store.approve(application: app.id) } }
                        .buttonStyle(.borderedProminent)
                        .disabled(!ReviewRules.canApprove(app))
                        .help(ReviewRules.canApprove(app) ? "Approve: the daemon delivers it on its own" : app.blockers.joined(separator: "\n"))
                }
                if let url = URL(string: app.postingURL) { Link("Posting ↗", destination: url) }
            }
        }
        .confirmationDialog("Write every answer and the CV again?", isPresented: $confirmRegenerate) {
            Button("Regenerate") { Task { await store.regenerate(application: app.id) } }
        } message: {
            Text("Your edits are redrafted too; your per-application values stay.")
        }
    }

    private func note(_ text: String) -> some View {
        Label(text, systemImage: "info.circle").foregroundStyle(.secondary)
    }

    private func receipt(_ r: Applyant_V1_Receipt) -> some View {
        GroupBox("Sent") {
            VStack(alignment: .leading, spacing: 4) {
                Text("Submitted " + r.submittedAt.date.formatted(date: .abbreviated, time: .shortened))
                if r.hasConfirmationText { Text("“\(r.confirmationText)”").foregroundStyle(.secondary) }
                Text("\(r.fieldValues.count) values sent" + (r.hasSalaryValue ? " · salary \(r.salaryValue)" : ""))
                if r.hasCvPath {
                    Button("Show the CV that was sent") { NSWorkspace.shared.open(URL(fileURLWithPath: r.cvPath)) }
                        .buttonStyle(.link)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(6)
        }
    }

    // MARK: What only the candidate can give

    @ViewBuilder
    private func needsYou(_ app: Application) -> some View {
        let fields = ReviewRules.problemFields(app)
        if !fields.isEmpty {
            GroupBox {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Needs a value").font(.headline)
                    ForEach(fields, id: \.ref) { field in
                        MissingFieldRow(field: field) { value in
                            Task { await store.setField(application: app.id, field: field.ref, value: value) }
                        }
                    }
                    Text("For this application only; your profile stays as it is.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(6)
            }
        }
    }

    // MARK: Standard fields

    private func standardFields(_ app: Application) -> some View {
        let routine = ReviewRules.routineFields(app)
        return VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label(
                    "\(routine.count) standard fields ready — " + routine.prefix(6).map { $0.label.lowercased() }.joined(separator: ", "),
                    systemImage: "checkmark.circle"
                )
                .lineLimit(1)
                Spacer()
                Button(showAllFields ? "Hide" : "Show all") { showAllFields.toggle() }.buttonStyle(.link)
            }
            if showAllFields {
                ForEach(routine, id: \.ref) { f in
                    FieldRow(field: f) { value in
                        Task { await store.setField(application: app.id, field: f.ref, value: value) }
                    }
                }
            }
        }
    }

    // MARK: Questions

    @ViewBuilder
    private func questions(_ app: Application) -> some View {
        let answers = ReviewRules.activeAnswers(app)
        if !answers.isEmpty {
            Text("Questions · \(answers.count)").font(.headline)
            ForEach(answers, id: \.id) { answer in
                AnswerCard(
                    answer: answer,
                    selected: selected(app)?.number == answer.number,
                    select: { selectedAnswer = answer.number },
                    write: {
                        editing = EditRequest(
                            title: answer.question,
                            hint: answer.status == "needs_candidate" ? (answer.hasMissing ? answer.missing : "Your answer") : "The whole answer in your words",
                            text: answer.sentences.map(\.text).joined(separator: " ")
                        ) { text in
                            await store.editAnswer(application: app.id, answer: answer.number, sentence: nil, text: text)
                        }
                    },
                    editSentence: { s in
                        editing = EditRequest(title: "Sentence \(s.index + 1)", hint: ReviewRules.flagText(s) ?? "", text: s.text) { text in
                            await store.editAnswer(application: app.id, answer: answer.number, sentence: s.index, text: text)
                        }
                    },
                    confirmSentence: { s in
                        Task { await store.editAnswer(application: app.id, answer: answer.number, sentence: s.index, text: nil) }
                    },
                    confirmFacts: { ids in
                        Task { await store.confirmFacts(application: app.id, factIds: ids) }
                    }
                )
            }
        }
    }
}

// MARK: - Pieces

struct EditRequest: Identifiable {
    let id = UUID()
    let title: String
    let hint: String
    let text: String
    let save: @MainActor (String) async -> Void
}

struct EditSheet: View {
    let request: EditRequest
    let onSave: (String) -> Void
    @State private var text = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(request.title).font(.headline)
            if !request.hint.isEmpty { Text(request.hint).foregroundStyle(.secondary) }
            TextEditor(text: $text)
                .font(.body)
                .frame(width: 520, height: 180)
                .border(.separator)
            Text("Saved as a confirmed fact, so later applications can use it too.")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Save") {
                    onSave(text)
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(20)
        .onAppear { text = request.text }
    }
}

struct MissingFieldRow: View {
    let field: FormFieldValue
    let set: (String) -> Void
    @State private var value = ""

    var body: some View {
        HStack {
            VStack(alignment: .leading) {
                Text(field.label)
                if field.hasNote { Text(field.note).font(.caption).foregroundStyle(.secondary) }
            }
            .frame(width: 220, alignment: .leading)
            if field.hasOptions_p && !field.options.isEmpty {
                Picker("", selection: $value) {
                    Text("Choose…").tag("")
                    ForEach(field.options, id: \.self) { Text($0).tag($0) }
                }
                .labelsHidden()
                .frame(width: 260)
            } else {
                TextField(field.kind == "file" ? "/path/to/file" : "value", text: $value)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 260)
            }
            Button("Set") { set(value) }.disabled(value.isEmpty)
        }
    }
}

struct FieldRow: View {
    let field: FormFieldValue
    let set: (String?) -> Void
    @State private var editing = false
    @State private var value = ""

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(field.label).frame(width: 220, alignment: .leading).foregroundStyle(.secondary)
            if editing {
                TextField("", text: $value).textFieldStyle(.roundedBorder)
                Button("Set") {
                    set(value)
                    editing = false
                }
                Button("Cancel") { editing = false }
            } else {
                Text(field.hasValue ? field.value : "—").lineLimit(2).textSelection(.enabled)
                Text(field.source).font(.caption).foregroundStyle(.tertiary)
                Spacer()
                if field.source == "override" {
                    Button("Profile value") { set(nil) }.buttonStyle(.link)
                }
                Button("Change") {
                    value = field.hasValue ? field.value : ""
                    editing = true
                }
                .buttonStyle(.link)
            }
        }
        .font(.callout)
    }
}

struct AnswerCard: View {
    let answer: Answer
    let selected: Bool
    let select: () -> Void
    let write: () -> Void
    let editSentence: (Sentence) -> Void
    let confirmSentence: (Sentence) -> Void
    let confirmFacts: ([Int64]) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(answer.question).font(.subheadline.weight(.semibold))
            if answer.status == "needs_candidate" {
                Label("Needs you: " + (answer.hasMissing ? answer.missing : "no facts cover this"), systemImage: "person.fill.questionmark")
                    .foregroundStyle(.orange)
                Button("Write the answer…", action: write)
            } else {
                if answer.kind == "choice" && answer.hasChoice {
                    Text("Answer: \(answer.choice)").font(.callout.weight(.medium))
                }
                Text(highlighted).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                flagged
                HStack {
                    Text(basedOn).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    Spacer()
                    Button("Edit…", action: write).buttonStyle(.link)
                }
            }
        }
        .padding(12)
        .background(selected ? Color.accentColor.opacity(0.07) : Color.clear, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(selected ? Color.accentColor.opacity(0.5) : Color.secondary.opacity(0.2)))
        .contentShape(Rectangle())
        .onTapGesture(perform: select)
    }

    /// The answer as sent, with every flagged sentence highlighted.
    private var highlighted: AttributedString {
        var out = AttributedString()
        for s in answer.sentences {
            var part = AttributedString(s.text + " ")
            if ReviewRules.flagText(s) != nil {
                part.backgroundColor = s.flag == "contradiction" ? .red.opacity(0.25) : .yellow.opacity(0.35)
            }
            out += part
        }
        return out
    }

    @ViewBuilder
    private var flagged: some View {
        let sentences = answer.sentences.filter { ReviewRules.flagText($0) != nil }
        ForEach(sentences, id: \.index) { s in
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(s.flag == "contradiction" ? .red : .orange)
                VStack(alignment: .leading, spacing: 2) {
                    Text(ReviewRules.flagText(s) ?? "").font(.caption.weight(.medium))
                    Text("“\(s.text)”").font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
                Spacer()
                let unconfirmed = s.facts.filter { $0.status == .unconfirmed }.map(\.id)
                if s.flag == "unconfirmed" && !unconfirmed.isEmpty {
                    Button("Confirm facts") { confirmFacts(unconfirmed) }
                }
                if ReviewRules.canConfirmAsWritten(s) {
                    Button("True as written") { confirmSentence(s) }
                }
                Button("Edit…") { editSentence(s) }
            }
            .controlSize(.small)
        }
    }

    private var basedOn: String {
        let projects = Set(answer.sentences.flatMap { $0.facts.compactMap { $0.hasProjectSlug ? $0.projectSlug : nil } })
        let facts = Set(answer.sentences.flatMap(\.factIds)).count
        var parts = projects.sorted()
        parts.append("\(facts) fact\(facts == 1 ? "" : "s")")
        if answer.edited { parts.append("your edit") }
        if answer.hasAdaptedFrom { parts.append("adapted from an earlier answer") }
        return "Based on: " + parts.joined(separator: " · ")
    }
}

struct EvidencePanel: View {
    let store: AppStore
    let app: Application
    let answer: Answer?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Evidence").font(.headline)
                if !app.unconfirmedFactIds.isEmpty {
                    Button("Confirm all \(app.unconfirmedFactIds.count) unconfirmed") {
                        Task { await store.confirmFacts(application: app.id, factIds: []) }
                    }
                    Text("Confirming says the fact is true, for good: later applications use it too.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let answer {
                    Text(answer.question).font(.caption).foregroundStyle(.secondary)
                    let facts = uniqueFacts(answer)
                    if facts.isEmpty { Text("No facts cited.").foregroundStyle(.secondary) }
                    ForEach(facts, id: \.id) { fact in
                        VStack(alignment: .leading, spacing: 4) {
                            Text((fact.hasProjectSlug ? fact.projectSlug : "profile") + " · #\(fact.id)")
                                .font(.caption).foregroundStyle(.secondary)
                            Text(fact.text).font(.callout)
                            HStack {
                                Text(statusText(fact.status))
                                    .font(.caption)
                                    .foregroundStyle(fact.status == .confirmed ? .green : .orange)
                                Spacer()
                                if fact.status == .unconfirmed {
                                    Button("Confirm") { Task { await store.confirmFacts(application: app.id, factIds: [fact.id]) } }
                                        .controlSize(.small)
                                }
                            }
                        }
                        .padding(8)
                        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 6))
                    }
                } else {
                    Text("Select an answer to see what it rests on.").foregroundStyle(.secondary)
                }
            }
            .padding(14)
        }
    }

    private func uniqueFacts(_ answer: Answer) -> [Applyant_V1_MatchedFact] {
        var seen = Set<Int64>()
        return answer.sentences.flatMap(\.facts).filter { seen.insert($0.id).inserted }
    }

    private func statusText(_ status: Applyant_V1_FactStatus) -> String {
        switch status {
        case .confirmed: "confirmed"
        case .unconfirmed: "unconfirmed"
        case .rejected: "rejected"
        default: "?"
        }
    }
}

struct CvCard: View {
    let store: AppStore
    let app: Application

    var body: some View {
        let cv = app.cv
        GroupBox {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(cv.mode == "base" ? "CV · your base CV" : "CV · tailored for this role").font(.headline)
                    Spacer()
                    Text(cv.status).font(.caption).foregroundStyle(.secondary)
                }
                if cv.mode == "tailored" {
                    if !cv.projects.isEmpty {
                        Text("Projects in order: " + cv.projects.map(\.name).joined(separator: ", "))
                    }
                    if !cv.skills.isEmpty {
                        Text("Skills lead with: " + cv.skills.prefix(6).joined(separator: ", "))
                    }
                    if let summary = cv.summary.first { Text("Summary: " + summary.text).lineLimit(3) }
                    if !cv.dropped.isEmpty {
                        Text("\(cv.dropped.count) line\(cv.dropped.count == 1 ? "" : "s") left out (didn't pass the checks)")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if !cv.stale.isEmpty {
                        Label("Lines whose facts are no longer confirmed: " + cv.stale.joined(separator: ", "), systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.orange)
                    }
                }
                if cv.hasNote { Text(cv.note).font(.caption).foregroundStyle(.secondary) }
                HStack {
                    if cv.hasPdfPath {
                        Button("Preview") { NSWorkspace.shared.open(URL(fileURLWithPath: cv.pdfPath)) }
                    }
                    if cv.mode == "tailored" {
                        Button("Use base CV instead") { Task { await store.setCvMode(application: app.id, mode: "base") } }
                    } else {
                        Button("Use the tailored CV") { Task { await store.setCvMode(application: app.id, mode: "tailored") } }
                    }
                }
                .padding(.top, 2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(6)
        }
    }
}
