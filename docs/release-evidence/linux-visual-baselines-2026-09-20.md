# Reviewed Linux visual baselines — September 20, 2026

Full generation [35499402874](https://github.com/tjames222/77-dominion-challenge/actions/runs/35499402874)
used source `992937f6bcd21815f4b2788ed97f11c9a02796d8`. It passed 1,104 main
browser cases with 48 intentional skips, plus 940 units, 7 hybrid-auth, 44 MFA,
78 Admin, and 66 Daily Action checks. Artifact `10602382945` contained 334 PNGs;
its ZIP SHA256 was `6ced4fb5fc20f05f3567c0164b4e6bfa218d36abaeb7284766d92b299d10bbae`.

Compared with the 325 committed PNGs, 162 were byte-identical, 163 differed,
and nine Admin captures were new. All 172 differing/new captures were visually
reviewed in three independent ranges, with full-size checks where needed.
Expected differences cover responsive artwork, typography, and removal of the
Profile test controls. Existing screenshot tolerances were not changed.

Review found a shared-header gutter defect in the nine new Admin captures.
The scoped fix and red/green geometry evidence are recorded in
`docs/evidence/admin-shell-gutter-2026-09-20.md`. The original nine Admin PNGs
were not adopted.

Corrected Admin generation [35502419372](https://github.com/tjames222/77-dominion-challenge/actions/runs/35502419372)
passed exactly nine existing visual cases at review source
`1e0daa49a48b72ad7472c40eb7065afa4496ce21`. Its application files were identical
to release source `7c852f2035fdba4ef2099e74bd2989478a13d7be`; the only Git-tree
difference was the isolated manual-only capture workflow. That workflow has
a distinct review-only job name and is not included in this release.

Corrected artifact `10602692204` is bound to that SHA, run and attempt 1; ZIP
SHA256 is `2ca340bc6a5fe37c07340c1c0c42bf3e71e5198e11d75b718f2043c774e77dbc`.
All nine full-size images were reviewed. Their dimensions are exactly
390×844, 768×1024, and 1440×1000 for all three themes. The synthetic
non-administrator/unavailable state is intentional and does not grant access.

Adoption consists of the 163 reviewed non-Admin replacements (with old/new
file hashes checked) plus nine corrected Admin additions. No paths were
removed. These generation runs are review evidence, not the final protected
comparison checks: all four required PR checks, including the unchanged full
1,152-case browser inventory, must pass before merging.
