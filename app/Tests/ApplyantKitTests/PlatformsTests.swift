import ApplyantAPI
import Foundation
import Testing
@testable import ApplyantKit

@MainActor
@Suite struct PlatformsTests {
    @Test func platformsAndTheCaptchaKeyReadAsText() {
        var p = Platform.with { $0.platform = "linkedin"; $0.name = "LinkedIn"; $0.searchesPerDay = 8; $0.applicationsPerDay = 15; $0.searchesToday = 2 }
        #expect(PlatformText.status(p) == "Not signed in: LinkedIn searches stay off until you sign in")
        #expect(PlatformText.chip(p) == Chip(text: "Not signed in", tone: .neutral))
        #expect(PlatformText.usage(p) == "Today: 2 of 8 searches · 0 of 15 applications")
        p.signedInAt = .init(date: Date(timeIntervalSince1970: 1_790_000_000))
        #expect(PlatformText.status(p).hasPrefix("Signed in · "))
        #expect(PlatformText.chip(p).tone == .good)
        p.pausedAt = .init(date: Date())
        p.pauseReason = "LinkedIn asked to verify the session (/checkpoint/challenge)"
        #expect(PlatformText.status(p) == "Paused: LinkedIn asked to verify the session (/checkpoint/challenge). Answer it in Applyant's browser, then Resume.")
        #expect(PlatformText.chip(p) == Chip(text: "Paused", tone: .warning))

        #expect(PlatformText.captcha(nil).contains("unknown"))
        #expect(PlatformText.captcha(.with { $0.captchaSolver = false }) == "No CapMonster key: captchas go to you")
        #expect(PlatformText.captcha(.with { $0.captchaSolver = true }).hasPrefix("CapMonster key set"))
        #expect(PlatformText.signInOpen(.init()) == nil)
        #expect(Section.settings.isBuilt)
    }

    @Test func settingsListSaysWhereEachPaneStands() {
        #expect(SettingsText.general(name: "Roman Kudin", projects: 21) == "Roman Kudin · 21 projects")
        #expect(SettingsText.general(name: nil, projects: 0) == "Setup, profile and preferences")

        var gmail = Mailbox.with { $0.kind = "gmail"; $0.status = "connected"; $0.address = "me@gmail.com" }
        #expect(SettingsText.connections(gmail, telegram: nil) == "Gmail connected")
        #expect(SettingsText.connections(gmail, telegram: .with { $0.state = .connected }) == "Gmail connected · Telegram")
        #expect(!SettingsText.connectionsNeedYou(gmail))
        gmail.note = "invalid_grant (Token has been expired or revoked.)"
        #expect(SettingsText.connections(gmail, telegram: nil) == "Gmail signed out")
        #expect(SettingsText.connectionsNeedYou(gmail))
        #expect(SettingsText.connections(nil, telegram: nil) == "No mailbox")

        let list = PlatformList.with {
            $0.platforms = [
                .with { $0.platform = "xing"; $0.name = "Xing"; $0.signedInAt = .init(date: Date()) },
                .with { $0.platform = "linkedin"; $0.name = "LinkedIn"; $0.signedInAt = .init(date: Date()) },
            ]
        }
        #expect(SettingsText.sites(list, secrets: ["capmonster", "login.djinni.co", "login.linkedin.com"]) == "Djinni · LinkedIn · Xing")
        #expect(SettingsText.sites(nil, secrets: []) == "No sign-ins yet")
        // A login kept under its flattened sign-in address still reads as the site.
        #expect(SettingsText.sites(nil, secrets: ["login.djinni.co-login", "login.acme.wd5.myworkdayjobs.com"]) == "Djinni · Workday")

        let roles = ["claude:sonnet", "claude:haiku", "codex", "claude:opus"].map { route in RoleRoute.with { $0.route = route } }
        #expect(SettingsText.models(roles) == "Claude · Codex · 4 roles")
        #expect(SettingsText.models([]) == "Models and stored keys")
    }

    @Test func settingsSignsInResumesSetsCapsAndStoresTheKeyWithoutReadingItBack() async throws {
        let daemon = FakeDaemon(postings: [], applications: [], lastId: 5)
        daemon.platformList.platforms[0].pausedAt = .init(date: Date())
        daemon.platformList.platforms[0].pauseReason = "a captcha (recaptcha_v2) on LinkedIn"
        let store = AppStore(connector: FakeConnector([daemon]), backoff: { _ in })
        let run = Task { await store.run() }
        defer { run.cancel() }
        try await eventually("connected") { store.connection == .connected }
        #expect(daemon.calls.contains("listPlatforms"))
        #expect(store.platform("linkedin")?.hasPausedAt == true)
        #expect(store.platforms?.captchaSolver == false)

        await store.resumePlatform("linkedin")
        #expect(daemon.calls.contains("resumePlatform linkedin"))
        #expect(store.platform("linkedin")?.hasPausedAt == false)

        await store.setPlatformCaps("xing", searches: 4, applications: nil)
        #expect(daemon.calls.contains("setPlatformCaps xing 4 -"))
        #expect(store.platform("xing")?.searchesPerDay == 4)
        #expect(store.platform("xing")?.applicationsPerDay == 15)

        #expect(await store.signIn("linkedin") == "https://www.linkedin.com/login")
        #expect(PlatformText.signInOpen(store.platforms)?.contains("linkedin.com/login") == true)

        // The key goes through the secrets path; only "set" comes back.
        await store.setCaptchaKey("   ")
        #expect(!daemon.calls.contains("setSecret capmonster"))
        await store.setCaptchaKey(" test-key-123 ")
        #expect(daemon.secrets["capmonster"] == "test-key-123")
        #expect(store.platforms?.captchaSolver == true)

        // A platform event (paused elsewhere) refreshes Settings.
        daemon.platformList.platforms[1].pausedAt = .init(date: Date())
        daemon.feed.yield(.with {
            $0.id = 6
            $0.platform = .with { $0.platform = "xing"; $0.status = "paused" }
        })
        try await eventually("the pause shows") { store.platform("xing")?.hasPausedAt == true }
        #expect(store.lastError == nil)
    }

    @Test func telegramReadsAsTextSignsInAndFollowsAChannel() async throws {
        #expect(TelegramText.status(nil).contains("unknown"))
        #expect(TelegramText.status(.with { $0.state = .disconnected }).hasPrefix("Not connected: public channels"))
        #expect(TelegramText.chip(.with { $0.state = .waitingCode }) == Chip(text: "Signing in", tone: .warning))
        #expect(TelegramText.channelLocator("  https://t.me/s/remotejobss ") == "https://t.me/s/remotejobss")
        #expect(TelegramText.channelLocator("two words") == nil)

        let daemon = FakeDaemon(postings: [], applications: [], lastId: 5)
        let store = AppStore(connector: FakeConnector([daemon]), backoff: { _ in })
        let run = Task { await store.run() }
        defer { run.cancel() }
        try await eventually("connected") { store.connection == .connected }
        await store.openSettings()
        #expect(store.telegram?.state == .disconnected)
        await store.connectTelegram(.start(.with { $0.phone = "+306900000000" }))
        #expect(store.telegram?.state == .waitingCode)
        await store.connectTelegram(.code("00000"))
        #expect(store.telegram?.state == .waitingCode)
        await store.connectTelegram(.code("11111"))
        #expect(TelegramText.status(store.telegram) == "Connected as @roman · Roman")
        await store.disconnectTelegram()
        #expect(store.telegram?.state == .disconnected)

        #expect(await store.followChannel("@remotejobss"))
        #expect(daemon.addedSources == ["@remotejobss"])
        #expect(await store.followChannel("") == false)
    }
}
