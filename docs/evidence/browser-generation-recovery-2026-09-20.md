# Linux browser generation recovery — September 20, 2026

Candidate `38378d1a67ee896961bf3ba05774f210d21963e1` ran in GitHub Actions
[35497182062](https://github.com/tjames222/77-dominion-challenge/actions/runs/35497182062).
The job reached its 45-minute limit before uploading any baseline artifact.
This cancelled run is not passing release evidence.

The log confirms 940 unit tests, seven hybrid-auth tests, 44 production-built
MFA tests, 78 production-built Admin tests, and 66 focused Daily Action tests
passed before the 1,152-case main browser matrix started. Its one reported
assertion failure was the brand-font test selecting the first Inter face in CSS
order. The font optimization now declares the extended-language face first;
that face correctly remains unloaded for the English/numeric share preview.
The failure reproduced locally without retries.

The test now asks the browser for the Inter face covering the actual rendered
metric at its actual weight, requires exactly one loaded Inter face, checks that
the Latin UI font was requested, and rejects an unnecessary full-font request.
Existing typography token equality and runtime-error assertions remain. The
separate extended-language test still proves the original font loads when needed.
Both cases passed three repetitions each; all ten browser-quality configuration
unit tests passed. No application font, CSS, screenshot tolerance, assertion
timeout, retry count, test selection, worker count, or required check was changed.

The cancelled Linux run completed the mobile and tablet visual projects and
most of desktop-light. The two remaining desktop themes and upload exceeded
the old cap. The same standard `ubuntu-latest` job now has a bounded 60-minute
limit. This is a public repository; no paid runner or billing setting changed.
Independent read-only runtime review supported this narrow adjustment instead
of restructuring the required check or accepting incomplete screenshots.

Fresh exact-head Linux generation, human-visible baseline review, and strict
protected-branch comparisons are still required before release.
