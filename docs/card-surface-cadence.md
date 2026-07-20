# Page section surface cadence

Dominion page sections use `data-section-surface="plain"` or `"accent"` on
direct children of `main.app-shell`. Plain sections keep the page visually open.
Accent sections may retain a card, image panel, or spotlight surface, but two
visible accent sections must never be adjacent.

This contract applies to route-level content sections, not functional controls.
Forms, checklists, action toggles, dialogs, list rows, and status messages may
keep their own boundaries when those boundaries communicate state or grouping.
Shared CSS intentionally targets only direct page sections so nested controls
retain dark/light theme tokens, focus treatment, and mobile behavior.

The static cadence test reads every active HTML input from `vite.config.ts`,
requires explicit surface metadata, and caps accent sections at every other
visible section. `profile.html` is temporarily listed as a merge-safe deferral
while its point-unlocked theme work lands; remove that deferral as soon as the
profile branch is merged and annotate its route sections in the same cadence.
