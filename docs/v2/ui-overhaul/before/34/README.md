# Lane 34's "before": the five screens on the fixtures source

Taken on 2026-10-22 at 23:13 (Europe/Paris) on `origin/v2` commit `8a93cd5`, before any change of lane 34 (`v2-j2-ui-foundation`, [../../../ui-overhaul-plan.md](../../../ui-overhaul-plan.md), section 7), with the capture script the lane adds (`v2/scripts/capture-screens.ts`, which runs on the old code as is):

    node scripts/capture-screens.ts --out ../docs/v2/ui-overhaul/before/34

- Source: the fixtures (`fixtureSource`), the clock at the fixtures' `FIXTURE_NOW` in the source and in the page, so two runs on the same code give the same pixels.
- The app and its preview listener on ephemeral loopback ports (port 0), signed in as a throwaway account named `owner`; stopped at the end.
- Headless Chromium of playwright-core 1.64.0 (v2's dev dependency), device scale 1.
- Files: `<screen>-<width>-<theme>.png` for the tower (`/`), the inbox, the sessions index, a session (the fixtures' first author) and the lead, at 1440x900, 1280x800, 768x1024 and 390x844, light and dark: 40 files.
- Each file was looked at before it was committed: fixture data only, no secret, no person's or organisation's name.
