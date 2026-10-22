# Lane 34's "after": the five screens, reached without a document load

Taken on 2026-10-22 at 23:58 (Europe/Paris) on the lane's branch (`v2-j2-ui-foundation`), with the same script, source, clock, browser and sizes as [../../before/34/](../../before/34/README.md), but each screen reached by a click on a link of the page, which the app's router answers without loading a document:

    node scripts/capture-screens.ts --out ../docs/v2/ui-overhaul/after/34 --via click

- The script fails the run if a click loads a document, if the page throws, or if a request leaves the app's origin: none did.
- Every one of the 40 files is the same, byte for byte, as its "before": the lane changed how the screens are reached and fed, and nothing of how they look (the plan's section 7, lane 34). The run with `--via load` (each address opened as a page) gives the same pixels too.
