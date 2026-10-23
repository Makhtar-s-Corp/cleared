# Lane 38's "before": the whole app at the start of the lane

Taken on 2026-10-23 at 03:55 (Europe/Paris) on `origin/v2` commit `e6446c2` (lanes 33 to 36 merged, lane 37 not yet), before any change of lane 38 (`v2-j2-polish-measures`, [../../../ui-overhaul-plan.md](../../../ui-overhaul-plan.md), section 7), with the repository's capture script and lane 38's `login` screen added to it:

    node scripts/capture-screens.ts --out <folder> --screens tower,inbox,sessions,session,lead,review,review-editor,review-takeover,palette,sheet,palette-session,sheet-session,rail-tooltip,tower-empty,lead-empty,login

- Source: the fixtures, the clock at `FIXTURE_NOW`; the app and its preview listener on ephemeral loopback ports, signed in as a throwaway account named `owner`; headless Chromium of playwright-core 1.64.0, device scale 1; French, the app's default.
- Files: `<screen>-<width>-<theme>.png` at 1440x900, 1280x800, 768x1024 and 390x844, light and dark: 126 files (the rail's tooltip from 768 px only).
- Each file was looked at before it was committed: fixture data only, no secret, no person's or organisation's name.
- The app before the whole overhaul (`8a93cd5`) is in [../8a93cd5/](../8a93cd5/README.md); the lane's "after" in [../../after/38/](../../after/38/README.md).
