// The job detail's Application tab: reviewing an application, answers first. Routine fields
// fold into one line, the CV has its card, each answer shows its flagged sentences, and the
// evidence for the selected answer sits on the right. Approve and Send…, Skip… and Regenerate…
// are the detail's (its header, the Job menu); Before You Can Send has what still blocks them,
// each with its control in its row.
import AppKit
import ApplyantAPI
import ApplyantKit
import SwiftUI
import UniformTypeIdentifiers

typealias Answer = Applyant_V1_Answer
typealias Sentence = Applyant_V1_AnswerSentence
typealias FormFieldValue = Applyant_V1_ApplicationField

struct ApplicationTab: View {
    let store: AppStore
    let applicationId: Int64
    @State private var selectedAnswer: Int32?
    @State private var editing: EditRequest?
    @State private var showAllFields = false
    @State private var confirmingAll = false

    var body: some View {
        Group {
            if let app = store.applicationDetails[applicationId] {
                GeometryReader { geo in
                    // Evidence is for answers still under review: beside them when the page
                    // keeps its own width, below them when not.
                    let sent = StageRules.isSent(app.stage)
                    let evidence = !sent && !ReviewRules.activeAnswers(app).isEmpty
                    let side = evidence && geo.size.width >= 872
                    let evidenceWidth = min(310, max(260, geo.size.width - 612))
                    HStack(spacing: 0) {
                        ScrollViewReader { proxy in
                            ScrollView {
                                VStack(alignment: .leading, spacing: Theme.blockSpacing) {
                                    status(app)
                                    if app.hasHandOff { HandOffCard(store: store, app: app) }
                                    if app.hasReceipt { receipt(app.receipt) }
                                    if !app.emails.isEmpty { ApplicationReplies(app: app) }
                                    if app.hasNote && !app.hasHandOff && app.stage != .needsCandidate { note(app.note) }
                                    beforeYouCanSend(app, proxy: proxy)
                                    if InterviewPrep.applies(app) { InterviewPrepCard(store: store, app: app) }
                                    // Sent: notes and contacts matter more than the answers; before
                                    // that, they follow the review.
                                    if sent { NotesAndContacts(store: store, app: app) }
                                    standardFields(app)
                                    if app.hasCv { CvCard(store: store, app: app).id("cv") }
                                    questions(app)
                                    if !sent { NotesAndContacts(store: store, app: app) }
                                    if evidence && !side {
                                        Divider()
                                        EvidencePanel(store: store, app: app, answer: selected(app), scrolls: false)
                                    }
                                }
                                .pageColumn()
                            }
                        }
                        if side {
                            EvidencePanel(store: store, app: app, answer: selected(app))
                                .frame(width: evidenceWidth)
                                .clipShape(RoundedRectangle(cornerRadius: Theme.cornerRadius, style: .continuous))
                                .glass()
                                .padding(.trailing, 12)
                                .padding(.vertical, 8)
                        }
                    }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        // JobDetail loads the application (its header needs it too): not again on every tab switch.
        .sheet(item: $editing) { request in
            EditSheet(request: request) { text in
                Task { await request.save(text) }
            }
            .worldSheet()
        }
    }

    private func selected(_ app: Application) -> Answer? {
        let answers = ReviewRules.activeAnswers(app)
        return answers.first { $0.number == selectedAnswer } ?? answers.first
    }

    // MARK: Where it stands

    /// How it's sent and which form it goes through. What still blocks it is the card below.
    @ViewBuilder
    private func status(_ app: Application) -> some View {
        VStack(alignment: .leading, spacing: Theme.rowSpacing) {
            MetaLine((StageRules.isSent(app.stage) ? "Sent through " : "Goes through ") + ApproveText.channel(app), systemImage: "arrow.up.forward.app")
            if app.applyFormSwitchable {
                // Found on LinkedIn/Xing and on the company's site: which form it goes through.
                HStack(spacing: 8) {
                    MetaLine(ReviewRules.formText(app))
                    if ReviewRules.canSwitchForm(app) {
                        Button(app.applyForm == .platform ? "Use Company's Form" : "Use Platform's Form") {
                            Task { await store.setApplyForm(application: app.id, form: app.applyForm == .platform ? .company : .platform) }
                        }
                        .buttonStyle(.secondary)
                        .controlSize(.small)
                        .fixedSize()
                        .help("The form is read again and the application prepared for it")
                    }
                }
            }
        }
    }

    private func note(_ text: String) -> some View {
        MetaLine(FieldText.plain(text), systemImage: "info.circle")
    }

    private func receipt(_ r: Applyant_V1_Receipt) -> some View {
        Card(title: "Submission Receipt", systemImage: "checkmark.seal.fill", tint: Theme.good) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Submitted " + r.submittedAt.date.formatted(date: .abbreviated, time: .shortened)).textRole(.body)
                if r.hasConfirmationText {
                    Text(r.confirmationText.count > 300 ? "Confirmation page captured" : "“\(r.confirmationText)”")
                        .textRole(.body, color: Theme.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                }
                MetaLine("\(r.fieldValues.count) values sent" + (r.hasSalaryValue ? " · salary \(r.salaryValue)" : ""))
                if r.hasCvPath {
                    Button("Show Sent CV") { NSWorkspace.shared.open(URL(fileURLWithPath: r.cvPath)) }
                        .buttonStyle(.link)
                        .foregroundStyle(Theme.accent)
                }
            }
        }
    }

    // MARK: What only the candidate can give

    /// Everything that stands between the review and Send, each with its control in its row:
    /// the values only the candidate has, the questions only they can answer, the sentences to
    /// check, the facts to confirm, the CV lines to fix. Built from ReviewRules.todo's sources,
    /// so it says what the hero's chips count.
    @ViewBuilder
    private func beforeYouCanSend(_ app: Application, proxy: ScrollViewProxy) -> some View {
        let todo = ReviewRules.todo(app)
        if !todo.isEmpty {
            let fields = ReviewRules.problemFields(app)
            let answers = ReviewRules.answersNeedingYou(app)
            let sentences = ReviewRules.sentencesToCheck(app)
            Card(title: "Before you can send", systemImage: "checklist") {
                VStack(alignment: .leading, spacing: Theme.rowSpacing + 4) {
                    ForEach(fields, id: \.ref) { field in
                        MissingFieldRow(store: store, field: field) { value in
                            Task { await store.setField(application: app.id, field: field.ref, value: value) }
                        }
                    }
                    ForEach(Array(answers.enumerated()), id: \.element.id) { index, answer in
                        LabeledRow(answer.question, note: answer.hasMissing ? FieldText.plain(answer.missing) : "Nothing Applyant knows about you answers this", status: .warning) {
                            HStack(spacing: 8) {
                                if answer.hasInterviewQuestionID {
                                    Button("Answer in Questions…") { store.navigation.showInterview(.question(answer.interviewQuestionID)) }
                                        .buttonStyle(index == 0 && fields.isEmpty ? AnyButtonStyle(.primary) : AnyButtonStyle(.secondary))
                                        .fixedSize()
                                        .help("Your answer is saved as facts, then this application is prepared again")
                                }
                                Button("Write Answer…") { write(answer, app: app) }
                                    .buttonStyle(.secondary)
                                    .fixedSize()
                            }
                        }
                    }
                    ForEach(Array(sentences.enumerated()), id: \.offset) { _, item in
                        Button {
                            withAnimation(Theme.Motion.snappy) {
                                selectedAnswer = item.answer.number
                                proxy.scrollTo("answer-\(item.answer.number)", anchor: .top)
                            }
                        } label: {
                            EvidenceRow("“\(item.sentence.text)”", reason: ReviewRules.flagReason(item.sentence), margin: "Check ›") {
                                Image(systemName: "exclamationmark.triangle.fill")
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(item.sentence.flag == "contradiction" ? Theme.bad : Theme.warning)
                                    .frame(width: 18)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .help("In “\(item.answer.question)”: shows the answer with this sentence highlighted")
                    }
                    if !app.unconfirmedFactIds.isEmpty {
                        let n = Set(app.unconfirmedFactIds).count
                        LabeledRow(n == 1 ? "1 fact to confirm" : "\(n) facts to confirm", note: "Confirming says it's true, for good: later applications use it too", status: .warning) {
                            Button("Confirm All…") { confirmingAll = true }
                                .buttonStyle(.secondary)
                                .fixedSize()
                                .help("The Evidence beside each answer has them one by one")
                                .confirmationDialog("Mark \(n) fact\(n == 1 ? "" : "s") as true?", isPresented: $confirmingAll) {
                                    Button("Confirm \(n) Fact\(n == 1 ? "" : "s")") {
                                        Task { await store.confirmFacts(application: app.id, factIds: []) }
                                    }
                                } message: {
                                    Text("Every fact this application relies on is marked true, for good: this and later applications may state them. Read them in Evidence first; edit or reject any that aren't right (Projects → Facts to confirm).")
                                }
                        }
                    }
                    if app.hasCv, !app.cv.stale.isEmpty {
                        let n = app.cv.stale.count
                        LabeledRow(n == 1 ? "1 CV line to fix" : "\(n) CV lines to fix", note: "Their facts are no longer confirmed", status: .warning) {
                            Button("Show CV") { withAnimation(Theme.Motion.snappy) { proxy.scrollTo("cv", anchor: .top) } }
                                .buttonStyle(.secondary)
                                .fixedSize()
                        }
                    }
                    if !fields.isEmpty { MetaLine("Values are saved for this application only; your profile stays as it is") }
                }
            }
        }
    }

    private func write(_ answer: Answer, app: Application) {
        editing = EditRequest(
            title: answer.question,
            hint: answer.status == "needs_candidate" ? (answer.hasMissing ? FieldText.plain(answer.missing) : "Your answer") : "The whole answer in your words",
            text: answer.sentences.map(\.text).joined(separator: " ")
        ) { text in
            await store.editAnswer(application: app.id, answer: answer.number, sentence: nil, text: text)
        }
    }

    // MARK: Standard fields

    @ViewBuilder
    private func standardFields(_ app: Application) -> some View {
        let routine = ReviewRules.routineFields(app)
        let sent = app.stage == .approved || StageRules.isSent(app.stage)
        // Nothing to fold while the form is still being prepared.
        if !routine.isEmpty { VStack(alignment: .leading, spacing: Theme.rowSpacing) {
            HStack(spacing: 8) {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.good)
                Text("\(routine.count) standard field\(routine.count == 1 ? "" : "s") \(sent ? "sent" : "ready")")
                    .textRole(.itemTitle)
                Text(routine.prefix(6).map { $0.label.lowercased() }.joined(separator: ", "))
                    .textRole(.meta)
                    .lineLimit(1)
                    .help(routine.map(\.label).joined(separator: ", "))
                Spacer(minLength: 8)
                DisclosureLine(showAllFields ? "Hide" : "Show All", isExpanded: $showAllFields.animation(Theme.Motion.snappy))
            }
            if showAllFields {
                ForEach(routine, id: \.ref) { f in
                    FieldRow(field: f, editable: !sent) { value in
                        Task { await store.setField(application: app.id, field: f.ref, value: value) }
                    }
                }
                .transition(.opacity)
            }
        }
        .padding(12)
        .glass(radius: Theme.innerRadius + 4) }
    }

    // MARK: Questions

    @ViewBuilder
    private func questions(_ app: Application) -> some View {
        let answers = ReviewRules.activeAnswers(app)
        if !answers.isEmpty {
            HStack(spacing: 8) {
                CardTitle(title: "Questions", systemImage: "text.bubble")
                Text("\(answers.count)")
                    .font(Theme.number(11, weight: .semibold))
                    .foregroundStyle(Theme.secondaryText)
                    .padding(.horizontal, 6).padding(.vertical, 1)
                    .background(Theme.chipNeutralFill, in: Capsule())
            }
            .padding(.top, 4)
            ForEach(answers, id: \.id) { answer in
                AnswerCard(
                    answer: answer,
                    editable: app.stage != .approved && !StageRules.isSent(app.stage),
                    selected: selected(app)?.number == answer.number,
                    select: { withAnimation(Theme.Motion.snappy) { selectedAnswer = answer.number } },
                    interview: answer.hasInterviewQuestionID
                        ? { store.navigation.showInterview(.question(answer.interviewQuestionID)) }
                        : nil,
                    write: { write(answer, app: app) },
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
                .id("answer-\(answer.number)")
            }
        }
    }
}

/// `.primary` or `.secondary`, picked at run time.
struct AnyButtonStyle: ButtonStyle {
    private let make: (Configuration) -> AnyView

    init<S: ButtonStyle>(_ style: S) { make = { AnyView(style.makeBody(configuration: $0)) } }

    func makeBody(configuration: Configuration) -> some View { make(configuration) }
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
            Text(request.title).textRole(.heading)
            if !request.hint.isEmpty { Text(request.hint).textRole(.body, color: Theme.secondaryText).fixedSize(horizontal: false, vertical: true) }
            TextEditor(text: $text)
                .font(.body)
                .frame(width: 520, height: 180)
                .composerField()
            MetaLine("Saved as a confirmed fact, so later applications can use it too.")
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.buttonStyle(.secondary)
                Button("Save") {
                    onSave(text)
                    dismiss()
                }
                .buttonStyle(.primary)
                .keyboardShortcut(.defaultAction)
                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(20)
        .onAppear { text = request.text }
    }
}

/// A value only the candidate can give, in its row: a choice is set as soon as it's picked, a
/// file as soon as it's chosen, text on Return or Set.
struct MissingFieldRow: View {
    let store: AppStore
    let field: FormFieldValue
    let set: (String) -> Void
    @State private var value = ""
    @State private var picking = false

    var body: some View {
        LabeledRow(field.label, note: field.hasNote ? FieldText.plain(field.note) : nil, status: .warning) {
            if field.hasOptions_p && !field.options.isEmpty {
                Picker(field.label, selection: $value) {
                    Text("Choose…").tag("")
                    ForEach(field.options, id: \.self) { Text($0).tag($0) }
                }
                .labelsHidden()
                .frame(maxWidth: 320, alignment: .leading)
                .onChange(of: value) { _, picked in
                    if !picked.isEmpty { set(picked) }
                }
            } else if field.kind == "file" {
                HStack(spacing: 8) {
                    Text(value.isEmpty ? "No file chosen" : (value as NSString).lastPathComponent)
                        .textRole(.body, color: value.isEmpty ? Theme.secondaryText : Theme.text)
                        .lineLimit(1).truncationMode(.middle)
                        .frame(maxWidth: 200, alignment: .leading)
                        .help(value)
                    Button("Choose…") { picking = true }
                        .buttonStyle(.secondary)
                        .fixedSize()
                        .layoutPriority(1)
                }
            } else {
                HStack(spacing: 8) {
                    TextField(field.label, text: $value, prompt: Text(FieldText.placeholder(field)))
                        .labelsHidden()
                        .textFieldStyle(.roundedBorder)
                        .frame(maxWidth: 320)
                        .onSubmit(commit)
                    Button("Set", action: commit)
                        .buttonStyle(.secondary)
                        .disabled(value.trimmingCharacters(in: .whitespaces).isEmpty)
                        .fixedSize()
                        .layoutPriority(1)
                }
            }
        }
        .fileImporter(isPresented: $picking, allowedContentTypes: [.pdf, UTType(filenameExtension: "docx") ?? .data, .plainText, .image]) { result in
            // Applyant keeps its own copy, so the background service can always read it.
            if case let .success(url) = result {
                let scoped = url.startAccessingSecurityScopedResource()
                if let path = store.keepCopy(url) {
                    value = path
                    set(path)
                }
                if scoped { url.stopAccessingSecurityScopedResource() }
            }
        }
    }

    private func commit() {
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        set(trimmed)
    }
}

struct FieldRow: View {
    let field: FormFieldValue
    var editable = true
    let set: (String?) -> Void
    @State private var editing = false
    @State private var value = ""

    var body: some View {
        LabeledRow(field.label, note: FieldText.source(field.source).isEmpty ? nil : FieldText.source(field.source)) {
            if editing {
                HStack(spacing: 8) {
                    TextField(field.label, text: $value)
                        .labelsHidden()
                        .textFieldStyle(.roundedBorder)
                        .frame(maxWidth: 320)
                        .onSubmit(save)
                    Button("Set", action: save).buttonStyle(.secondary).controlSize(.small).fixedSize()
                    Button("Cancel") { editing = false }.buttonStyle(.secondary).controlSize(.small).fixedSize()
                }
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(field.hasValue ? field.value : "—").textRole(.body).lineLimit(2).textSelection(.enabled)
                    Spacer(minLength: 8)
                    if editable, field.source == "override" {
                        Button("Use Profile Value") { set(nil) }.buttonStyle(.link).foregroundStyle(Theme.accent).fixedSize()
                    }
                    if editable {
                        Button("Change") {
                            value = field.hasValue ? field.value : ""
                            editing = true
                        }
                        .buttonStyle(.link)
                        .foregroundStyle(Theme.accent)
                        .fixedSize()
                    }
                }
            }
        }
    }

    private func save() {
        set(value)
        editing = false
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
    /// Quick actions: "Shorter" (true) and/or "Use Another Project" (the project's slug).
    var redraft: ((Bool, String?) -> Void)?
    /// The candidate's projects (slug, name): "Use Another Project" offers them, and "Based
    /// on" names them.
    var projects: [(slug: String, name: String)] = []

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.rowSpacing + 2) {
            Text(answer.question).textRole(.itemTitle).fixedSize(horizontal: false, vertical: true)
            if answer.status == "needs_candidate" {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "person.fill.questionmark").foregroundStyle(Theme.warning)
                    Text("Needs you: " + (answer.hasMissing ? FieldText.plain(answer.missing) : "nothing Applyant knows about you answers this"))
                        .textRole(.body)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack {
                    if let interview {
                        Button("Answer in Questions…", action: interview)
                            .buttonStyle(.secondary)
                            .help("Your answer is saved as facts, then this application is prepared again")
                    }
                    Button("Write Answer…", action: write).buttonStyle(.secondary)
                }
            } else {
                if answer.kind == "choice" && answer.hasChoice {
                    Text("Answer: \(answer.choice)").textRole(.itemTitle)
                }
                Prose(highlighted)
                if editable { flagged }
                HStack(spacing: 10) {
                    MetaLine(basedOn)
                        .help(ReviewActions.adaptedQuestion(answer) ?? basedOn)
                    Spacer(minLength: 8)
                    if let pending = ReviewActions.pending(answer) {
                        ProgressView().controlSize(.small)
                        MetaLine(pending)
                    }
                    if editable { Button("Edit…", action: write).buttonStyle(.link).foregroundStyle(Theme.accent) }
                    if editable, let redraft, answer.kind == "text", ReviewActions.pending(answer) == nil {
                        Button("Shorter") { redraft(true, nil) }.buttonStyle(.link).foregroundStyle(Theme.accent)
                            .help("Draft this answer again, about half as long, from the same facts")
                        Menu("Use Another Project") {
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
        .padding(Theme.cardPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            // The card is a control: Tab and Space (Full Keyboard Access, VoiceOver) pick it too.
            Button(action: select) { Color.clear }
                .buttonStyle(.plain)
                .accessibilityLabel("Show the evidence for “\(answer.question)”")
        }
        .glass(tint: selected ? Theme.accent : nil)
        .overlay {
            // The picked answer: its evidence is on the right.
            RoundedRectangle(cornerRadius: Theme.cornerRadius, style: .continuous)
                .strokeBorder(Theme.accentFill.opacity(selected ? 0.7 : 0), lineWidth: 1.5)
        }
        .animation(Theme.Motion.snappy, value: selected)
        .contentShape(Rectangle())
        .onTapGesture(perform: select)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    /// The answer as sent, in its paragraphs, with every flagged sentence highlighted.
    private var highlighted: AttributedString {
        let starts = ReviewRules.paragraphStarts(answer.sentences)
        var out = AttributedString()
        for (i, s) in answer.sentences.enumerated() {
            if i > 0 { out += AttributedString(starts.contains(s.index) ? "\n\n" : " ") }
            var part = AttributedString(s.text.trimmingCharacters(in: .whitespacesAndNewlines))
            if ReviewRules.flagText(s) != nil {
                // A warm wash behind what to check; red where it contradicts the facts.
                part.backgroundColor = s.flag == "contradiction" ? Theme.bad.opacity(0.32) : Theme.warning.opacity(0.26)
                part.foregroundColor = Color(.sRGB, red: 1, green: 0.95, blue: 0.86)
                part.underlineStyle = .single
                part.underlineColor = NSColor(s.flag == "contradiction" ? Theme.bad : Theme.warning)
            }
            out += part
        }
        return out
    }

    @ViewBuilder
    private var flagged: some View {
        let sentences = answer.sentences.filter { ReviewRules.flagText($0) != nil }
        if !sentences.isEmpty {
            MetaLine(sentences.count == 1 ? "1 highlighted sentence says more than your confirmed facts" : "\(sentences.count) highlighted sentences say more than your confirmed facts")
                .help(ReviewRules.flaggedIntro(sentences.count))
        }
        ForEach(sentences, id: \.index) { s in
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(s.flag == "contradiction" ? Theme.bad : Theme.warning)
                VStack(alignment: .leading, spacing: 2) {
                    Text("“\(s.text)”").textRole(.body).lineLimit(3).help(s.text)
                    Text(ReviewRules.flagReason(s)).textRole(.meta).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                let unconfirmed = s.facts.filter { $0.status == .unconfirmed }.map(\.id)
                if s.flag == "unconfirmed" && !unconfirmed.isEmpty {
                    Button("Confirm Facts") { confirmFacts(unconfirmed) }.fixedSize()
                }
                if ReviewRules.canConfirmAsWritten(s) {
                    Button("It's True") { confirmSentence(s) }
                        .fixedSize()
                        .help("Keep it as written: it's saved as a fact you stand behind")
                }
                Button("Edit…") { editSentence(s) }.fixedSize()
            }
            .buttonStyle(.secondary)
            .controlSize(.small)
        }
    }

    private var basedOn: String {
        let names = Dictionary(projects.map { ($0.slug, $0.name) }, uniquingKeysWith: { first, _ in first })
        let used = Set(answer.sentences.flatMap { $0.facts.compactMap { $0.hasProjectSlug ? $0.projectSlug : nil } })
        let facts = Set(answer.sentences.flatMap(\.factIds)).count
        var parts = used.map { MatchText.projectName($0, projects: names) }.sorted()
        parts.append("\(facts) fact\(facts == 1 ? "" : "s")")
        if answer.edited { parts.append("your edit") }
        if let adapted = ReviewActions.adaptedFrom(answer) { parts.append(adapted) }
        return "Based on " + parts.joined(separator: " · ")
    }
}

/// What the picked answer rests on: its facts, each with what can be done to it, and the
/// company's research under them.
struct EvidencePanel: View {
    let store: AppStore
    let app: Application
    let answer: Answer?
    var scrolls = true
    @State private var editing: EditRequest?

    var body: some View {
        Group {
            if scrolls {
                ScrollView { content.padding(Theme.cardPadding) }
            } else {
                content
            }
        }
        .sheet(item: $editing) { request in
            EditSheet(request: request) { text in
                Task { await request.save(text) }
            }
            .worldSheet()
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: Theme.rowSpacing + 4) {
            CardTitle(title: "Evidence", systemImage: "link")
            if let answer {
                MetaLine(answer.question)
                    .id(answer.number)
                    .transition(.opacity)
                let facts = uniqueFacts(answer)
                if facts.isEmpty { Text("No facts cited.").textRole(.body, color: Theme.secondaryText) }
                ForEach(facts, id: \.id) { fact in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(fact.hasProjectSlug ? (store.candidateProfile?.projects.first { $0.slug == fact.projectSlug }?.name ?? fact.projectSlug) : "Profile")
                            .textRole(.eyebrow)
                            .textCase(.uppercase)
                            .help("Fact \(fact.id)")
                        Text(fact.text).textRole(.body).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                        // Confirmed is the usual state: only the others say theirs.
                        if fact.status != .confirmed || app.stage != .approved && !StageRules.isSent(app.stage) {
                            HStack(spacing: 8) {
                                if fact.status != .confirmed {
                                    MetaLine(statusText(fact.status), systemImage: "questionmark.circle", tone: .warning)
                                }
                                Spacer(minLength: 0)
                                if fact.status == .unconfirmed {
                                    Button("Confirm") { Task { await store.confirmFacts(application: app.id, factIds: [fact.id]) } }
                                        .buttonStyle(.secondary)
                                        .controlSize(.small)
                                        .fixedSize()
                                }
                                if app.stage != .approved && !StageRules.isSent(app.stage) {
                                    // The fact in the candidate's words (confirmed); the answers
                                    // relying on it re-check as they do after Confirm.
                                    Button("Edit…") {
                                        editing = EditRequest(title: "The fact in your words", hint: "Saved as confirmed", text: fact.text) { text in
                                            _ = await store.editFact(fact.id, text: text, project: nil)
                                        }
                                    }
                                    .buttonStyle(.secondary)
                                    .controlSize(.small)
                                    .fixedSize()
                                }
                            }
                        }
                    }
                    .padding(10)
                    .insetSurface()
                    .transition(.opacity)
                }
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
        default: "Unknown"
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
        Card {
            VStack(alignment: .leading, spacing: Theme.rowSpacing) {
                HStack {
                    CardTitle(title: title(cv), systemImage: "doc.richtext")
                    Spacer()
                    if cv.status == "pending" || cv.status == "planned" { ProgressView().controlSize(.small) }
                }
                .shimmer(cv.status == "pending" || cv.status == "planned")
                if cv.mode == "tailored" && cv.status == "ready" {
                    if !cv.projects.isEmpty {
                        LabeledRow("Projects in order") { Text(cv.projects.map(\.name).joined(separator: ", ")).textRole(.body).fixedSize(horizontal: false, vertical: true) }
                    }
                    if !cv.skills.isEmpty {
                        LabeledRow("Skills lead with") { Text(cv.skills.prefix(6).joined(separator: ", ")).textRole(.body).fixedSize(horizontal: false, vertical: true) }
                    }
                    if let summary = cv.summary.first {
                        LabeledRow("Summary") { Text(summary.text).textRole(.body).lineLimit(3).help(summary.text) }
                    }
                    if !cv.dropped.isEmpty {
                        MetaLine("\(cv.dropped.count) line\(cv.dropped.count == 1 ? "" : "s") left out: your facts don't back \(cv.dropped.count == 1 ? "it" : "them") (Edit… shows which)")
                    }
                    if !cv.stale.isEmpty {
                        Callout(.warning, title: "Lines whose facts are no longer confirmed", detail: cv.stale.joined(separator: ", "), systemImage: "exclamationmark.triangle.fill")
                    }
                }
                if cv.hasNote { MetaLine(FieldText.plain(cv.note)) }
                HStack {
                    if let path = CvText.previewPath(app) {
                        Button("Preview") { NSWorkspace.shared.open(URL(fileURLWithPath: path)) }
                    }
                    if CvText.canEdit(app) {
                        Button("Edit…") { editing = true }
                    }
                    if app.stage == .approved || StageRules.isSent(app.stage) {
                        EmptyView()  // already sent or on its way: nothing to change
                    } else if cv.mode == "tailored" && cv.status == "skipped" {
                        Button("Try Tailored CV Again") { Task { await store.setCvMode(application: app.id, mode: "tailored") } }
                    } else if cv.mode == "tailored" {
                        Button("Use Base CV Instead") { Task { await store.setCvMode(application: app.id, mode: "base") } }
                    } else {
                        Button("Use Tailored CV") { Task { await store.setCvMode(application: app.id, mode: "tailored") } }
                    }
                }
                .buttonStyle(.secondary)
                .padding(.top, 2)
            }
        }
        .sheet(isPresented: $editing) { CvEditSheet(store: store, appId: app.id) { editing = false }.worldSheet() }
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
                    Text("Rendering…").textRole(.meta)
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
                            Text(line.section).textRole(.label, color: line.dropped ? Theme.warning : Theme.secondaryText)
                            Spacer()
                            if editingLine != line.handle, app.map(CvText.canEdit) == true {
                                Button(line.dropped ? "Put Back" : "Edit") { text = line.text; editingLine = line.handle }
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
            MetaLine("Your words are saved as a confirmed fact, and the CV is printed again.")
                .padding(16)
        }
        .frame(minWidth: 620, idealWidth: 700, minHeight: 480, idealHeight: 620)
        .showsErrors(store)
        .confirmationDialog(
            "Remove this line from the CV?",
            isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
            presenting: removing
        ) { line in
            Button("Remove Line", role: .destructive) {
                Task { await store.editCv(application: appId, line: line.handle, text: nil) }
            }
        } message: { line in
            Text("“\(line.text)” leaves this CV. The fact behind it stays in your profile.")
        }
        .task { await store.openApplication(appId) }
    }
}
