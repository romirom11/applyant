// Reviewing an application, answers first: routine fields fold into one line, the CV has its
// card, each answer shows its flagged sentences, and the evidence for the selected answer sits
// on the right. Approve is on only when the daemon reports nothing blocking it.
import AppKit
import ApplyantAPI
import ApplyantKit
import SwiftUI
import UniformTypeIdentifiers

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
    @State private var confirmApprove = false

    var body: some View {
        Group {
            if let app = store.applicationDetails[applicationId] {
                GeometryReader { geo in
                    // Evidence sits beside the answers when there's room, below them when not.
                    let side = geo.size.width >= 860
                    HStack(spacing: 0) {
                        ScrollView {
                            VStack(alignment: .leading, spacing: 16) {
                                header(app)
                                if app.hasHandOff { HandOffCard(store: store, app: app) }
                                if app.hasReceipt { receipt(app.receipt) }
                                if !app.emails.isEmpty { ApplicationReplies(app: app) }
                                if app.hasNote && !app.hasHandOff && app.stage != .needsCandidate { note(app.note) }
                                needsYou(app)
                                if InterviewPrep.applies(app) { InterviewPrepCard(store: store, app: app) }
                                // Sent: notes and contacts matter more than the answers; before
                                // that, they follow the review.
                                let sent = StageRules.isSent(app.stage)
                                if sent { notesAndContacts(app) }
                                standardFields(app)
                                if app.hasCv { CvCard(store: store, app: app) }
                                questions(app)
                                if !sent { notesAndContacts(app) }
                                if !side {
                                    Divider()
                                    EvidencePanel(store: store, app: app, answer: selected(app), scrolls: false)
                                }
                            }
                            .padding(20)
                            .frame(maxWidth: 820, alignment: .leading)
                        }
                        if side {
                            Divider()
                            EvidencePanel(store: store, app: app, answer: selected(app))
                                .frame(width: 290)
                        }
                    }
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
                    Text([app.hasCompany ? app.company : nil, "sent through " + ApproveText.channel(app),
                          app.hasScore ? "score \(app.score)" : nil].compactMap { $0 }.joined(separator: " · "))
                        .foregroundStyle(.secondary)
                }
                Spacer()
                ChipView(chip: StageText.chip(app, delivery: store.deliveries[app.id]))
            }
            if !app.blockers.isEmpty && app.stage != .approved && !StageRules.isSent(app.stage) {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(app.blockers, id: \.self) { blocker in
                        Label(blocker, systemImage: "exclamationmark.circle")
                            .foregroundStyle(.orange)
                            .lineLimit(3)
                    }
                }
                .font(.callout)
            }
            if app.applyFormSwitchable {
                // Found on LinkedIn/Xing and on the company's site: which form it goes through.
                HStack(spacing: 8) {
                    Text(ReviewRules.formText(app)).font(.callout).foregroundStyle(.secondary)
                    if ReviewRules.canSwitchForm(app) {
                        Button(app.applyForm == .platform ? "Use the company's form" : "Use the platform's form") {
                            Task { await store.setApplyForm(application: app.id, form: app.applyForm == .platform ? .company : .platform) }
                        }
                        .help("The form is read again and the application prepared for it")
                    }
                }
            }
            HStack(spacing: 8) {
                Spacer()
                if app.stage == .readyForReview || app.stage == .needsCandidate {
                    Button("Regenerate…") { confirmRegenerate = true }
                    Button("Approve and send…") { confirmApprove = true }
                        .buttonStyle(.borderedProminent)
                        .disabled(!ReviewRules.canApprove(app))
                        .help(ReviewRules.canApprove(app)
                            ? "Asks once more, then Applyant submits the application on its own"
                            : app.blockers.joined(separator: "\n"))
                }
                SetStatusMenu(store: store, app: app).fixedSize()
                if let url = URL(string: app.postingURL) { Link("Posting ↗", destination: url) }
            }
        }
        .confirmationDialog("Write every answer and the CV again?", isPresented: $confirmRegenerate) {
            Button("Regenerate") { Task { await store.regenerate(application: app.id) } }
        } message: {
            Text("Your edits are redrafted too; your per-application values stay.")
        }
        .confirmationDialog(ApproveText.title(app), isPresented: $confirmApprove) {
            Button("Send it") { Task { await store.approve(application: app.id) } }
        } message: {
            Text(ApproveText.message(app))
        }
    }

    @ViewBuilder
    private func notesAndContacts(_ app: Application) -> some View {
        NotesCard(store: store, app: app)
        ContactsCard(store: store, app: app)
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
                        MissingFieldRow(store: store, field: field) { value in
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

    @ViewBuilder
    private func standardFields(_ app: Application) -> some View {
        let routine = ReviewRules.routineFields(app)
        // Nothing to fold while the form is still being prepared.
        if !routine.isEmpty { VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label(
                    "\(routine.count) standard field\(routine.count == 1 ? "" : "s") ready: " + routine.prefix(6).map { $0.label.lowercased() }.joined(separator: ", "),
                    systemImage: "checkmark.circle"
                )
                .lineLimit(1)
                Spacer()
                Button(showAllFields ? "Hide" : "Show all") { showAllFields.toggle() }.buttonStyle(.link)
            }
            if showAllFields {
                ForEach(routine, id: \.ref) { f in
                    FieldRow(field: f, editable: app.stage != .approved && app.stage != .applied) { value in
                        Task { await store.setField(application: app.id, field: f.ref, value: value) }
                    }
                }
            }
        } }
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
                    editable: app.stage != .approved && app.stage != .applied,
                    selected: selected(app)?.number == answer.number,
                    select: { selectedAnswer = answer.number },
                    interview: answer.hasInterviewQuestionID
                        ? { store.navigation.showInterview(.question(answer.interviewQuestionID)) }
                        : nil,
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
                    },
                    redraft: ReviewActions.canRedraft(answer, app: app)
                        ? { shorter, project in
                            Task { await store.redraftAnswer(application: app.id, answer: answer.number, shorter: shorter, project: project) }
                        }
                        : nil,
                    projects: (store.candidateProfile?.projects ?? []).map { (slug: $0.slug, name: $0.name) }
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
    let store: AppStore
    let field: FormFieldValue
    let set: (String) -> Void
    @State private var value = ""
    @State private var picking = false

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
            } else if field.kind == "file" {
                Text(value.isEmpty ? "No file chosen" : (value as NSString).lastPathComponent)
                    .foregroundStyle(value.isEmpty ? .secondary : .primary)
                    .lineLimit(1).truncationMode(.middle)
                    .frame(width: 170, alignment: .leading)
                    .help(value)
                Button("Choose…") { picking = true }
            } else {
                TextField("value", text: $value)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 260)
            }
            Button("Set") { set(value) }.disabled(value.isEmpty)
        }
        .fileImporter(isPresented: $picking, allowedContentTypes: [.pdf, UTType(filenameExtension: "docx") ?? .data, .plainText, .image]) { result in
            // Applyant keeps its own copy, so the background service can always read it.
            if case let .success(url) = result {
                let scoped = url.startAccessingSecurityScopedResource()
                if let path = store.keepCopy(url) { value = path }
                if scoped { url.stopAccessingSecurityScopedResource() }
            }
        }
    }
}

struct FieldRow: View {
    let field: FormFieldValue
    var editable = true
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
                Text(FieldText.source(field.source)).font(.caption).foregroundStyle(.tertiary)
                Spacer()
                if !editable {
                    EmptyView()
                } else if field.source == "override" {
                    Button("Use profile value") { set(nil) }.buttonStyle(.link)
                }
                if editable {
                    Button("Change") {
                        value = field.hasValue ? field.value : ""
                        editing = true
                    }
                    .buttonStyle(.link)
                }
            }
        }
        .font(.callout)
    }
}

struct AnswerCard: View {
    let answer: Answer
    var editable = true
    let selected: Bool
    let select: () -> Void
    /// Opens the interview question asking the candidate for this answer's facts.
    var interview: (() -> Void)?
    let write: () -> Void
    let editSentence: (Sentence) -> Void
    let confirmSentence: (Sentence) -> Void
    let confirmFacts: ([Int64]) -> Void
    /// Quick actions: "Shorter" (true) and/or "Use another project…" (the project's slug).
    var redraft: ((Bool, String?) -> Void)?
    /// The projects "Use another project…" offers (slug, name).
    var projects: [(slug: String, name: String)] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(answer.question).font(.subheadline.weight(.semibold))
            if answer.status == "needs_candidate" {
                Label("Needs you: " + (answer.hasMissing ? answer.missing : "nothing Applyant knows about you answers this"), systemImage: "person.fill.questionmark")
                    .foregroundStyle(.orange)
                HStack {
                    if let interview {
                        Button("Answer in Questions for you", action: interview)
                            .buttonStyle(.borderedProminent)
                            .help("Your answer is saved as facts, then this application is prepared again")
                    }
                    Button("Write the answer…", action: write)
                }
            } else {
                if answer.kind == "choice" && answer.hasChoice {
                    Text("Answer: \(answer.choice)").font(.callout.weight(.medium))
                }
                Text(highlighted).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                if editable { flagged }
                HStack {
                    Text(basedOn).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        .help(ReviewActions.adaptedQuestion(answer) ?? "")
                    Spacer()
                    if let pending = ReviewActions.pending(answer) {
                        ProgressView().controlSize(.small)
                        Text(pending).font(.caption).foregroundStyle(.secondary)
                    }
                    if editable { Button("Edit…", action: write).buttonStyle(.link) }
                    if editable, let redraft, answer.kind == "text", ReviewActions.pending(answer) == nil {
                        Button("Shorter") { redraft(true, nil) }.buttonStyle(.link)
                            .help("Draft this answer again, about half as long, from the same facts")
                        Menu("Use another project…") {
                            ForEach(projects, id: \.slug) { p in
                                Button(p.name) { redraft(false, p.slug) }
                            }
                        }
                        .menuStyle(.borderlessButton)
                        .fixedSize()
                        .disabled(projects.isEmpty)
                    }
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
        if !sentences.isEmpty {
            Text(ReviewRules.flaggedIntro(sentences.count))
                .font(.callout).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        ForEach(sentences, id: \.index) { s in
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(s.flag == "contradiction" ? .red : .orange)
                VStack(alignment: .leading, spacing: 2) {
                    Text("“\(s.text)”").font(.callout).lineLimit(3)
                    Text(ReviewRules.flagReason(s)).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                let unconfirmed = s.facts.filter { $0.status == .unconfirmed }.map(\.id)
                if s.flag == "unconfirmed" && !unconfirmed.isEmpty {
                    Button("Confirm facts") { confirmFacts(unconfirmed) }
                }
                if ReviewRules.canConfirmAsWritten(s) {
                    Button("It's true") { confirmSentence(s) }
                        .help("Keep it as written: it's saved as a fact you stand behind")
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
        if let adapted = ReviewActions.adaptedFrom(answer) { parts.append(adapted) }
        return "Based on: " + parts.joined(separator: " · ")
    }
}

struct EvidencePanel: View {
    let store: AppStore
    let app: Application
    let answer: Answer?
    var scrolls = true
    @State private var editing: EditRequest?
    @State private var confirmingAll = false

    var body: some View {
        Group {
            if scrolls {
                ScrollView { content.padding(14) }
            } else {
                content
            }
        }
        .sheet(item: $editing) { request in
            EditSheet(request: request) { text in
                Task { await request.save(text) }
            }
        }
    }

    private var content: some View {
            VStack(alignment: .leading, spacing: 12) {
                Text("Evidence").font(.headline)
                if !app.unconfirmedFactIds.isEmpty {
                    let n = app.unconfirmedFactIds.count
                    Button("Confirm all \(n) unconfirmed…") { confirmingAll = true }
                        .confirmationDialog("Mark \(n) fact\(n == 1 ? "" : "s") as true?", isPresented: $confirmingAll) {
                            Button("Confirm \(n) fact\(n == 1 ? "" : "s")") {
                                Task { await store.confirmFacts(application: app.id, factIds: []) }
                            }
                        } message: {
                            Text("Every fact this application relies on is marked true, for good: this and later applications may state them. Read them below first; Edit or reject any that aren't right (Projects → Facts to confirm).")
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
                            Text((fact.hasProjectSlug ? (store.candidateProfile?.projects.first { $0.slug == fact.projectSlug }?.name ?? fact.projectSlug) : "Profile") + " · fact \(fact.id)")
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
                                if app.stage != .approved && !StageRules.isSent(app.stage) {
                                    // The fact in the candidate's words (confirmed); the answers
                                    // relying on it re-check as they do after Confirm.
                                    Button("Edit…") {
                                        editing = EditRequest(title: "Fact #\(fact.id)", hint: "The fact in your words (saved as confirmed)", text: fact.text) { text in
                                            _ = await store.editFact(fact.id, text: text, project: nil)
                                        }
                                    }
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
                if app.hasCompanyResearch {
                    CompanyCard(store: store, company: app.companyResearch, compact: true)
                }
            }
    }

    private func uniqueFacts(_ answer: Answer) -> [Applyant_V1_MatchedFact] {
        var seen = Set<Int64>()
        return answer.sentences.flatMap(\.facts).filter { seen.insert($0.id).inserted }
    }

    private func statusText(_ status: Applyant_V1_FactStatus) -> String {
        switch status {
        case .confirmed: "Confirmed"
        case .unconfirmed: "Not confirmed yet"
        case .rejected: "Rejected"
        default: "?"
        }
    }
}

struct CvCard: View {
    let store: AppStore
    let app: Application
    @State private var editing = false

    private func title(_ cv: Applyant_V1_Cv) -> String {
        if cv.mode == "base" { return "CV · your base CV" }
        switch cv.status {
        case "skipped": return "CV · your base CV is sent (no tailored one)"
        case "pending", "planned": return "CV · being tailored for this role…"
        default: return "CV · tailored for this role"
        }
    }

    var body: some View {
        let cv = app.cv
        GroupBox {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(title(cv)).font(.headline)
                    Spacer()
                    if cv.status == "pending" || cv.status == "planned" { ProgressView().controlSize(.small) }
                }
                if cv.mode == "tailored" && cv.status == "ready" {
                    if !cv.projects.isEmpty {
                        Text("Projects in order: " + cv.projects.map(\.name).joined(separator: ", "))
                    }
                    if !cv.skills.isEmpty {
                        Text("Skills lead with: " + cv.skills.prefix(6).joined(separator: ", "))
                    }
                    if let summary = cv.summary.first { Text("Summary: " + summary.text).lineLimit(3) }
                    if !cv.dropped.isEmpty {
                        Text("\(cv.dropped.count) line\(cv.dropped.count == 1 ? "" : "s") left out because your facts don't back \(cv.dropped.count == 1 ? "it" : "them") (Edit… shows which)")
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
                    if CvText.canEdit(app) {
                        Button("Edit…") { editing = true }
                    }
                    if app.stage == .approved || StageRules.isSent(app.stage) {
                        EmptyView()  // already sent or on its way: nothing to change
                    } else if cv.mode == "tailored" && cv.status == "skipped" {
                        Button("Try the tailored CV again") { Task { await store.setCvMode(application: app.id, mode: "tailored") } }
                    } else if cv.mode == "tailored" {
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
        .sheet(isPresented: $editing) { CvEditSheet(store: store, appId: app.id) { editing = false } }
    }
}

/// The tailored CV line by line: each line in the candidate's words (saved as a confirmed fact),
/// removed, or a left-out line put back. The PDF is rendered again; Preview opens the new one.
struct CvEditSheet: View {
    let store: AppStore
    let appId: Int64
    let close: () -> Void
    @State private var editingLine: String?
    @State private var text = ""
    @State private var removing: CvEditableLine?

    var body: some View {
        let app = store.applicationDetails[appId] ?? store.applications[appId]
        let lines = app.map { CvText.lines($0.cv) } ?? []
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Edit the tailored CV").font(.title2.bold())
                Spacer()
                if let app, app.cv.status == "pending" || app.cv.status == "planned" {
                    ProgressView().controlSize(.small)
                    Text("Rendering…").font(.callout).foregroundStyle(.secondary)
                } else if let app, app.cv.hasPdfPath {
                    Button("Preview") { NSWorkspace.shared.open(URL(fileURLWithPath: app.cv.pdfPath)) }
                }
                Button("Done", action: close).keyboardShortcut(.cancelAction)
            }
            .padding(16)
            List {
                ForEach(lines) { line in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(line.section).font(.caption.weight(.semibold)).foregroundStyle(line.dropped ? .orange : .secondary)
                            Spacer()
                            if editingLine != line.handle, app.map(CvText.canEdit) == true {
                                Button(line.dropped ? "Put back…" : "Edit") { text = line.text; editingLine = line.handle }
                                    .controlSize(.small)
                                if !line.dropped {
                                    Button("Remove…", role: .destructive) { removing = line }
                                        .controlSize(.small)
                                }
                            }
                        }
                        if editingLine == line.handle {
                            TextField("The line, in your words", text: $text, axis: .vertical)
                                .textFieldStyle(.roundedBorder)
                                .lineLimit(1 ... 5)
                            HStack {
                                Spacer()
                                Button("Cancel") { editingLine = nil }
                                Button("Save") {
                                    let (handle, t) = (line.handle, text)
                                    Task { if await store.editCv(application: appId, line: handle, text: t) { editingLine = nil } }
                                }
                                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            }
                        } else {
                            Text(line.text).foregroundStyle(line.dropped ? .secondary : .primary).textSelection(.enabled)
                        }
                    }
                    .padding(.vertical, 3)
                }
            }
            Text("Your words are saved as a confirmed fact, and the CV is printed again.")
                .font(.caption).foregroundStyle(.secondary)
                .padding(16)
        }
        .frame(minWidth: 620, idealWidth: 700, minHeight: 480, idealHeight: 620)
        .showsErrors(store)
        .confirmationDialog(
            "Remove this line from the CV?",
            isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
            presenting: removing
        ) { line in
            Button("Remove the line", role: .destructive) {
                Task { await store.editCv(application: appId, line: line.handle, text: nil) }
            }
        } message: { line in
            Text("“\(line.text)” leaves this CV. The fact behind it stays in your profile.")
        }
        .task { await store.openApplication(appId) }
    }
}
