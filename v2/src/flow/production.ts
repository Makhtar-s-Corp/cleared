// The production page of a landed release (P218, issue #334), as the
// ledger keeps it: each check is a `cleared.production_checked` event the
// flow journaled on the session the release was approved on, once the page
// was opened (flow/proof-capture.ts captureProduction) or found not to be
// opened. The ticket's card reads the last check of each service; the
// ticket's comment says it in the service's words. Cleared never deploys:
// the deploy is the human's or their CI's, and this only reads what landed.
import type { ProductionCheck } from '../api/types.ts';
import type { Store } from '../store/db.ts';

// The last check of each service of `ticket`, in the order of `services`.
export function productionChecksOf(store: Pick<Store, 'sessions' | 'events'>, ticket: string, services: readonly string[]): ProductionCheck[] {
  const last = new Map<string, ProductionCheck>();
  for (const row of store.sessions.list({ ticket }))
    for (const { event } of store.events.after(row.id))
      if (event.type === 'CUSTOM' && event.name === 'cleared.production_checked') {
        const known = last.get(event.value.service);
        if (!known || Date.parse(event.value.at) >= Date.parse(known.at)) last.set(event.value.service, event.value);
      }
  return services.flatMap((service) => last.get(service) ?? []);
}

// What the ticket says of a check, in the service's words (its comments are English).
export function productionComment(check: ProductionCheck): string {
  const page = `The production page of ${check.service} (${check.url})`;
  const landed = `after pull request #${check.pr} landed healthy`;
  const own = 'Cleared did not deploy it: the deploy is yours or your CI\'s.';
  switch (check.missing) {
    case null: return `${page} was captured ${landed}; the capture is on the ticket's card. ${own}`;
    case 'unwatched': return `The production page of ${check.service} was not opened after pull request #${check.pr} landed: the project has no health check, so Cleared cannot tell when the deploy is done. Set [release] health_url or health_command to have it captured.`;
    case 'no_browser': return `${page} was not captured ${landed}: no browser is installed on the server (CLEARED_V2_PLAYWRIGHT in v2/README.md).`;
    case 'failed': return `${page} could not be captured ${landed}. ${own}`;
  }
}
