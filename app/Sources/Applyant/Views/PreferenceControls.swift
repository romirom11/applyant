// The Preferences controls, shared by Settings → Edit preferences and the setup's Preferences
// step: job titles as chips you type, languages as rows, countries picked by name from a list
// you can search. `text` holds the daemon's own wire values by key, so callers save it as it is;
// nobody sees or types those forms (ApplyantKit/PreferenceInputs.swift reads and writes them).
import ApplyantKit
import SwiftUI

struct PreferenceControls: View {
    @Binding var text: [String: String]
    @Binding var remote: String
    @Binding var dealbreakers: Set<String>
    /// Salary floor and employment type (the setup's step leaves them for Settings).
    var complete = true
    /// Where a suggested value came from ("From your CV: …"), by key.
    var reasons: [String: String] = [:]
    /// Job titles the CV shows, offered as one-click additions.
    var suggestedRoles: [String] = []

    var body: some View {
        SwiftUI.Section {
            RolesEditor(text: binding("roles"), suggestions: suggestedRoles)
            picks("Seniority", key: "seniority", choices: PreferenceChoices.seniority, empty: "Any level")
            if complete {
                picks("Employment", key: "employment", choices: PreferenceChoices.employment, empty: "Any type")
            }
        } header: {
            Text("What you're looking for")
        } footer: {
            Text("Nothing picked means no preference.").font(.caption).foregroundStyle(.secondary)
        }
        SwiftUI.Section("Where") {
            BasedInRow(country: binding("based_in"), city: binding("based_city"), reason: reasons["based_in"] ?? reasons["based_city"])
            CountriesRow(text: binding("locations"), home: text["based_in"] ?? "")
            Picker("Remote", selection: $remote) {
                ForEach(PreferenceChoices.remote, id: \.key) { Text($0.title).tag($0.key) }
            }
            .pickerStyle(.segmented)
        }
        SwiftUI.Section("Pay") {
            field("Target salary", key: "salary", prompt: "4500 EUR/month", note: "Gross, per month or per year: 4500 EUR/month or 60k EUR/year.")
            if complete {
                field("Salary floor", key: "salary_floor", prompt: "3500 EUR/month", note: "Optional. A posting that pays less than this is never prepared.")
            }
        }
        SwiftUI.Section("Languages you speak") {
            LanguagesEditor(text: binding("languages"), working: binding("working_languages"), reason: reasons["languages"])
        }
        SwiftUI.Section {
            ForEach(PreferenceChoices.dealbreakers, id: \.key) { d in
                Toggle(d.title, isOn: Binding(
                    get: { dealbreakers.contains(d.key) },
                    set: { on in if on { dealbreakers.insert(d.key) } else { dealbreakers.remove(d.key) } }
                ))
            }
        } header: {
            Text("Dealbreakers")
        } footer: {
            Text("Nothing is a dealbreaker unless you switch it on: a posting that breaks one is never prepared.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func binding(_ key: String) -> Binding<String> {
        Binding(get: { text[key] ?? "" }, set: { text[key] = $0 })
    }

    @ViewBuilder
    private func field(_ label: String, key: String, prompt: String, note: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            TextField(label, text: binding(key), prompt: Text(prompt))
            Text(note).font(.caption).foregroundStyle(.secondary)
            if let reason = reasons[key] { Text(reason).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
        }
    }

    /// Several of a fixed set, as buttons that stay pressed.
    @ViewBuilder
    private func picks(_ label: String, key: String, choices: [Choice], empty: String) -> some View {
        let chosen = Set(PreferenceChoices.keys(text[key] ?? ""))
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(label)
                Spacer()
                Text(chosen.isEmpty ? empty : "\(chosen.count) picked").font(.caption).foregroundStyle(.secondary)
            }
            FlowLayout(spacing: 6) {
                ForEach(choices, id: \.key) { c in
                    Toggle(c.title, isOn: Binding(
                        get: { chosen.contains(c.key) },
                        set: { _ in text[key] = PreferenceChoices.toggled(text[key] ?? "", c.key, among: choices) }
                    ))
                    .toggleStyle(.button)
                    .controlSize(.small)
                }
            }
            if let reason = reasons[key] { Text(reason).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
        }
    }
}

// MARK: Roles

/// Job titles in the candidate's own words: chips with a remove button, a field that adds on
/// Return (or a comma), and the CV's titles on offer underneath.
private struct RolesEditor: View {
    @Binding var text: String
    let suggestions: [String]
    @State private var typed = ""

    var body: some View {
        let roles = RoleTokens.parse(text)
        let offered = RoleTokens.offered(suggestions, chosen: text)
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Roles")
                Spacer()
                Text(roles.isEmpty ? "Any role" : "\(roles.count) picked").font(.caption).foregroundStyle(.secondary)
            }
            if !roles.isEmpty {
                FlowLayout(spacing: 6) {
                    ForEach(roles, id: \.self) { role in
                        RemovableChip(title: role) { text = RoleTokens.removing(role, from: text) }
                    }
                }
            }
            HStack {
                TextField("Add a role", text: $typed, prompt: Text("Add a role… (Backend Engineer, CFO, Chef)"))
                    .labelsHidden()
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(add)
                    .onChange(of: typed) { _, now in if RoleTokens.endsTitle(now) { add() } }
                    .disabled(roles.count >= RoleTokens.limit)
                Button("Add", action: add)
                    .disabled(typed.trimmingCharacters(in: .whitespaces).isEmpty || roles.count >= RoleTokens.limit)
            }
            if !offered.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("From your CV").font(.caption).foregroundStyle(.secondary)
                    FlowLayout(spacing: 6) {
                        ForEach(offered, id: \.self) { role in
                            Button { text = RoleTokens.adding(role, to: text) } label: {
                                Label(role, systemImage: "plus").labelStyle(.titleAndIcon)
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            .help("Add “\(role)”")
                        }
                    }
                }
            }
            Text("Any job titles, in your own words. Postings are compared with these.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func add() {
        text = RoleTokens.adding(typed, to: text)
        typed = ""
    }
}

/// A chosen value with its own remove button.
private struct RemovableChip: View {
    let title: String
    let remove: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            Text(title).lineLimit(1)
            Button(action: remove) {
                Image(systemName: "xmark").font(.system(size: 8, weight: .bold))
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .help("Remove \(title)")
            .accessibilityLabel("Remove \(title)")
        }
        .font(.callout)
        .padding(.leading, 9).padding(.trailing, 7).padding(.vertical, 3)
        .background(Color.accentColor.opacity(0.16), in: Capsule())
    }
}

// MARK: Where

/// The country the candidate works from (picked by name) and the city in it.
private struct BasedInRow: View {
    @Binding var country: String
    @Binding var city: String
    let reason: String?

    var body: some View {
        let code = CountryCodes.parse(country).first
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Based in")
                Spacer()
                SearchablePicker(
                    title: code.map { "\(Places.flag($0)) \(Places.countryName($0))" } ?? "Choose a country…",
                    prompt: "Search countries",
                    items: Places.countries(),
                    decoration: Places.flag
                ) { country = $0.code }
                if code != nil {
                    Button { country = "" } label: { Image(systemName: "xmark.circle.fill") }
                        .buttonStyle(.plain).foregroundStyle(.secondary).help("Clear the country")
                }
                TextField("City", text: $city, prompt: Text("City"))
                    .labelsHidden()
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 170)
            }
            Text("Where you work from. The city matters for on-site and hybrid jobs.")
                .font(.caption).foregroundStyle(.secondary)
            if let reason { Text(reason).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
        }
    }
}

/// Other countries where on-site or hybrid work is fine, as chips.
private struct CountriesRow: View {
    @Binding var text: String
    /// The "based in" country: already covered, so not offered again.
    let home: String

    var body: some View {
        let codes = CountryCodes.parse(text)
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Also fine on-site or hybrid in")
                Spacer()
                SearchablePicker(
                    title: "Add a country…",
                    prompt: "Search countries",
                    items: Places.countries().filter { !codes.contains($0.code) && $0.code != home.uppercased() },
                    decoration: Places.flag
                ) { text = CountryCodes.adding($0.code, to: text) }
            }
            if !codes.isEmpty {
                FlowLayout(spacing: 6) {
                    ForEach(codes, id: \.self) { code in
                        RemovableChip(title: "\(Places.flag(code)) \(Places.countryName(code))") {
                            text = CountryCodes.removing(code, from: text)
                        }
                    }
                }
            }
            Text("Countries you'd commute or move to. Remote jobs don't need one.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}

// MARK: Languages

/// One row per language: its name, a level, a remove button.
private struct LanguagesEditor: View {
    @Binding var text: String
    /// The ones they'd rather work in ("de, uk").
    @Binding var working: String
    let reason: String?

    var body: some View {
        let rows = LanguageRows.parse(text)
        ForEach(rows) { row in
            HStack {
                Text(Places.languageName(row.code))
                Spacer()
                Picker("Level", selection: Binding(
                    get: { row.level },
                    set: { text = LanguageRows.setting(row.code, level: $0, in: text) }
                )) {
                    ForEach(LanguageRows.levels, id: \.key) { Text($0.title).tag($0.key) }
                }
                .labelsHidden()
                .fixedSize()
                Button { text = LanguageRows.removing(row.code, from: text) } label: {
                    Image(systemName: "minus.circle.fill")
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("Remove \(Places.languageName(row.code))")
            }
        }
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                if rows.isEmpty { Text("None added yet").foregroundStyle(.secondary) }
                Spacer()
                SearchablePicker(
                    title: "Add language…",
                    prompt: "Search languages",
                    items: Places.languages().filter { item in !rows.contains { $0.code == item.code } }
                ) { text = LanguageRows.adding($0.code, to: text) }
            }
            Text("A posting that asks for a language you don't have, or a higher level, scores lower.")
                .font(.caption).foregroundStyle(.secondary)
            if let reason { Text(reason).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
        }
        if !rows.isEmpty {
            let chosen = Set(WorkingLanguages.parse(working))
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("Rather work in")
                    Spacer()
                    Text(chosen.isEmpty ? "No preference" : "\(chosen.count) picked").font(.caption).foregroundStyle(.secondary)
                }
                FlowLayout(spacing: 6) {
                    ForEach(rows) { row in
                        Toggle(Places.languageName(row.code), isOn: Binding(
                            get: { chosen.contains(row.code) },
                            set: { _ in working = WorkingLanguages.toggled(row.code, in: working) }
                        ))
                        .toggleStyle(.button)
                        .controlSize(.small)
                    }
                }
                Text("Pick the languages you'd like your team to work in. A posting that works only in others (an English-only one, say) counts for half; nothing picked means any language is fine.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .onChange(of: text) { working = WorkingLanguages.keeping(working, spoken: LanguageRows.parse(text).map(\.code)) }
        }
    }
}

// MARK: The searchable list

/// A button that opens a list you can search by typing: the first match is picked with Return,
/// any row with a click. Used for countries and for languages.
struct SearchablePicker: View {
    let title: String
    let prompt: String
    let items: [NamedCode]
    /// Something in front of each name (a flag); empty for none.
    var decoration: (String) -> String = { _ in "" }
    let pick: (NamedCode) -> Void
    @State private var open = false

    var body: some View {
        Button { open = true } label: {
            HStack(spacing: 4) {
                Text(title).lineLimit(1)
                Image(systemName: "chevron.up.chevron.down").font(.caption2).foregroundStyle(.secondary)
            }
        }
        .popover(isPresented: $open, arrowEdge: .bottom) {
            SearchableList(prompt: prompt, items: items, decoration: decoration) { item in
                open = false
                pick(item)
            }
        }
    }
}

/// The list inside the picker: a search field and what it finds.
struct SearchableList: View {
    let prompt: String
    let items: [NamedCode]
    var decoration: (String) -> String = { _ in "" }
    /// What's typed when it opens (the scripted check shows a filtered list).
    var initialQuery = ""
    let pick: (NamedCode) -> Void
    @State private var query = ""
    @FocusState private var searching: Bool

    var body: some View {
        let found = Places.search(query, in: items)
        return VStack(spacing: 0) {
            TextField(prompt, text: $query, prompt: Text(prompt))
                .labelsHidden()
                .textFieldStyle(.roundedBorder)
                .focused($searching)
                .onSubmit { if let first = found.first { pick(first) } }
                .padding(8)
            Divider()
            if found.isEmpty {
                Text("Nothing matches “\(query)”").font(.callout).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(found.enumerated()), id: \.element.id) { index, item in
                            Button { pick(item) } label: {
                                HStack(spacing: 6) {
                                    let mark = decoration(item.code)
                                    if !mark.isEmpty { Text(mark) }
                                    Text(item.name)
                                    Spacer()
                                    if index == 0 && !query.isEmpty {
                                        Text("↩").font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                                .padding(.horizontal, 10).padding(.vertical, 4)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(Rectangle())
                                .background(index == 0 && !query.isEmpty ? Color.accentColor.opacity(0.14) : .clear)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
        .frame(width: 280, height: 320)
        .onAppear {
            query = initialQuery
            searching = true
        }
    }
}
