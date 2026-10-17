// The look's numbers: the score ramp, company monograms and their colours, the entrance beat,
// and the chips that show work under way.
import ApplyantAPI
import Foundation
import Testing
@testable import ApplyantKit

@Suite struct LookTests {
    @Test func theRampGoesFromRedThroughAmberToGreen() {
        #expect(ScoreScale.hue(nil) == nil)
        #expect(ScoreScale.hue(12) == 0)
        #expect(ScoreScale.hue(40) == 0)
        // Amber in the sixties, green from 85 on.
        let sixtyFive = ScoreScale.hue(65) ?? 0
        #expect(sixtyFive > 0.07 && sixtyFive < 0.13)
        #expect(ScoreScale.hue(85) == ScoreScale.hue(99))
        #expect((ScoreScale.hue(85) ?? 0) > 0.3)
        // Never back down as the score goes up.
        let hues = (0...100).map { ScoreScale.hue(Int32($0)) ?? -1 }
        #expect(zip(hues, hues.dropFirst()).allSatisfy { $0 <= $1 })
    }

    @Test func theRingFillsTheScoreOutOfAHundred() {
        #expect(ScoreScale.fill(nil) == 0)
        #expect(ScoreScale.fill(89) == 0.89)
        #expect(ScoreScale.fill(140) == 1)
        #expect(ScoreScale.fill(-5) == 0)
    }

    @Test func monogramsTakeTheNamesFirstLetters() {
        #expect(Monogram.initials("Red Rocket Software") == "RR")
        #expect(Monogram.initials("Nuitée") == "N")
        #expect(Monogram.initials("modash.io") == "M")
        #expect(Monogram.initials("potuzhno.agency") == "P")
        #expect(Monogram.initials("DEMV Systems GmbH") == "DS")
        #expect(Monogram.initials("Kozak Agency") == "KA")
        #expect(Monogram.initials("A-GOS") == "AG")
        #expect(Monogram.initials("  ") == "?")
        // Only the legal form: it's still a name.
        #expect(Monogram.initials("GmbH") == "G")
    }

    @Test func aCompanysColourIsItsOwnAndStable() {
        let hue = Monogram.hue("LiveKit")
        #expect(hue >= 0 && hue < 1)
        #expect(Monogram.hue("LiveKit") == hue)
        #expect(Monogram.hue("livekit") == hue)
        #expect(Monogram.hue("Kalepa") != hue)
    }

    @Test func blocksComeInOneBeatApartUpToACap() {
        #expect(Stagger.delay(0) == 0)
        #expect(Stagger.delay(1) < Stagger.delay(2))
        #expect(Stagger.delay(7) == Stagger.delay(40))
        #expect(Stagger.delay(40) <= 0.33)
        #expect(Stagger.delay(-3) == 0)
    }

    @Test func workUnderWayShowsInItsChip() {
        let preparing = Application.with { $0.id = 1; $0.stage = .preparing }
        let delivering = Application.with { $0.id = 2; $0.stage = .approved }
        let ready = Application.with { $0.id = 3; $0.stage = .readyForReview }
        #expect(StageText.chip(preparing).live)
        #expect(StageText.chip(delivering).live)
        #expect(!StageText.chip(ready).live)
        // A delivery stopped for the candidate isn't under way.
        let handOff = Application.with { $0.id = 4; $0.stage = .approved; $0.handOff = .with { $0.reason = "captcha" } }
        #expect(!StageText.chip(handOff).live)
    }

    @Test func aDeliverysFillingIsAFraction() {
        #expect(DeliveryProgress().fraction == nil)
        #expect(DeliveryProgress(messages: ["16 fields"]).fraction == 0)
        #expect(DeliveryProgress(messages: ["filling 4/16: Email"]).fraction == 0.25)
        #expect(DeliveryProgress(messages: ["filling 20/16: Email"]).fraction == 1)
    }
}
