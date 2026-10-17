// Profile and Projects (phase 16, app parity with the CLI for setup): the profile values
// application forms ask for and the base CV; projects (add, rename, remove) and the knowledge
// sources behind them (a GitHub repo, a file or folder, a page or a Docs link), each with
// its sync state; a source can be removed with the facts only it supported.
// The same views open as sheets from Settings and the setup's Import step. Each project (and the
// profile) lists its facts: status, kind, evidence; Confirm, Edit, Reject; to-confirm filter.
import ApplyantAPI
import ApplyantKit
import SwiftUI
import UniformTypeIdentifiers

let knowledgeFileTypes: [UTType] = [.pdf, .plainText, UTType(filenameExtension: "md") ?? .plainText, UTType(filenameExtension: "docx") ?? .data]
/// A source can also be a folder: the daemon reads the readable files in it.
let knowledgeFileOrFolderTypes: [UTType] = knowledgeFileTypes + [.folder]

// MARK: Profile

/// The profile form: every value `candidate profile set` takes, and the base CV. An empty field
/// says "Not set" (its example is under the pointer) beside an amber dot; Save and Revert sit in
/// the header, in reach whatever is scrolled.
struct ProfileEditor: View {
    let store: AppStore
    /// The Profile column's own header (title, the fields' count, Save and Revert); a sheet has
    /// its own title, and Save and Revert stand at the form's top.
    var showsHeader = false
    @State private var form = ProfileForm()
    @State private var loadedFrom: [Applyant_V1_ProfileEntry]?
    @State private var pickingCv = false
    @State private var saved = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if showsHeader {
                ModuleHeader(section: .profile, subtitle: form.summary) { actions }
                    .columnHeader()
            }
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.blockSpacing) {
                    HStack {
                        MetaLine("Defaults for every application", systemImage: "info.circle", details: Self.about)
                        Spacer()
                        if !showsHeader { actions }
                    }
                    .padding(.horizontal, Theme.Space.xs)
                    Card {
                        ForEach(ProfileForm.fields, id: \.key) { field in
                            let unset = form.isUnset(field.key)
                            VStack(alignment: .leading, spacing: 6) {
                                // The dot after the words, so every label starts at one x.
                                HStack(alignment: .firstTextBaseline, spacing: 6) {
                                    Text(field.label).textRole(.itemTitle)
                                    if unset {
                                        Circle().fill(Theme.warning).frame(width: 6, height: 6).accessibilityHidden(true)
                                    }
                                }
                                TextField(field.label, text: Binding(get: { form[field.key] }, set: { form[field.key] = $0; saved = false }),
                                          prompt: .fieldPrompt("Not set"))
                                    .labelsHidden()
                                    .textFieldStyle(.glass)
                                    .help("e.g. \(field.hint)")
                            }
                            .accessibilityElement(children: .contain)
                            .accessibilityLabel(unset ? "\(field.label), not set" : field.label)
                        }
                    }
                    Card(title: "Base CV") {
                        HStack {
                            Text(form[ProfileForm.baseCvKey].isEmpty ? "None chosen" : (form[ProfileForm.baseCvKey] as NSString).lastPathComponent)
                                .textRole(.body, color: form[ProfileForm.baseCvKey].isEmpty ? Theme.secondaryText : Theme.text)
                                .lineLimit(1).truncationMode(.middle)
                                .help(form[ProfileForm.baseCvKey])
                            Spacer()
                            Button("Choose…") { pickingCv = true }
                            if !form[ProfileForm.baseCvKey].isEmpty {
                                Button("Clear") { form[ProfileForm.baseCvKey] = ""; saved = false }
                            }
                        }
                        .buttonStyle(.secondary)
                        Text("The CV that's sent when no tailored one is, and the one tailored CVs start from. Applyant keeps its own copy of the file you choose.")
                            .textRole(.meta)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.horizontal, showsHeader ? 12 : Theme.pagePadding)
                .padding(.bottom, Theme.Space.xl)
            }
        }
        .fileImporter(isPresented: $pickingCv, allowedContentTypes: [.pdf, UTType(filenameExtension: "docx") ?? .data]) { result in
            if case let .success(url) = result {
                let scoped = url.startAccessingSecurityScopedResource()
                if let path = store.keepCopy(url) { form[ProfileForm.baseCvKey] = path; saved = false }
                if scoped { url.stopAccessingSecurityScopedResource() }
            }
        }
        .task { await store.openProfile(); load(force: false) }
        .onChange(of: store.candidateProfile?.profile) { load(force: false) }
    }

    private static let about = "Defaults for every application; each one can still be changed in its review. GitHub logins and commit emails decide which commits are yours (comma-separated)."

    /// Saved (a check), Revert and Save (⌘S).
    private var actions: some View {
        HStack(spacing: 6) {
            if saved {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.good)
                    .help("Saved")
                    .accessibilityLabel("Saved")
            }
            Button("Revert") { load(force: true) }
                .buttonStyle(.secondary)
                .disabled(!form.hasChanges)
            Button("Save") {
                let f = form
                Task { saved = await store.saveProfile(f); if saved { load(force: true) } }
            }
            .buttonStyle(.primary)
            .keyboardShortcut("s")
            .disabled(!form.hasChanges)
            .help("Save the profile (⌘S)")
        }
        .controlSize(.small)
    }

    /// Takes the daemon's values unless the candidate is in the middle of editing.
    private func load(force: Bool) {
        guard let entries = store.candidateProfile?.profile else { return }
        if force || !form.hasChanges || loadedFrom == nil {
            form = ProfileForm(entries: entries)
            loadedFrom = entries
        }
    }
}

/// The Profile section's list column: the profile form under its header.
struct ProfileColumn: View {
    let store: AppStore

    var body: some View {
        ProfileEditor(store: store, showsHeader: true)
            .navigationTitle("Profile")
    }
}

/// The Profile section's detail: the sources that belong to no single project (a CV, LinkedIn).
struct ProfileSourcesPane: View {
    let store: AppStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.blockSpacing) {
                PageHeader(
                    title: "Profile sources",
                    subtitle: "Your CV, LinkedIn PDF and other documents about you as a whole: their facts are sorted into projects."
                ) {
                    ArtView(.profile, size: 56)
                }
                KnowledgeSourcesSection(store: store, project: nil, sources: store.candidateProfile?.profileSources ?? [])
                    .padding(Theme.cardPadding).cardSurface().entrance(1)
                FactsSection(store: store, project: nil)
                    .padding(Theme.cardPadding).cardSurface().entrance(2)
            }
            .pageColumn()
        }
    }
}

// MARK: Projects

struct ProjectsList: View {
    @Bindable var store: AppStore
    @State private var adding = false
    @State private var newName = ""

    /// The "Facts to confirm" card's place in the list's selection (no project picked).
    private static let factsToConfirm: Int64 = -1

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header.columnHeader()
            list
        }
        .navigationTitle("Projects")
        .task {
            await store.openProfile()
            await store.openUnconfirmedFacts()
        }
    }

    private var header: some View {
        let count = store.knowledgeProjects.count
        let toConfirm = store.unconfirmedFacts.isEmpty ? "" : " · \(store.unconfirmedFacts.count) facts to confirm"
        return ModuleHeader(section: .projects, subtitle: "\(count) project\(count == 1 ? "" : "s")\(toConfirm)") {
            Button { adding = true } label: { Image(systemName: "plus") }
                .buttonStyle(.secondary)
                .controlSize(.small)
                .accessibilityLabel("New Project")
                .help("A position, a product or a side project: anything your experience is told through")
                .popover(isPresented: $adding, arrowEdge: .bottom) { newProject }
        }
    }

    private var newProject: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("New project").textRole(.heading)
            TextField("Name", text: $newName, prompt: .fieldPrompt("Solovei, Ordi, a position…"))
                .textFieldStyle(.glass)
                .frame(width: 240)
                .onSubmit(add)
            HStack {
                Spacer()
                Button("Cancel") { adding = false }.keyboardShortcut(.cancelAction)
                Button("Add", action: add)
                    .keyboardShortcut(.defaultAction)
                    .disabled(newName.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(14)
    }

    private var list: some View {
        let groups = store.projectGroups
        let pending = !store.unconfirmedFacts.isEmpty
        let tint = Theme.world(.projects).main
        let ids: [Int64] = (groups.jobs + groups.built).map(\.id)
        return CardList(
            selection: Binding(
                get: { store.navigation.project ?? (pending ? Self.factsToConfirm : nil) },
                set: { store.navigation.project = $0 == Self.factsToConfirm ? nil : $0 }
            ),
            order: (pending ? [Self.factsToConfirm] : []) + ids,
            tint: tint
        ) {
            if pending { factsToConfirmCard }
            if store.knowledgeProjects.isEmpty {
                Text("No projects yet. Add one, or import a CV: projects are drafted from it.")
                    .textRole(.body, color: Theme.secondaryText).padding(.horizontal, 6)
            }
            if !groups.jobs.isEmpty {
                CardListHeader(title: "Work", count: groups.jobs.count, tint: tint)
                ForEach(groups.jobs, id: \.id) { row($0) }
            }
            if !groups.built.isEmpty {
                CardListHeader(title: "Projects", count: groups.built.count, tint: tint)
                ForEach(groups.built, id: \.id) { row($0) }
            }
        }
    }

    private var factsToConfirmCard: some View {
        SelectableCard(id: Self.factsToConfirm, padding: 11) {
            HStack {
                Label("Facts to confirm", systemImage: "checkmark.circle")
                    .textRole(.rowTitle)
                Spacer()
                Text("\(store.unconfirmedFacts.count)")
                    .font(Theme.number(11, weight: .heavy))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 6).padding(.vertical, 1.5)
                    .background(Theme.warning.opacity(0.4), in: Capsule())
            }
        }
        .help("Every fact waiting for your confirmation, across all projects, in one list")
    }

    private func add() {
        let name = newName
        Task {
            if let id = await store.createProject(name) {
                newName = ""
                adding = false
                store.navigation.project = id
            }
        }
    }

    private func row(_ p: KnowledgeProject) -> some View {
        SelectableCard(id: p.id, padding: 11) {
            HStack {
                Text(p.name).textRole(.rowTitle).lineLimit(1)
                Spacer()
                if p.unconfirmedCount > 0 {
                    Text("\(p.unconfirmedCount)")
                        .font(Theme.number(11))
                        .foregroundStyle(Theme.warning)
                        .help("\(p.unconfirmedCount) facts to confirm")
                }
            }
        }
    }
}

struct ProjectDetail: View {
    let store: AppStore

    var body: some View {
        if let id = store.navigation.project, let p = store.knowledgeProject(id) {
            ProjectPane(store: store, project: p).id(id)
        } else if !store.unconfirmedFacts.isEmpty {
            FactsToConfirmPane(store: store)
        } else {
            EmptyState(
                title: "Projects",
                systemImage: ApplyantKit.Section.projects.symbol,
                detail: "Your experience is told in projects. Pick one to add a GitHub repository, a file or a page to it.",
                art: .projects
            )
        }
    }
}

private struct ProjectPane: View {
    let store: AppStore
    let project: KnowledgeProject
    @State private var renaming = false
    @State private var name = ""
    @State private var confirmingDelete = false
    @FocusState private var nameFocused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.blockSpacing) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .center, spacing: 14) {
                        ArtView(.projects, size: 56)
                            .help(project.kind == "position" ? "A job (Experience)" : "Something you built (Projects)")
                        if renaming {
                            TextField("Name", text: $name)
                                .textFieldStyle(.glass)
                                .font(Theme.TextRole.title.font)
                                .focused($nameFocused)
                                .onSubmit(rename)
                                .onExitCommand { renaming = false }
                            Button("Save", action: rename)
                                .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                            Button("Cancel") { renaming = false }
                        } else {
                            Text(project.name).textRole(.title)
                                .onTapGesture(count: 2) { startRenaming() }
                                .help("Double-click to rename")
                            Spacer()
                            Menu {
                                Button("Rename…", action: startRenaming)
                                Button("Sync All Sources") { Task { await store.syncKnowledge(project: project.id) } }
                                    .disabled(project.sourceCount == 0)
                                Divider()
                                Picker("Show on the CV as", selection: Binding(
                                    get: { project.kind == "position" ? "position" : "project" },
                                    set: { kind in Task { await store.setProjectKind(project.id, kind: kind) } }
                                )) {
                                    Text("A job (Experience)").tag("position")
                                    Text("Something I built (Projects)").tag("project")
                                }
                                Divider()
                                Button("Remove Project…", role: .destructive) { confirmingDelete = true }
                            } label: {
                                Image(systemName: "ellipsis.circle")
                            }
                            .menuStyle(.borderlessButton)
                            .fixedSize()
                            .help("Rename, sync or remove this project")
                        }
                    }
                    if project.hasSummary { Prose(project.summary, size: .compact) }
                    if !project.stack.isEmpty {
                        FlowLayout(spacing: 4) {
                            ForEach(project.stack, id: \.self) { ChipView(chip: Chip(text: $0, tone: .neutral)) }
                        }
                    }
                }
                .entrance(0)
                KnowledgeSourcesSection(store: store, project: project.id, sources: store.projectSources[project.id] ?? [])
                    .padding(Theme.cardPadding).cardSurface().entrance(1)
                FactsSection(store: store, project: project.id)
                    .padding(Theme.cardPadding).cardSurface().entrance(2)
            }
            .pageColumn()
        }
        .task { await store.openProject(project.id) }
        .confirmationDialog("Remove \(project.name)?", isPresented: $confirmingDelete) {
            Button("Remove the project, its sources and facts", role: .destructive) {
                Task { await store.deleteProject(project.id) }
            }
        } message: {
            Text("Its \(project.sourceCount) sources and \(project.factCount) facts go with it. Applications already sent keep what they said.")
        }
    }

    private func startRenaming() {
        name = project.name
        renaming = true
        nameFocused = true
    }

    private func rename() {
        let n = name.trimmingCharacters(in: .whitespaces)
        guard !n.isEmpty else { return }
        if n == project.name {
            renaming = false
            return
        }
        Task { if await store.renameProject(project.id, to: n) { renaming = false } }
    }
}

/// Every fact still to confirm, across the projects and the profile, in one list.
struct FactsToConfirmPane: View {
    let store: AppStore
    @State private var confirmingAll = false
    @State private var showQuotes = false

    var body: some View {
        let groups = store.unconfirmedFactGroups
        let total = store.unconfirmedFacts.count
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                PageHeader(title: "Facts to confirm", subtitle: "\(total) in \(groups.count) place\(groups.count == 1 ? "" : "s")") {
                    IconTile(systemImage: "checkmark.seal.fill", size: 56)
                } trailing: {
                    Button("Confirm All \(total)…") { confirmingAll = true }.buttonStyle(.primary)
                    FactsMenu(showQuotes: $showQuotes)
                }
                .help("Drafted from your CV and other sources. Confirm what's true as written, edit what isn't quite right, reject what's wrong. An application is only sent once every fact it relies on is confirmed.")
                ForEach(groups, id: \.name) { group in
                    HStack(alignment: .firstTextBaseline) {
                        Text(group.name).textRole(.heading)
                        Text("\(group.facts.count)").textRole(.meta)
                        Spacer()
                        Button("Confirm These \(group.facts.count)") {
                            Task { await store.confirmFacts(group.facts.map(\.id), project: group.project) }
                        }
                        .buttonStyle(.secondary)
                        .controlSize(.small)
                        if let id = group.project {
                            Button("Open Project") { store.navigation.project = id }.buttonStyle(.secondary).controlSize(.small)
                        }
                    }
                    .padding(.top, 6)
                    ForEach(group.facts, id: \.id) { fact in
                        FactRow(store: store, fact: fact, project: group.project, showQuotes: showQuotes)
                        Divider().overlay(Theme.hairline)
                    }
                }
            }
            .pageColumn()
        }
        .task { await store.openUnconfirmedFacts() }
        .confirmationDialog("Mark all \(total) facts as true?", isPresented: $confirmingAll) {
            Button("Confirm \(total) facts") {
                Task { await store.confirmFacts(store.unconfirmedFacts.map(\.id), project: nil) }
            }
        } message: {
            Text("They're marked true for good, and applications may state them. Read them first; a confirmed fact can still be edited or rejected later.")
        }
    }
}

/// A project's (or the profile's) sources with their sync state, and adding one.
struct KnowledgeSourcesSection: View {
    let store: AppStore
    /// nil: the profile's sources.
    let project: Int64?
    let sources: [KnowledgeSource]
    @State private var picking = false
    @State private var linking = false
    @State private var link = ""
    @State private var pickingRepo = false
    @State private var removing: KnowledgeSource?
    @State private var removedNote: String?
    /// Times "What Your AI Assistant Knows…" was picked: each one opens its card afresh.
    @State private var askingAssistant = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                CardTitle(title: "Sources", systemImage: "tray.full")
                    .help("Each source is read in the background into facts for you to confirm; nothing unconfirmed is ever sent.")
                Spacer()
                Menu("Add Source…") {
                    if project != nil {
                        Button("GitHub Repository…") { pickingRepo = true }
                    }
                    Button("File or Folder…") { picking = true }
                    Button("Link…") { linking = true }
                    if project == nil {
                        Divider()
                        Button("What Your AI Assistant Knows…") { askingAssistant += 1 }
                    }
                }
                .menuStyle(.button)
                .buttonStyle(.secondary)
                .fixedSize()
                .popover(isPresented: $linking, arrowEdge: .bottom) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(project == nil ? "A page about you" : "A page about this project").textRole(.heading)
                        TextField("Link", text: $link, prompt: .fieldPrompt("https://…"))
                            .textFieldStyle(.glass)
                            .frame(width: 320)
                            .onSubmit(addLink)
                        Text(project == nil
                            ? "A portfolio page, an article: it's read into facts. For a GitHub repository, add it to its project."
                            : "A product page, documentation, an article: it's read into facts.")
                            .textRole(.meta).fixedSize(horizontal: false, vertical: true).frame(width: 320, alignment: .leading)
                        HStack {
                            Spacer()
                            Button("Cancel") { linking = false }.keyboardShortcut(.cancelAction)
                            Button("Add", action: addLink)
                                .keyboardShortcut(.defaultAction)
                                .disabled(link.trimmingCharacters(in: .whitespaces).isEmpty)
                        }
                    }
                    .padding(14)
                }
            }
            if let id = project {
                RepoSuggestionsCard(store: store, project: id, sources: sources)
            }
            if sources.isEmpty {
                Text(project == nil
                    ? "Nothing yet. Add your CV or LinkedIn PDF."
                    : "Nothing yet. Add the repository, a file or a page: its facts make your answers specific.")
                    .textRole(.body, color: Theme.secondaryText)
            }
            ForEach(sources, id: \.id) { s in
                SourceRow(store: store, source: s) { removing = s }
                Divider().overlay(Theme.hairline)
            }
            if let removedNote {
                MetaLine(removedNote, systemImage: "checkmark.circle", tone: .good)
            }
            if project == nil {
                // What an AI assistant remembers about the candidate is a profile source too.
                FoldingCard(title: AssistantNotesBox.title, expanded: askingAssistant > 0, surface: Theme.insetFill) {
                    VStack(alignment: .leading, spacing: 8) {
                        AssistantNotesBox(store: store)
                        Text(AssistantNotesBox.note).textRole(.meta).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .id(askingAssistant)
            }
            if project == nil, let note = store.baseCvNote {
                MetaLine(note, systemImage: "doc.badge.arrow.up")
            }
        }
        .task(id: project) {
            // The project's repositories are looked up once, for the suggestion card.
            if let id = project, !sources.contains(where: { $0.kind == .github }) {
                await store.loadRepoSuggestions(project: id)
            }
        }
        .fileImporter(isPresented: $picking, allowedContentTypes: knowledgeFileOrFolderTypes) { result in
            // A picked file is copied into Applyant's own folder; a folder is read where it is.
            if case let .success(url) = result {
                let scoped = url.startAccessingSecurityScopedResource()
                Task {
                    await store.importFile(url, to: project)
                    if scoped { url.stopAccessingSecurityScopedResource() }
                }
            }
        }
        .sheet(isPresented: $pickingRepo) {
            if let id = project {
                RepoPickerSheet(store: store, project: id, projectName: store.knowledgeProject(id)?.name ?? "this project") {
                    pickingRepo = false
                }
                .worldSheet()
            }
        }
        .confirmationDialog(
            "Remove \(removing.map(KnowledgeText.title) ?? "this source")?",
            isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
            presenting: removing
        ) { s in
            Button("Remove Source", role: .destructive) {
                Task {
                    if let n = await store.deleteSource(s.id) { removedNote = KnowledgeText.removedLine(factsRemoved: n) }
                }
            }
        } message: { s in
            Text("What was read from \(s.folder ? "this folder" : "it") goes, with the facts found only in this source. Facts in your own words stay, and applications already sent keep what they said.")
        }
    }

    private func addLink() {
        let value = link
        Task {
            if await store.addKnowledgeSource(to: project, value) {
                link = ""
                linking = false
            }
        }
    }
}

/// One source: what it is, where its reading stands, and its actions behind a menu.
private struct SourceRow: View {
    let store: AppStore
    let source: KnowledgeSource
    let remove: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: KnowledgeText.symbol(source)).foregroundStyle(Theme.secondaryText).frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text(KnowledgeText.title(source)).textRole(.itemTitle).lineLimit(1).truncationMode(.middle)
                Text(KnowledgeText.syncHeadline(source)).textRole(.meta)
                    .lineLimit(1).truncationMode(.tail)
            }
            .help("\(KnowledgeText.kindName(source)) · \(source.locator)\n\(KnowledgeText.syncLine(source))")
            Spacer()
            ChipView(chip: KnowledgeText.chip(source))
            Menu {
                Button("Sync Now") { Task { await store.syncKnowledge(source: source.id) } }
                Divider()
                Button("Remove…", role: .destructive, action: remove)
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
        }
        .padding(.vertical, 2)
    }
}

/// "On your GitHub: romirom11/soloveim · pushed 2 months ago — its name is close to Solovei",
/// for a project with no repository yet.
private struct RepoSuggestionsCard: View {
    let store: AppStore
    let project: Int64
    let sources: [KnowledgeSource]

    var body: some View {
        let found = store.repoSuggestions[project]
        let shown = (found?.matches ?? []).filter { !store.dismissedRepoSuggestions.contains($0.url) }.prefix(3)
        Group {
            if !sources.contains(where: { $0.kind == .github }), !shown.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("On your GitHub").textRole(.itemTitle)
                    ForEach(Array(shown)) { r in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Image(systemName: "chevron.left.forwardslash.chevron.right").foregroundStyle(Theme.secondaryText).frame(width: 16)
                            Text(RepoText.cardLine(r)).textRole(.body).lineLimit(2)
                            Spacer()
                            Button("Add") { Task { await store.addKnowledgeSource(to: project, r.url) } }
                                .controlSize(.small)
                                .buttonStyle(.primary)
                            Button("Not This One") { store.dismissedRepoSuggestions.insert(r.url) }
                                .buttonStyle(.secondary)
                                .controlSize(.small)
                        }
                    }
                }
                .padding(10)
                .insetSurface(tint: Theme.accent)
            }
        }
    }
}

/// Picking one of the candidate's repositories for a project: the ones that look like it first.
struct RepoPickerSheet: View {
    let store: AppStore
    let project: Int64
    let projectName: String
    let close: () -> Void
    @State private var query = ""
    @State private var adding: String?
    @FocusState private var searching: Bool

    var body: some View {
        let found = store.repoSuggestions[project]
        VStack(spacing: 0) {
            HStack {
                Text("Add a repository to \(projectName)").textRole(.heading)
                Spacer()
                Button("Cancel", action: close).keyboardShortcut(.cancelAction)
            }
            .padding(14)
            TextField("Search", text: $query, prompt: .fieldPrompt("Search your repositories"))
                .labelsHidden()
                .textFieldStyle(.glass)
                .focused($searching)
                .padding(.horizontal, 14)
                .padding(.bottom, 10)
            Divider()
            if let found {
                if let problem = found.problem {
                    let p = RepoText.problem(problem)
                    VStack(alignment: .leading, spacing: 8) {
                        Text(p.text).textRole(.body, color: Theme.secondaryText)
                        if let command = p.command {
                            HStack {
                                Text("Run this in Terminal, then open this again:").textRole(.meta)
                                CopyCommand(command: command)
                            }
                        }
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                } else {
                    let matches = RepoText.search(query, in: found.matches)
                    let others = RepoText.search(query, in: found.others)
                    if matches.isEmpty && others.isEmpty {
                        Text(found.isEmpty ? "No repositories on \(found.accounts.joined(separator: ", ")) that aren't a source already." : "Nothing matches “\(query)”")
                            .textRole(.body, color: Theme.secondaryText)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else {
                        List {
                            if !matches.isEmpty {
                                SwiftUI.Section("Looks like \(projectName)") {
                                    ForEach(matches) { row($0) }
                                }
                            }
                            if !others.isEmpty {
                                SwiftUI.Section(matches.isEmpty ? "Your repositories" : "Other repositories") {
                                    ForEach(others) { row($0) }
                                }
                            }
                        }
                        .listStyle(.inset)
                        .scrollContentBackground(.hidden)
                    }
                }
            } else {
                ProgressView("Listing your repositories…").controlSize(.small)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(width: 560, height: 480)
        .task { await store.loadRepoSuggestions(project: project); searching = true }
    }

    private func row(_ r: RepoSuggestion) -> some View {
        Button {
            adding = r.url
            Task {
                if await store.addKnowledgeSource(to: project, r.url) { close() }
                adding = nil
            }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        Text(r.fullName).textRole(.itemTitle)
                        if r.isPrivate { Image(systemName: "lock.fill").font(.system(size: 11)).foregroundStyle(Theme.secondaryText) }
                    }
                    let detail = RepoText.detailLine(r)
                    if !detail.isEmpty { Text(detail).textRole(.meta).lineLimit(2) }
                    if !r.reason.isEmpty { Text(r.reason).textRole(.meta, color: Theme.accent) }
                }
                Spacer()
                if adding == r.url { ProgressView().controlSize(.small) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(adding != nil)
    }
}

// MARK: Facts

/// The facts browser: a project's (or the profile's) facts with their status, kind and evidence;
/// Confirm, Edit (saved confirmed, in your words) and Reject.
struct FactsSection: View {
    let store: AppStore
    /// nil: the profile's facts.
    let project: Int64?
    /// Picked by the candidate; until then To confirm while anything is, else All.
    @State private var picked: FactsText.Filter?
    @State private var showQuotes = false

    var body: some View {
        let all = store.facts[FactsText.ref(project)] ?? []
        let filter = picked ?? (all.contains { $0.status == .unconfirmed } ? .toConfirm : .all)
        let shown = FactsText.shown(all, filter: filter)
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                CardTitle(title: "Facts", systemImage: "checkmark.seal")
                    .help("Extracted facts start unconfirmed; drafts may use them, but nothing unconfirmed is sent. An edit is saved in your words, confirmed.")
                MetaLine(FactsText.counts(all))
                Spacer()
                PillPicker(items: FactsText.Filter.allCases, title: \.rawValue, selection: Binding(get: { filter }, set: { picked = $0 }), accessibilityLabel: "Show")
                    .fixedSize()
                let open = shown.filter { $0.status == .unconfirmed }.map(\.id)
                if !open.isEmpty {
                    Button("Confirm All \(open.count)") { Task { await store.confirmFacts(open, project: project) } }
                        .buttonStyle(.secondary)
                        .help("Every unconfirmed fact shown is true as written")
                }
                FactsMenu(showQuotes: $showQuotes)
            }
            if shown.isEmpty {
                Text(filter == .toConfirm ? "Nothing to confirm." : "No facts yet: add a source, or answer the interview.")
                    .textRole(.body, color: Theme.secondaryText)
            }
            ForEach(shown, id: \.id) { fact in
                FactRow(store: store, fact: fact, project: project, showQuotes: showQuotes)
                Divider().overlay(Theme.hairline)
            }
        }
        .task(id: project) { await store.openFacts(project: project) }
        .onChange(of: store.knowledgeProject(project ?? -1)?.factCount) { Task { await store.openFacts(project: project) } }
    }
}

/// The facts list's menu: whether each fact shows the words it was read from.
private struct FactsMenu: View {
    @Binding var showQuotes: Bool

    var body: some View {
        Menu {
            Toggle("Show Quotes", isOn: $showQuotes)
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("Show the words each fact was read from")
    }
}

struct FactRow: View {
    let store: AppStore
    let fact: Fact
    let project: Int64?
    /// The evidence's own words under each fact (otherwise they're in the row's tooltip).
    var showQuotes = false
    @State private var editing = false
    @State private var text = ""
    @State private var confirmingReject = false

    /// The project a fact belongs to, when it isn't the one on screen.
    private var otherProject: String? {
        guard fact.hasProjectID, fact.projectID != project else { return nil }
        return store.knowledgeProject(fact.projectID)?.name ?? (fact.hasProjectSlug ? fact.projectSlug : nil)
    }

    /// What kind of fact it is, where it came from and its first piece of evidence.
    private var reason: String {
        var parts = [FactsText.kind(fact)]
        if let origin = FactsText.origin(fact) { parts.append(origin) }
        if let e = fact.evidence.first { parts.append(FactsText.evidence(e) + (fact.evidence.count > 1 ? " (+\(fact.evidence.count - 1))" : "")) }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                if editing {
                    TextField("The fact, in your words", text: $text, axis: .vertical)
                        .textFieldStyle(.glass)
                        .lineLimit(2 ... 6)
                    HStack {
                        Spacer()
                        Button("Cancel") { editing = false }.keyboardShortcut(.cancelAction)
                        Button("Save, Confirmed") {
                            let t = text
                            Task { if await store.editFact(fact.id, text: t, project: project) { editing = false } }
                        }
                        .keyboardShortcut(.defaultAction)
                        .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                } else {
                    // A claim with its evidence beside it; the status in the margin only when
                    // it isn't simply confirmed.
                    EvidenceRow(
                        fact.text,
                        eyebrow: otherProject,
                        reason: reason,
                        margin: fact.status == .unconfirmed ? "To confirm" : fact.status == .rejected ? "Rejected" : nil
                    )
                    .opacity(fact.status == .rejected ? 0.7 : 1)
                    if showQuotes {
                        ForEach(FactsText.quotes(fact), id: \.self) { q in
                            Text("“\(q)”").textRole(.meta).italic().lineLimit(3)
                        }
                    }
                }
            }
            Spacer()
            if !editing {
                if fact.status == .unconfirmed {
                    Button("Confirm") { Task { await store.confirmFacts([fact.id], project: project) } }
                        .buttonStyle(.secondary)
                        .controlSize(.small)
                }
                if fact.status == .rejected {
                    Button("Restore") { Task { await store.confirmFacts([fact.id], project: project) } }
                        .buttonStyle(.secondary)
                        .controlSize(.small)
                        .help("Takes the rejection back: the fact is confirmed and can be used again")
                } else {
                    Menu {
                        Button("Edit…") { text = fact.text; editing = true }
                        Divider()
                        Button("Reject…", role: .destructive) { confirmingReject = true }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                }
            }
        }
        .padding(.vertical, 3)
        .help(FactsText.tooltip(fact) + "\n\nFact \(fact.id)")
        .confirmationDialog("Reject this fact?", isPresented: $confirmingReject) {
            Button("Reject", role: .destructive) { Task { await store.rejectFacts([fact.id], project: project) } }
        } message: {
            Text("It won't be used in answers or CVs from now on. Applications already sent keep what they said.")
        }
    }
}

// MARK: Sheets (Settings and the setup's Import step)

struct ProfileSheet: View {
    let store: AppStore
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Profile").textRole(.title)
                Spacer()
                Button("Done", action: close).buttonStyle(.secondary).keyboardShortcut(.cancelAction)
            }
            .padding(16)
            ProfileEditor(store: store)
        }
        .frame(minWidth: 560, idealWidth: 620, minHeight: 560, idealHeight: 720)
        .showsErrors(store)
    }
}

struct ProjectsSheet: View {
    let store: AppStore
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Projects and sources").textRole(.title)
                Spacer()
                Button("Done", action: close).buttonStyle(.secondary).keyboardShortcut(.cancelAction)
            }
            .padding(16)
            HSplitView {
                ProjectsList(store: store).frame(minWidth: 240, idealWidth: 280)
                ProjectDetail(store: store).frame(minWidth: 420)
            }
        }
        .frame(minWidth: 800, idealWidth: 900, minHeight: 520, idealHeight: 640)
        .showsErrors(store)
    }
}
