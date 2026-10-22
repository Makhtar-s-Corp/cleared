// The screens' sheets on the one page (lane 34): the server names every
// screen's sheet with media="not all" and the screens it belongs to
// (data-screens, app/src/server.ts); the page turns on those of the screen
// it shows and off the others, so each screen keeps the cascade it had on
// a page of its own (two screens' sheets name classes alike, .btn among
// them). A sheet the bundle adds later (the terminal's) has no
// data-screens and stays on.
export function showSheets(screen: string, root: Pick<Document, 'querySelectorAll'> = document): void {
  for (const link of root.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][data-screens]')) {
    const media = (link.dataset.screens ?? '').split(' ').includes(screen) ? 'all' : 'not all';
    if (link.media !== media) link.media = media;
  }
}
