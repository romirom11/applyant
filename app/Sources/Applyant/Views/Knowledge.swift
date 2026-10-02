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

/// The profile form: every value `candidate profile set` takes, and the base CV.
struct ProfileEditor: View {
    let store: AppStore
    @State private var form = ProfileForm()
    @State private var loadedFrom: [Applyant_V1_ProfileEntry]?
    @State private var pickingCv = false
    @State private var saved = false

    var body: some View {
        Form {
            SwiftUI.Section {
                ForEach(ProfileForm.fields, id: \.key) { field in
                    TextField(field.label, text: Binding(get: { form[field.key] }, set: { form[field.key] = $0; saved = false }),
                              prompt: Text(field.hint))
                }
            } header: {
                Text("What application forms ask for")
            } footer: {
                Text("Defaults for every application; each one can still be changed in its review. GitHub logins and commit emails decide which commits are yours (comma-separated).")
                    .font(.caption).foregroundStyle(.secondary)
            }
            SwiftUI.Section("Base CV") {
                HStack {
                    Text(form[ProfileForm.baseCvKey].isEmpty ? "None chosen" : (form[ProfileForm.baseCvKey] as NSString).lastPathComponent)
                        .lineLimit(1).truncationMode(.middle)
                        .help(form[ProfileForm.baseCvKey])
                        .foregroundStyle(form[ProfileForm.baseCvKey].isEmpty ? .secondary : .primary)
                    Spacer()
                    Button("Choose…") { pickingCv = true }
                    if !form[ProfileForm.baseCvKey].isEmpty {
                        Button("Clear") { form[ProfileForm.baseCvKey] = ""; saved = false }
                    }
                }
                Text("The CV that's sent when no tailored one is, and the one tailored CVs start from. Applyant keeps its own copy of the file you choose.").font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                if saved { Label("Saved", systemImage: "checkmark.circle.fill").foregroundStyle(.green) }
                Spacer()
                Button("Revert") { load(force: true) }.disabled(!form.hasChanges)
                Button("Save profile") {
                    let f = form
                    Task { saved = await store.saveProfile(f); if saved { load(force: true) } }
                }
                .keyboardShortcut("s")
                .disabled(!form.hasChanges)
            }
        }
        .formStyle(.grouped)
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

    /// Takes the daemon's values unless the candidate is in the middle of editing.
    private func load(force: Bool) {
        guard let entries = store.candidateProfile?.profile else { return }
        if force || !form.hasChanges || loadedFrom == nil {
            form = ProfileForm(entries: entries)
            loadedFrom = entries
        }
    }
}

/// The Profile section's detail: the sources that belong to no single project (a CV, LinkedIn).
struct ProfileSourcesPane: View {
    let store: AppStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Profile sources").font(.title2.weight(.semibold))
                    Text("Your CV, LinkedIn PDF and other documents about you as a whole: their facts are sorted into projects.")
                        .foregroundStyle(.secondary)
                }
                KnowledgeSourcesSection(store: store, project: nil, sources: store.candidateProfile?.profileSources ?? [])
                FactsSection(store: store, project: nil)
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

// MARK: Projects

struct ProjectsList: View {
    @Bindable var store: AppStore
    @State private var adding = false
    @State private var newName = ""

    var body: some View {
        List(selection: $store.navigation.project) {
            if !store.unconfirmedFacts.isEmpty {
                SwiftUI.Section {
                    Button {
                        store.navigation.project = nil
                    } label: {
                        Label("Facts to confirm", systemImage: "checkmark.circle")
                            .badge(store.unconfirmedFacts.count)
                            .fontWeight(store.navigation.project == nil ? .semibold : .regular)
                    }
                    .buttonStyle(.plain)
                    .help("Every fact waiting for your confirmation, across all projects, in one list")
                }
            }
            if store.knowledgeProjects.isEmpty {
                Text("No projects yet. Add one, or import a CV: projects are drafted from it.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            let groups = store.projectGroups
            if !groups.jobs.isEmpty {
                SwiftUI.Section("Work") { ForEach(groups.jobs, id: \.id) { row($0) } }
            }
            if !groups.built.isEmpty {
                SwiftUI.Section("Projects") { ForEach(groups.built, id: \.id) { row($0) } }
            }
        }
        .navigationTitle("Projects")
        .safeAreaInset(edge: .bottom) {
            HStack {
                Button {
                    adding = true
                } label: {
                    Label("New Project", systemImage: "plus")
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .popover(isPresented: $adding, arrowEdge: .top) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("New project").font(.headline)
                        TextField("Name", text: $newName, prompt: Text("Solovei, Ordi, a position…"))
                            .textFieldStyle(.roundedBorder)
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
                .help("A position, a product or a side project: anything your experience is told through")
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(.bar)
        }
        .task {
            await store.openProfile()
            await store.openUnconfirmedFacts()
        }
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
        HStack {
            Text(p.name).lineLimit(1)
            Spacer()
            if p.unconfirmedCount > 0 {
                Text("\(p.unconfirmedCount)")
                    .font(.caption).monospacedDigit()
                    .foregroundStyle(.secondary)
                    .help("\(p.unconfirmedCount) facts to confirm")
            }
        }
        .padding(.vertical, 2)
        .tag(p.id)
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
            ContentUnavailableView(
                "Projects",
                systemImage: ApplyantKit.Section.projects.symbol,
                description: Text("Your experience is told in projects. Pick one to add a GitHub repository, a file or a page to it.")
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
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .firstTextBaseline) {
                        if renaming {
                            TextField("Name", text: $name)
                                .textFieldStyle(.roundedBorder)
                                .font(.title2)
                                .focused($nameFocused)
                                .onSubmit(rename)
                                .onExitCommand { renaming = false }
                            Button("Save", action: rename)
                                .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                            Button("Cancel") { renaming = false }
                        } else {
                            Text(project.name).font(.title2.weight(.semibold))
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
                    if project.hasSummary { Text(project.summary).foregroundStyle(.secondary) }
                    if !project.stack.isEmpty {
                        FlowLayout(spacing: 4) {
                            ForEach(project.stack, id: \.self) { ChipView(chip: Chip(text: $0, tone: .neutral)) }
                        }
                    }
                }
                KnowledgeSourcesSection(store: store, project: project.id, sources: store.projectSources[project.id] ?? [])
                FactsSection(store: store, project: project.id)
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
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
                HStack(alignment: .firstTextBaseline) {
                    Text("Facts to confirm").font(.title2.weight(.semibold))
                    Text("\(total) in \(groups.count) place\(groups.count == 1 ? "" : "s")").foregroundStyle(.secondary)
                    Spacer()
                    Button("Confirm All \(total)…") { confirmingAll = true }
                    FactsMenu(showQuotes: $showQuotes)
                }
                .help("Drafted from your CV and other sources. Confirm what's true as written, edit what isn't quite right, reject what's wrong. An application is only sent once every fact it relies on is confirmed.")
                ForEach(groups, id: \.name) { group in
                    HStack(alignment: .firstTextBaseline) {
                        Text(group.name).font(.headline)
                        Text("\(group.facts.count)").foregroundStyle(.secondary)
                        Spacer()
                        Button("Confirm These \(group.facts.count)") {
                            Task { await store.confirmFacts(group.facts.map(\.id), project: group.project) }
                        }
                        .controlSize(.small)
                        if let id = group.project {
                            Button("Open Project") { store.navigation.project = id }.controlSize(.small)
                        }
                    }
                    .padding(.top, 6)
                    ForEach(group.facts, id: \.id) { fact in
                        FactRow(store: store, fact: fact, project: group.project, showQuotes: showQuotes)
                        Divider()
                    }
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
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
    @State private var askingAssistant = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Sources").font(.headline)
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
                        Button("What Your AI Assistant Knows…") { askingAssistant = true }
                    }
                }
                .fixedSize()
                .popover(isPresented: $linking, arrowEdge: .bottom) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(project == nil ? "A page about you" : "A page about this project").font(.headline)
                        TextField("Link", text: $link, prompt: Text("https://…"))
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 320)
                            .onSubmit(addLink)
                        Text(project == nil
                            ? "A portfolio page, an article: it's read into facts. For a GitHub repository, add it to its project."
                            : "A product page, documentation, an article: it's read into facts.")
                            .font(.caption).foregroundStyle(.secondary)
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
                    .font(.callout).foregroundStyle(.secondary)
            }
            ForEach(sources, id: \.id) { s in
                SourceRow(store: store, source: s) { removing = s }
                Divider()
            }
            if let removedNote {
                Label(removedNote, systemImage: "checkmark.circle").font(.callout).foregroundStyle(.secondary)
            }
            if project == nil {
                // What an AI assistant remembers about the candidate is a profile source too.
                DisclosureGroup(AssistantNotesBox.title, isExpanded: $askingAssistant) {
                    VStack(alignment: .leading, spacing: 8) {
                        AssistantNotesBox(store: store)
                        Text(AssistantNotesBox.note).font(.caption).foregroundStyle(.secondary)
                    }
                    .padding(.top, 6)
                }
                .padding(10)
                .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
            }
            if project == nil, let note = store.baseCvNote {
                Label(note, systemImage: "doc.badge.arrow.up").font(.callout).foregroundStyle(.secondary)
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
            }
        }
        .confirmationDialog(
            "Remove \(removing.map(KnowledgeText.title) ?? "this source")?",
            isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
            presenting: removing
        ) { s in
            Button("Remove the source", role: .destructive) {
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
            Image(systemName: KnowledgeText.symbol(source)).foregroundStyle(.secondary).frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text(KnowledgeText.title(source)).lineLimit(1).truncationMode(.middle)
                Text(KnowledgeText.syncLine(source)).font(.caption).foregroundStyle(.secondary)
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
                    Text("On your GitHub").font(.subheadline.weight(.semibold))
                    ForEach(Array(shown)) { r in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Image(systemName: "chevron.left.forwardslash.chevron.right").foregroundStyle(.secondary).frame(width: 16)
                            Text(RepoText.cardLine(r)).lineLimit(2)
                            Spacer()
                            Button("Add") { Task { await store.addKnowledgeSource(to: project, r.url) } }
                                .controlSize(.small)
                                .buttonStyle(.borderedProminent)
                            Button("Not This One") { store.dismissedRepoSuggestions.insert(r.url) }
                                .controlSize(.small)
                        }
                    }
                }
                .padding(10)
                .background(Color.accentColor.opacity(0.07), in: RoundedRectangle(cornerRadius: 8))
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
                Text("Add a repository to \(projectName)").font(.headline)
                Spacer()
                Button("Cancel", action: close).keyboardShortcut(.cancelAction)
            }
            .padding(14)
            TextField("Search", text: $query, prompt: Text("Search your repositories"))
                .labelsHidden()
                .textFieldStyle(.roundedBorder)
                .focused($searching)
                .padding(.horizontal, 14)
                .padding(.bottom, 10)
            Divider()
            if let found {
                if let problem = found.problem {
                    let p = RepoText.problem(problem)
                    VStack(alignment: .leading, spacing: 8) {
                        Text(p.text).foregroundStyle(.secondary)
                        if let command = p.command {
                            HStack {
                                Text("Run this in Terminal, then open this again:").font(.caption).foregroundStyle(.secondary)
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
                            .foregroundStyle(.secondary)
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
                        Text(r.fullName).fontWeight(.medium)
                        if r.isPrivate { Image(systemName: "lock.fill").font(.caption).foregroundStyle(.secondary) }
                    }
                    let detail = RepoText.detailLine(r)
                    if !detail.isEmpty { Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                    if !r.reason.isEmpty { Text(r.reason).font(.caption).foregroundStyle(Color.accentColor) }
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
    @State private var filter = FactsText.Filter.toConfirm
    @State private var showQuotes = false

    var body: some View {
        let all = store.facts[FactsText.ref(project)] ?? []
        let shown = FactsText.shown(all, filter: filter)
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Facts").font(.headline)
                    .help("Extracted facts start unconfirmed; drafts may use them, but nothing unconfirmed is sent. An edit is saved in your words, confirmed.")
                Text(FactsText.counts(all)).font(.callout).foregroundStyle(.secondary)
                Spacer()
                Picker("Show", selection: $filter) {
                    ForEach(FactsText.Filter.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                let open = shown.filter { $0.status == .unconfirmed }.map(\.id)
                if !open.isEmpty {
                    Button("Confirm All \(open.count)") { Task { await store.confirmFacts(open, project: project) } }
                        .help("Every unconfirmed fact shown is true as written")
                }
                FactsMenu(showQuotes: $showQuotes)
            }
            if shown.isEmpty {
                Text(filter == .toConfirm ? "Nothing to confirm." : "No facts yet: add a source, or answer the interview.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            ForEach(shown, id: \.id) { fact in
                FactRow(store: store, fact: fact, project: project, showQuotes: showQuotes)
                Divider()
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

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                if editing {
                    TextField("The fact, in your words", text: $text, axis: .vertical)
                        .textFieldStyle(.roundedBorder)
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
                    Text(fact.text).textSelection(.enabled)
                        .foregroundStyle(fact.status == .rejected ? .secondary : .primary)
                        .strikethrough(fact.status == .rejected)
                    Text(FactsText.detailLine(fact)).font(.caption).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.middle)
                    if showQuotes {
                        ForEach(FactsText.quotes(fact), id: \.self) { q in
                            Text("“\(q)”").font(.caption).italic().foregroundStyle(.secondary).lineLimit(3)
                        }
                    }
                }
            }
            Spacer()
            if !editing {
                if fact.status == .unconfirmed {
                    Button("Confirm") { Task { await store.confirmFacts([fact.id], project: project) } }.controlSize(.small)
                }
                if fact.status == .rejected {
                    Button("Restore") { Task { await store.confirmFacts([fact.id], project: project) } }
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
        .help(FactsText.tooltip(fact))
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
                Text("Profile").font(.title2.bold())
                Spacer()
                Button("Done", action: close).keyboardShortcut(.cancelAction)
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
                Text("Projects and sources").font(.title2.bold())
                Spacer()
                Button("Done", action: close).keyboardShortcut(.cancelAction)
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
