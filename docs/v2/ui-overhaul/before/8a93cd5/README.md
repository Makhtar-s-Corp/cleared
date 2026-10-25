# The app before the overhaul, in French: `origin/v2` at `8a93cd5`

Taken on 2026-10-23 by lane 38 (`v2-j2-polish-measures`) as the "before" of the whole overhaul ([../../../ui-overhaul-plan.md](../../../ui-overhaul-plan.md), sections 7 and 8), to compare with the final "after" in [../../after/38/](../../after/38/README.md). `8a93cd5` is the head of `v2` before lane 34, the first interface lane; [../34/](../34/README.md) holds the same screens in English.

- A detached checkout of `8a93cd5`, with lane 38's capture script copied in (`v2/scripts/capture-screens.ts`; its `settle` also accepts the old page's root, as the old pages have no `#screen`), run with:

      node scripts/capture-screens.ts --out <folder> --screens tower,inbox,sessions,session,lead,login --language fr

- Source: the fixtures, the clock at `FIXTURE_NOW`; the app and its preview listener on ephemeral loopback ports, signed in as a throwaway account named `owner`; headless Chromium of playwright-core 1.64.0, device scale 1.
- Files: `<screen>-<width>-<theme>.png` for the tower, the inbox, the sessions index, a session (the fixtures' first author), the lead and the sign-in page, at 1440x900, 1280x800, 768x1024 and 390x844, light and dark: 48 files.
- Each file was looked at before it was committed: fixture data only, no secret, no person's or organisation's name.
