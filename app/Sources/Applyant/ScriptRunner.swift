// A scripted run of the real app, for checking it without a person at the screen:
//
//   Applyant --script steps.json --out dir/
//
// Each step moves the window where a click would (section, posting, review) or calls the
// store action a button calls, then renders the window into dir/NN-name.png. The window draws
// itself into a bitmap, so no screen-recording permission is needed. The app quits at the end;
// dir/log.txt says what each step saw.
import AppKit
import ApplyantKit
import SwiftUI
import ServiceManagement
import UserNotifications

struct ScriptStep: Decodable {
    var name: String
    var section: String?
    var posting: Int64?
    var review: Int64?
    /// skip · interested · prepare · confirmAll · confirmFacts · editAnswer · setField · approve · submit · setCvMode ·
    /// startInterview · answerInterview · dismissInterview · pauseStrategy · resumeStrategy · runStrategy ·
    /// sourceOff · sourceOn (value: a source key or kind) · wait
    var action: String?
    var application: Int64?
    var facts: [Int64]?
    var answer: Int32?
    var sentence: Int32?
    var text: String?
    var field: String?
    var value: String?
    var reason: String?
    /// Seconds to wait before rendering (for events to arrive).
    var wait: Double?
    /// Keep waiting (up to `wait`) until this is true: "stage:<app>:<stage>", "posting:<id>",
    /// "handoff:<app>", "question" (the thread on screen has an open question), "settled",
    /// "run:<strategy>" (its latest run finished).
    var until: String?
    /// The Search section: a strategy or a source; the Agent runs section: a run.
    var searchStrategy: Int64?
    var searchSource: String?
    var agentRun: Int64?
    /// The Interview section: open a project's thread or a question's.
    var interviewProject: Int64?
    var interviewQuestion: Int64?
    var width: Double?
    var height: Double?
}

@MainActor
final class ScriptRunner {
    private let store: AppStore
    private let steps: [ScriptStep]
    private let out: URL
    private var window: NSWindow?
    private var log: [String] = []

    init?(arguments: [String], store: AppStore) {
        guard let i = arguments.firstIndex(of: "--script"), i + 1 < arguments.count,
              let o = arguments.firstIndex(of: "--out"), o + 1 < arguments.count,
              let data = try? Data(contentsOf: URL(fileURLWithPath: arguments[i + 1])),
              let steps = try? JSONDecoder().decode([ScriptStep].self, from: data)
        else { return nil }
        self.store = store
        self.steps = steps
        out = URL(fileURLWithPath: arguments[o + 1])
    }

    func run() async {
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.contentView = NSHostingView(rootView: MainView(store: store))
        window.setFrameOrigin(NSPoint(x: -4000, y: -4000))  // off screen: nobody needs to see it
        window.orderFront(nil)
        self.window = window

        await waitUntil(seconds: 20) { self.store.connection == .connected }
        note("connected: \(store.connection)")
        for (n, step) in steps.enumerated() {
            await perform(step)
            await waitUntil(seconds: step.wait ?? 1.5) { self.satisfied(step.until) }
            if let w = step.width, let h = step.height {
                window.setContentSize(NSSize(width: w, height: h))
            }
            try? await Task.sleep(for: .milliseconds(600))
            let file = out.appendingPathComponent(String(format: "%02d-%@.png", n + 1, step.name))
            render(to: file)
            note("\(step.name): \(describe())" + (store.lastError.map { " · error: \($0)" } ?? ""))
            store.lastError = nil
        }
        try? log.joined(separator: "\n").write(to: out.appendingPathComponent("log.txt"), atomically: true, encoding: .utf8)
        NSApp.terminate(nil)
    }

    private func perform(_ s: ScriptStep) async {
        if let section = s.section.flatMap(Section.init(rawValue:)) {
            store.navigation.section = section
            store.navigation.postingId = nil
            store.navigation.reviewing = nil
        }
        if let posting = s.posting { store.navigation.postingId = posting }
        if let review = s.review {
            store.navigation.reviewing = review
            if let app = store.applications[review] { store.navigation.postingId = app.postingID }
        }
        if let id = s.searchStrategy {
            store.navigation.section = .search
            store.navigation.search = .strategy(id)
        }
        if let key = s.searchSource {
            store.navigation.section = .search
            store.navigation.search = .source(key)
        }
        if let run = s.agentRun {
            store.navigation.section = .agentRuns
            store.navigation.run = run
        }
        if let p = s.interviewProject { store.navigation.showInterview(.project(p)) }
        if let q = s.interviewQuestion { store.navigation.showInterview(.question(q)) }
        let app = s.application ?? store.navigation.reviewing ?? 0
        switch s.action {
        case "skip": await store.skip(posting: s.posting ?? 0, reason: s.reason ?? "")
        case "interested": await store.markInterested(posting: s.posting ?? 0)
        case "prepare":
            if let id = await store.prepare(posting: s.posting ?? 0) { store.navigation.reviewing = id }
        case "confirmAll": await store.confirmFacts(application: app, factIds: [])
        case "confirmFacts": await store.confirmFacts(application: app, factIds: s.facts ?? [])
        case "editAnswer": await store.editAnswer(application: app, answer: s.answer ?? 1, sentence: s.sentence, text: s.text)
        case "setField": await store.setField(application: app, field: s.field ?? "", value: s.value)
        case "setCvMode": await store.setCvMode(application: app, mode: s.value ?? "tailored")
        case "approve": await store.approve(application: app)
        case "submit": await store.submit(application: app)
        case "markSubmitted": await store.markSubmitted(application: app)
        case "menu":
            // The menu bar's menu, drawn as a plain view for the picture.
            let status = StatusModel()
            await status.refresh()
            window?.contentView = NSHostingView(rootView: VStack(alignment: .leading, spacing: 6) {
                StatusMenu(store: store, status: status, open: {})
            }
            .buttonStyle(.link)
            .padding(16)
            .frame(width: 520, alignment: .leading))
            window?.setContentSize(NSSize(width: 520, height: 420))
        case "loginItem":
            note("loginItem: SMAppService.mainApp.status = \(SMAppService.mainApp.status.rawValue) (0 notRegistered, 1 enabled, 2 requiresApproval, 3 notFound)")
        case "clearNotifications":
            UNUserNotificationCenter.current().removeAllDeliveredNotifications()
            note("notifications: cleared")
        case "notifications":
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            note("notifications: authorization=\(settings.authorizationStatus.rawValue) (0 notDetermined, 1 denied, 2 authorized, 3 provisional) alert=\(settings.alertSetting.rawValue)")
            if settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional {
                let delegate = NotificationDelegate(store: store) {}
                delegate.install()
                delegate.post(StoreNotification(kind: .readyForReview, applicationId: 0, postingId: 0, title: "Applyant check · a test notification", body: "From the scripted app check"))
                try? await Task.sleep(for: .seconds(1))
                let delivered = await UNUserNotificationCenter.current().deliveredNotifications()
                note("notifications: delivered now = \(delivered.map(\.request.identifier))")
            }
        case "regenerate": await store.regenerate(application: app)
        case "startInterview": await store.startInterview(project: s.interviewProject ?? 0)
        case "answerInterview", "dismissInterview":
            // The open question of the thread on screen.
            guard let target = store.navigation.interview,
                  let thread = store.interviewThreads[target],
                  let open = InterviewText.openQuestion(thread)
            else {
                note("\(s.action ?? ""): no open question on screen")
                break
            }
            if s.action == "answerInterview" {
                await store.answerInterview(target, question: open.id, text: s.text ?? "")
            } else {
                await store.dismissInterview(target, question: open.id)
            }
        case "pauseStrategy", "resumeStrategy":
            await store.setStrategy(s.searchStrategy ?? 0, paused: s.action == "pauseStrategy")
        case "runStrategy":
            let run = await store.runStrategy(s.searchStrategy ?? 0)
            note("runStrategy: run \(run.map(String.init) ?? "none (one is already going)")")
        case "sourceOff", "sourceOn":
            await store.setSource(s.value ?? "", enabled: s.action == "sourceOn")
        case "showBrowser": note("showBrowser: Applyant's Chrome brought forward = \(ChromeWindow.bringForward())")
        default: break
        }
    }

    private func satisfied(_ until: String?) -> Bool {
        guard let until else { return false }
        let parts = until.split(separator: ":").map(String.init)
        switch parts.first {
        case "stage":
            guard parts.count == 3, let id = Int64(parts[1]), let app = store.applications[id] else { return false }
            return "\(app.stage)" == parts[2]
        case "posting":
            guard parts.count == 2, let id = Int64(parts[1]) else { return false }
            return store.postings[id] != nil
        case "handoff":
            guard parts.count == 2, let id = Int64(parts[1]) else { return false }
            return store.applications[id]?.hasHandOff == true
        case "question":
            // "question": the thread on screen has an open question to answer.
            guard let target = store.navigation.interview, let thread = store.interviewThreads[target] else { return false }
            return InterviewText.openQuestion(thread) != nil
        case "run":
            // "run:<strategy>": its latest run is no longer waiting or running.
            guard parts.count == 2, let id = Int64(parts[1]), let latest = store.runs(of: id).first else { return false }
            return latest.status != "queued" && store.strategy(id)?.running == false
        case "settled":
            // "settled": the thread on screen isn't waiting on the interviewer.
            guard let target = store.navigation.interview, let thread = store.interviewThreads[target] else { return false }
            return !thread.pending
        default:
            return false
        }
    }

    private func waitUntil(seconds: Double, _ done: @escaping () -> Bool) async {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if done() { return }
            try? await Task.sleep(for: .milliseconds(200))
        }
    }

    private func render(to file: URL) {
        guard let view = window?.contentView else { return }
        view.layoutSubtreeIfNeeded()
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        // What the window leaves transparent (materials, unfilled areas) is over the window's
        // background on screen: composite onto it, as the window server would.
        let flat = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: rep.pixelsWide, pixelsHigh: rep.pixelsHigh,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        )
        guard let flat, let ctx = NSGraphicsContext(bitmapImageRep: flat) else { return }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = ctx
        let rect = NSRect(x: 0, y: 0, width: rep.pixelsWide, height: rep.pixelsHigh)
        view.effectiveAppearance.performAsCurrentDrawingAppearance {
            NSColor.windowBackgroundColor.setFill()
            rect.fill()
        }
        rep.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: false, hints: nil)
        NSGraphicsContext.restoreGraphicsState()
        try? flat.representation(using: .png, properties: [:])?.write(to: file)
    }

    private func describe() -> String {
        let nav = store.navigation
        var parts = ["section=\(nav.section.rawValue)"]
        if let p = nav.postingId { parts.append("posting=\(p)") }
        if let r = nav.reviewing, let app = store.applicationDetails[r] ?? store.applications[r] {
            parts.append("application=\(r) stage=\(app.stage) blockers=\(app.blockers)")
        }
        if let target = nav.interview, nav.section == .interview, let thread = store.interviewThreads[target] {
            parts.append("interview=\(target) questions=\(thread.questions.map { "\($0.id):\($0.status)" }) pending=\(thread.pending)")
        }
        if nav.section == .search {
            parts.append("strategies=\(store.search.strategies.map { "\($0.id):\($0.state):\($0.stats.found)" }) sources on=\(store.search.sources.filter { $0.enabled && $0.kindEnabled }.count)/\(store.search.sources.count)")
        }
        if nav.section == .agentRuns, let run = nav.run {
            parts.append("run=\(run) events=\(store.runEvents[run]?.count ?? 0)")
        }
        parts.append("inbox=\(store.count(.inbox)) ready=\(store.count(.readyToReview)) applied=\(store.count(.applied)) interview=\(store.count(.interview))")
        return parts.joined(separator: " ")
    }

    private func note(_ line: String) {
        log.append(line)
        FileHandle.standardError.write(Data((line + "\n").utf8))
    }
}
