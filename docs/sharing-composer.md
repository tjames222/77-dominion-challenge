# Sharing composer

FOU-563 provides one accessible composer for four explicit user flows:

- current app and full-standard streaks;
- current 77-day challenge progress;
- a general Dominion challenge invitation;
- a one-time private-group invitation.

Streak, progress, and general previews come from the authenticated
`share-snapshot` Function. The browser never constructs public progress from
profile or activity data. Creating a share returns an opaque, expiring public
URL whose payload excludes names, email, avatars, groups, journals, action
history, and exact activity dates.

The composer creates a short-lived Sharing reward intent only after the user
presses **Share from this device** or **Copy share link**. It completes that
intent only after `navigator.share()` or the Clipboard API resolves. Closing
or canceling a share sheet, a rejected clipboard write, opening the composer,
and previewing content never grant points.

The first completed public share grants the server-authoritative lifetime
reward from FOU-562: 14 points and the `sharing` badge. Private-group
invitations use the hardened FOU-561 fragment URL and do not send a browser
attestation. Their reward remains pending until another account explicitly
confirms the invitation; immutable redemption attribution grants the original
inviter atomically.

The shared dialog supports keyboard focus trapping, Escape/backdrop dismissal,
screen-reader names and live status, mobile action-sheet presentation, and
separate labels for native sharing and copying. Dashboard streak, Dashboard
progress, Dashboard challenge-advertisement, Badges & Rewards, and Private
Groups all load the same implementation.
