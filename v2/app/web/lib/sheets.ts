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

// The first draw (review of 248, F1): a sheet with media="not all" does not
// block the first paint, and turning it on does not make it block, so on a
// slow link the first screen could paint unstyled. The page turns the first
// screen's sheets on and draws once they have loaded, failed, or `ms` passed.
export function sheetsReady(screen: string, root: Pick<Document, 'querySelectorAll'> = document, ms = 3_000): Promise<void> {
  showSheets(screen, root);
  const waiting = [...root.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][data-screens]')]
    .filter((link) => link.media === 'all' && link.sheet === null)
    .map((link) => new Promise<void>((done) => {
      link.addEventListener('load', () => done(), { once: true });
      link.addEventListener('error', () => done(), { once: true });
    }));
  if (waiting.length === 0) return Promise.resolve();
  return Promise.race([Promise.all(waiting).then(() => undefined), new Promise<void>((done) => setTimeout(done, ms))]);
}
