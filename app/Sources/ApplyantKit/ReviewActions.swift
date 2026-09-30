import ApplyantAPI
import Foundation

/// The review card's quick actions and the answer footer's "adapted from …".
public enum ReviewActions {
    /// "adapted from the answer sent to Orbit (Sep 12)", or "… the answer for Orbit (Sep 12)"
    /// when that one wasn't sent; nil when the earlier answer is gone.
    public static func adaptedFrom(_ answer: Applyant_V1_Answer) -> String? {
        guard answer.hasAdapted else { return answer.hasAdaptedFrom ? "adapted from an earlier answer" : nil }
        let a = answer.adapted
        let who = a.hasCompany ? a.company : (a.hasTitle ? a.title : "application \(a.applicationID)")
        let sent = StageRules.isSent(a.stage)
        let date = a.at.date.formatted(.dateTime.month(.abbreviated).day())
        return "adapted from the answer \(sent ? "sent to" : "for") \(who) (\(date))"
    }

    /// The earlier question, for the footer's tooltip: "Orbit asked: “Why us?”".
    public static func adaptedQuestion(_ answer: Applyant_V1_Answer) -> String? {
        guard answer.hasAdapted else { return nil }
        let a = answer.adapted
        return "\(a.hasCompany ? a.company : "It") asked: “\(a.question)”"
    }

    /// A quick action waiting for its new draft: "Redrafting shorter, from Lantern…".
    public static func pending(_ answer: Applyant_V1_Answer) -> String? {
        var how: [String] = []
        if answer.redraftShorter { how.append("shorter") }
        if answer.hasRedraftProject { how.append("from \(answer.redraftProject)") }
        return how.isEmpty ? nil : "Redrafting " + how.joined(separator: ", ") + "…"
    }

    /// Shorter and Use another project… apply to written answers not yet approved or sent.
    public static func canRedraft(_ answer: Applyant_V1_Answer, app: Application) -> Bool {
        answer.kind == "text" && answer.status == "answered" && !answer.overridden
            && app.stage != .approved && !StageRules.isSent(app.stage) && pending(answer) == nil
    }
}
