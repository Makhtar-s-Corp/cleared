# Lane 34's "after": the five screens, reached without a document load

Taken on 2026-10-22 at 23:47 (Europe/Paris) on the lane's branch (`v2-j2-ui-foundation`), with the same script, source, clock, browser and sizes as [../../before/34/](../../before/34/README.md), but each screen reached by a click on a link of the page, which the app's router answers without loading a document:

    node scripts/capture-screens.ts --out ../docs/v2/ui-overhaul/after/34 --via click

- The script fails the run if a click loads a document, if the page throws, or if a request leaves the app's origin: none did.
- Every one of the 40 files is the same, byte for byte, as its "before": the lane changed how the screens are reached and fed, and nothing of how they look (the plan's section 7, lane 34). Four click runs on 2026-10-22 and 2026-10-23 (the last after review round 1) each matched all 40, the session at `/sessions/<id>` included.
- The run with `--via load` (each address opened as a page) matches too, but for one place: at 768 wide, two of the sessions and session files differ from run to run, never the same two, by 20 to 25 pixels inside the header's "Lead · always on" pill (x 27 to 155, rows 48 to 73, a channel difference of 18 of 255 at most). It moves between runs of the same code, and waiting for the page's animations to end did not remove it; the click runs never show it.
