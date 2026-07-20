# Dominion Night theme audit

## Contract

- Customer-facing name: **Dominion Night**.
- Stable internal key: `dominion-night`.
- Browser color scheme: `dark`.
- Feature gate: `VITE_ENABLE_DOMINION_NIGHT_THEME=true`.
- Production entitlement and Profile selection remain owned by FOU-548.

Dominion Night uses moonlit blue-black page surfaces, deep blue-green elevation,
and a sea-glass teal interaction color. That changes the whole visual temperature
and depth model compared with the existing neutral black-and-gold Dark theme.
Dominion gold remains intentional on crowns, prestige coins, earned gold badges,
and reward celebrations so the product still reads as Dominion and earned tiers
do not lose their meaning.

## Semantic palette

| Role | Dominion Night | Existing Dark distinction |
| --- | --- | --- |
| Page / soft | `#071317` / `#0b1f24` | Blue-black instead of pure black |
| Surface / elevated | `#102b30` / `#17383e` | Blue-green elevation instead of neutral gray |
| Primary / muted text | `#f1f8f6` / `#aec5c1` | Cool white and sea-glass gray |
| Accent / strong | `#4fd1b5` / `#9af0dc` | Teal interaction language instead of gold |
| Success / warning / danger / info | `#78d79f` / `#f3c76d` / `#ff9a91` / `#7bd0f5` | Four independently legible status channels |
| Reward / prestige | `#e8bd65` | Gold is reserved for earned moments |

The automated theme test checks normal and muted text against every foundational
surface, primary and destructive control labels, all status text colors, focus
indicators, and shared graphical boundaries. Those checks use WCAG relative
luminance thresholds (4.5:1 for normal text and 3:1 for non-text indicators).

## Hard-coded color audit

Theme-sensitive control labels, active tabs, checkbox marks, menu shadows,
scrims, action-specific colors, status feedback, progress tracks, and focus rings
now resolve through semantic variables. Light and Dark retain their original
primitive values.

The following hard-coded colors are intentional and are not theme surface leaks:

- Prestige coin metals and crown highlights communicate bronze, silver, gold,
  and global ranks.
- Gold badge and medal gradients are earned reward artwork.
- White specular highlights inside coins and medals simulate reflective material.
- SVG mask source colors do not render directly; `currentColor` supplies the
  visible icon color.

Dominion Night does not add layout wrappers, nested cards, or new card shadows.
Its `.card` override is color-only and explicitly keeps `box-shadow: none`, which
preserves FOU-528's card-reduction direction.

## Theme-aware assets

Theme-aware images use the generic `data-theme-asset` marker. Variant lookup is
registry-driven; no page code branches on Light versus Dark. Dominion Night uses
the registry's approved Dark fallback for the landing poster, dashboard mark, and
Science training photograph because each is already composed for a dark canvas.
All sources retain explicit dimensions or stable aspect-ratio containers, so a
variant swap does not shift layout. A future fourth theme can add a
`data-theme-src-<stable-key>` attribute without changing selector logic.

## Route and state matrix

The FOU-556 dependency head contains the routes below. `dominion-night-theme.test.mjs`
enforces that every HTML entry loads the profile after core/product CSS, so a new
entry cannot silently ship without theme coverage.

| Route | Key surfaces and states | Mobile | Tablet | Desktop |
| --- | --- | --- | --- | --- |
| `index.html` | Marketing hero, poster fallback, cards, CTA, footer/menu | Browser audit | Token/layout audit | Browser audit |
| `login.html` | Auth form, focus, validation/error, disabled submit | Browser audit | Token/layout audit | Browser audit |
| `register.html` | Registration form, focus, validation/error, disabled submit | Browser audit | Token/layout audit | Browser audit |
| `membership.html` | Offer surfaces, feature list, primary/secondary CTAs | Browser audit | Token/layout audit | Browser audit |
| `billing.html` | Status, offers, destructive/disabled actions, feedback | Browser audit | Token/layout audit | Browser audit |
| `dashboard.html` | Progress, streaks, badges, rewards, dialogs, image fallback | Browser audit | Token/layout audit | Browser audit |
| `today-actions.html` | Action cards, locked/completed/disabled controls, Check-In CTA | Browser audit | Token/layout audit | Browser audit |
| `community.html` | Tabs, members, leaderboard ranks, feed/journal, skeleton/error/empty | Browser audit | Token/layout audit | Browser audit |
| `profile.html` | Form, upload, appearance preview, billing states | Browser audit | Token/layout audit | Browser audit |
| `science.html` | Image fallback, stats, timeline, sources, CTA | Browser audit | Token/layout audit | Browser audit |

FOU-529 Badges & Rewards, FOU-535 dedicated Daily Standard pages, and sharing
surfaces are not present on the FOU-556 dependency head. The all-entry test and
FOU-558 browser matrix are the integration gates when those branches meet. FOU-548
owns the final entitlement/Profile activation and three-theme integrated pass.

## Accessibility and motion

- Keyboard focus uses the high-contrast `--focus-ring` on every interactive type.
- Checked, locked, available, active, completed, success, and error states retain
  text, icons, borders, or patterns in addition to color.
- Disabled copy uses a dedicated readable token rather than opacity alone where
  the component permits it.
- Reduced-motion mode stops profile-specific fixed-background behavior and keeps
  shared animation reductions intact.
- Forced-colors mode restores system focus and explicit state boundaries.
- The theme changes color and decoration only, so existing mobile, tablet, and
  desktop content flow and FOU-528 layout decisions stay intact.
