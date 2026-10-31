// The session screen keeps its thread, its tabs and its facts in one fold (issue
// #499): a browser test opens it as "Show details" does, whatever it was before.
export const openDetails = async (page: { locator(selector: string): { waitFor(): Promise<void>; evaluate(run: (element: { open: boolean }) => void): Promise<unknown> } }, view = ''): Promise<void> => {
  const fold = page.locator(`${view} [data-session-details]`.trim());
  await fold.waitFor();
  await fold.evaluate((element) => { element.open = true; });
};
