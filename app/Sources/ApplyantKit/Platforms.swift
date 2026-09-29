// How Settings reads LinkedIn/Xing and the captcha solver (phase 14): whether the browser is
// signed in, a pause and how to lift it, the daily caps against today's use, and whether a
// CapMonster key is stored (never its value).
import ApplyantAPI
import Foundation

public typealias Platform = Applyant_V1_Platform
public typealias PlatformList = Applyant_V1_ListPlatformsResponse

public enum PlatformText {
    /// The secret the CapMonster key is stored under (`applyant secrets set capmonster`).
    public static let captchaSecret = "capmonster"

    public static func captcha(_ list: PlatformList?) -> String {
        guard let list else { return "Captcha solver: unknown (daemon not reachable)" }
        return list.captchaSolver
            ? "CapMonster key set: captchas off LinkedIn and Xing are solved before any hand-off"
            : "No CapMonster key: captchas go to you"
    }

    /// "Signed in · 14 Sep" · "Not signed in: its searches are off" · "Paused: <reason>".
    public static func status(_ p: Platform) -> String {
        if p.hasPausedAt {
            return "Paused" + (p.hasPauseReason ? ": \(p.pauseReason)" : "") + ". Answer it in Applyant's browser, then Resume."
        }
        if p.hasSignedInAt {
            return "Signed in · " + p.signedInAt.date.formatted(date: .abbreviated, time: .omitted)
        }
        return "Not signed in: \(p.name) searches stay off until you sign in"
    }

    public static func chip(_ p: Platform) -> Chip {
        if p.hasPausedAt { return Chip(text: "Paused", tone: .warning) }
        if p.hasSignedInAt { return Chip(text: "Signed in", tone: .good) }
        return Chip(text: "Not signed in", tone: .neutral)
    }

    /// "Today: 2 of 8 searches · 1 of 15 applications".
    public static func usage(_ p: Platform) -> String {
        "Today: \(p.searchesToday) of \(p.searchesPerDay) searches · \(p.applicationsToday) of \(p.applicationsPerDay) applications"
    }

    public static func signInOpen(_ list: PlatformList?) -> String? {
        guard let list, list.hasSignInOpen else { return nil }
        return "Sign-in window open at \(list.signInOpen): searches and deliveries wait until you close it"
    }
}
