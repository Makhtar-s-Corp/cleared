# Lane 38's "after": the whole app, polished

Taken on 2026-10-23 at 05:20 (Europe/Paris) on the lane's branch (`v2-j2-polish-measures`, commit 268a0db, after `origin/v2` with lane 37 was merged into it), with the same script, source, clock, browser, sizes and screens as [../../before/38/](../../before/38/README.md), in French, the app's default:

    node scripts/capture-screens.ts --out <folder> --screens tower,inbox,sessions,session,lead,review,review-editor,review-takeover,palette,sheet,palette-inbox,palette-session,sheet-session,rail-tooltip,tower-empty,lead-empty,inbox-permission,inbox-handled,sheet-inbox,palette-inbox-permission,login

- 166 files (lane 37's inbox screens added: a request shown, the handled group open, the sheet and the palette over the inbox), `<screen>-<width>-<theme>.png` at 1440x900, 1280x800, 768x1024 and 390x844, light and dark; no page error and no request off the app's origin.
- Compare with [../../before/38/](../../before/38/) (the lane's start, `e6446c2`) and, for the whole overhaul, with [../../before/8a93cd5/](../../before/8a93cd5/README.md) (the app before lane 34, the same five screens and the sign-in page in French).
- The inbox is lane 37's, merged, on this lane's type scale.
- Each file was looked at before it was committed: fixture data only, no secret, no person's or organisation's name.
