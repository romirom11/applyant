// The agent interview: what waits for an answer, each project with what its facts don't show,
// and one conversation at a time. Answers become confirmed facts; an application question's
// answer prepares its application again.
import ApplyantKit
import SwiftUI

struct InterviewList: View {
    let store: AppStore

    var body: some View {
        let rows = store.interviewRows
        let world = Theme.world(.interview)
        VStack(alignment: .leading, spacing: 0) {
            ModuleHeader(section: .interview, subtitle: rows.waiting.isEmpty ? "Nothing waits for an answer" : "\(rows.waiting.count) waiting for your answer")
                .columnHeader()
            if rows.waiting.isEmpty && rows.projects.isEmpty {
                EmptyState(
                    title: "No projects yet",
                    systemImage: ApplyantKit.Section.interview.symbol,
                    detail: "Questions are asked about your projects. Import your CV or add a project first.",
                    art: .projects
                ) {
                    Button("Open Projects") {
                        store.showOnboarding = false
                        store.navigation.section = .projects
                    }
                    .buttonStyle(.primary)
                    if store.showOnboarding {
                        Button("Back to Import") { store.onboarding.open(.importing) }.buttonStyle(.secondary)
                    }
                }
            } else {
                // One header per application: its questions under it, with nothing repeated.
                let groups = InterviewText.groups(rows.waiting)
                CardList(
                    selection: Binding(get: { store.navigation.interview }, set: { store.navigation.interview = $0 }),
                    order: groups.flatMap { $0.rows.map(\.target) } + rows.projects.map(\.target),
                    tint: world.main
                ) {
                    ForEach(groups) { group in
                        CardListHeader(title: group.title, count: group.rows.count)
                            .lineLimit(1)
                            .help(group.title)
                        ForEach(group.rows) { row in
                            SelectableCard(id: row.target) { InterviewRowView(row: row) }
                        }
                    }
                    if !rows.projects.isEmpty {
                        CardListHeader(title: "Projects", count: rows.projects.count, tint: world.main)
                        ForEach(rows.projects) { row in
                            SelectableCard(id: row.target) { InterviewRowView(row: row) }
                        }
                    }
                }
            }
        }
        .navigationTitle("Questions for you")
    }
}

struct InterviewRowView: View {
    let row: InterviewRow

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(row.title).textRole(.rowTitle).lineLimit(2)
            // An application's question needs only itself: the header names the application.
            if case .project = row.target, !row.subtitle.isEmpty {
                Text(row.subtitle).textRole(.meta).lineLimit(2)
            }
            if !row.chips.isEmpty {
                HStack(spacing: 4) { ForEach(row.chips, id: \.text) { ChipView(chip: $0) } }.padding(.top, 2)
            }
        }
    }
}

struct InterviewThreadView: View {
    let store: AppStore
    let target: InterviewTarget
    @State private var answer = ""
    @State private var dictation = Dictation()

    var body: some View {
        Group {
            if let thread = store.interviewThreads[target] {
                VStack(spacing: 0) {
                    ScrollViewReader { proxy in
                        ScrollView {
                            VStack(alignment: .leading, spacing: Theme.blockSpacing) {
                                header(thread)
                                ForEach(Array(thread.questions.enumerated()), id: \.element.id) { index, q in
                                    QuestionExchange(question: q).id(q.id).entrance(index + 1)
                                }
                                footer(thread)
                            }
                            .animation(Theme.Motion.smooth, value: thread.questions.map(\.status))
                            .pageColumn()
                        }
                        .onChange(of: thread.questions.last?.id) { _, last in
                            if let last { withAnimation { proxy.scrollTo(last, anchor: .bottom) } }
                        }
                    }
                    if let open = InterviewText.openQuestion(thread) {
                        composer(open)
                    }
                }
            } else {
                ProgressView()
            }
        }
        .task(id: target) { await store.openInterview(target) }
    }

    // MARK: Pieces

    @ViewBuilder
    private func header(_ thread: InterviewThread) -> some View {
        if thread.hasProject {
            let p = thread.project
            PageHeader(
                title: p.project.name,
                subtitle: p.gaps.isEmpty
                    ? "Its facts cover your role, what you built, the team and the results."
                    : "Its facts don't show yet: " + p.gapLabels.joined(separator: "; ") + "."
            ) { ArtView(.projects, size: 56) }
        } else if let first = thread.questions.first {
            PageHeader(
                title: first.hasApplication ? first.application : "An application",
                subtitle: "Nothing Applyant knows answers this yet. Your answer is saved as facts for this application and later ones."
            ) { ArtView(.questions, size: 56) }
        }
    }

    @ViewBuilder
    private func footer(_ thread: InterviewThread) -> some View {
        if thread.pending && InterviewText.openQuestion(thread) == nil {
            HStack(spacing: 10) {
                TypingDots()
                Text(thread.questions.contains { $0.status == "processing" } ? "Reading your answer…" : "Writing a question…")
                    .textRole(.body, color: Theme.secondaryText)
            }
            .bubble(mine: false)
            .transition(.opacity.combined(with: .move(edge: .bottom)))
        } else if InterviewText.canAskMore(thread) {
            let p = thread.project
            HStack {
                if !thread.questions.isEmpty {
                    Text(p.gaps.isEmpty ? "That's all for now." : "Nothing more asked for now.")
                        .textRole(.body, color: Theme.secondaryText)
                }
                Spacer()
                Button {
                    Task { await store.startInterview(project: p.project.id) }
                } label: {
                    Label(p.asked == 0 ? "Start the Interview" : "Ask Me More", systemImage: "sparkles")
                }
                .buttonStyle(.primary)
            }
        } else if !thread.hasProject, let q = thread.questions.last, q.hasApplicationID, q.status != "open", q.status != "processing" {
            HStack {
                Text(q.status == "dismissed"
                    ? "Left for you to answer in review."
                    : "Your answer went to the application; it's prepared again with it.")
                    .textRole(.body, color: Theme.secondaryText)
                Spacer()
                if let app = store.applications[q.applicationID] {
                    Button("Open Application") {
                        store.navigation.showReview(app)
                    }
                    .buttonStyle(.secondary)
                }
            }
        }
    }

    /// The one composer (Chat's too): Later and dictation beside Send.
    private func composer(_ q: InterviewQuestion) -> some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            if case let .failed(why) = dictation.state {
                MetaLine(why, systemImage: "exclamationmark.triangle.fill", tone: .warning)
            } else if dictation.listening {
                MetaLine("Listening: speak, then press Stop. You can correct the text before sending.", systemImage: "waveform")
            }
            Composer(
                text: $answer,
                placeholder: "Your answer…",
                canSend: !answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ) {
                Button("Later") {
                    dictation.stop()
                    Task { await store.dismissInterview(target, question: q.id) }
                }
                .buttonStyle(.secondary)
                .help(q.hasApplicationID ? "You can write this answer yourself in review" : "Skip this question for now")
                DictateButton(dictation: dictation, spoken: store.spokenLanguages, text: $answer)
            } send: {
                send(q)
            }
            .help("Your answer, in your own words: it's saved as a fact you stand behind")
        }
        .padding(Theme.cardPadding)
        .glass(radius: Theme.panelRadius)
        .pageColumn()
        .task { await store.loadSpokenLanguages() }
        .onDisappear { dictation.stop() }
    }

    private func send(_ q: InterviewQuestion) {
        let text = answer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        dictation.stop()
        answer = ""
        Task { await store.answerInterview(target, question: q.id, text: text) }
    }
}

/// A question and what came of it: Applyant's bubble (why it's asked folded under it), the
/// candidate's answer, and the facts it was saved as.
private struct QuestionExchange: View {
    let question: InterviewQuestion
    @State private var showsWhy = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let q = question
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "sparkles")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.brand)
                    .padding(.top, 2)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: Theme.Space.xs) {
                    Text(q.text)
                        .textRole(.prose)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    if q.hasContext, !q.context.isEmpty {
                        DisclosureLine("Why it's asked", isExpanded: $showsWhy)
                        if showsWhy {
                            Text(q.context)
                                .textRole(.body, color: Theme.secondaryText)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                                .transition(.reveal(reduceMotion: reduceMotion))
                        }
                    }
                }
            }
            .bubble(mine: false)
            // The page is as wide as the window; a message keeps a reading measure.
            .frame(maxWidth: Theme.measure, alignment: .leading)
            .padding(.trailing, 60)
            .animation(Theme.Motion.pick(Theme.Motion.disclose, reduceMotion: reduceMotion), value: showsWhy)

            if q.hasAnswer {
                HStack {
                    Spacer(minLength: 60)
                    Text(q.answer)
                        .textRole(.prose, color: .white)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .bubble(mine: true)
                        .frame(maxWidth: Theme.measure, alignment: .trailing)
                }
            }
            switch q.status {
            case "processing":
                MetaLine("Reading your answer…", systemImage: "hourglass")
            case "dismissed":
                MetaLine("Left for later", systemImage: "clock")
            case "open" where q.hasNote:
                Callout(.warning, title: q.note)
            default:
                EmptyView()
            }
            if !q.facts.isEmpty {
                VStack(alignment: .leading, spacing: Theme.Space.xs) {
                    Text("Saved as facts").textRole(.label)
                    ForEach(q.facts, id: \.id) { f in
                        Label {
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Text(f.text).textRole(.body)
                                if f.hasProjectSlug { Text(f.projectSlug).textRole(.meta) }
                            }
                        } icon: {
                            Image(systemName: "checkmark.seal.fill").foregroundStyle(Theme.good)
                        }
                    }
                }
                .padding(.leading, 26)
            } else if q.status == "answered" {
                Text(q.hasNote ? q.note : "Nothing saved from this answer")
                    .textRole(.meta)
                    .padding(.leading, 26)
            }
        }
    }
}

/// The microphone button and its language: speaks the answer into the field.
private struct DictateButton: View {
    let dictation: Dictation
    /// Language codes from the candidate's preferences ("uk", "en").
    let spoken: [String]
    @Binding var text: String

    var body: some View {
        let offered = DictationLanguages.offered(supported: Dictation.supported, spoken: spoken, system: Locale.preferredLanguages)
        HStack(spacing: 4) {
            Button {
                if dictation.listening {
                    dictation.stop()
                } else {
                    if dictation.locale == nil || !offered.contains(dictation.locale ?? "") {
                        dictation.locale = DictationLanguages.initial(saved: dictation.locale, offered: offered)
                    }
                    dictation.start(base: text) { text = $0 }
                }
            } label: {
                Label(dictation.listening ? "Stop" : "Dictate", systemImage: dictation.listening ? "stop.circle.fill" : "mic")
            }
            .tint(dictation.listening ? Theme.bad : nil)
            .keyboardShortcut("d", modifiers: .command)
            .help("Speak your answer (⌘D starts and stops): it's turned into text here by the Mac's speech recognition")
            Picker("Language", selection: Binding(
                get: { DictationLanguages.initial(saved: dictation.locale, offered: offered) ?? "" },
                set: { dictation.locale = $0 }
            )) {
                ForEach(offered, id: \.self) { Text(DictationLanguages.name($0, among: offered)).tag($0) }
            }
            .labelsHidden()
            .fixedSize()
            .disabled(dictation.listening)
            .help("The language you'll speak")
        }
    }
}
