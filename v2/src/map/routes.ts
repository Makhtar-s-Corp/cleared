// The service map's routes (docs/v2/milestone-4-plan.md, section 12.4),
// registered by the lead module: GET /api/service-map, the stored map,
// built at the first read when it never was; and POST
// /api/service-map/refresh, for a user the service knows, which fetches
// the services and builds the map again when a base moved. Guarded as the
// recipes' are: the app's proof, then the flow running.
import { guard, send } from '../recipes/routes.ts';
import type { Registry, Route } from '../modules/registry.ts';
import type { ServiceMaps } from './service.ts';

export type ServiceMapRouteDeps = {
  // The workspace's maps, or undefined while the service runs no flow.
  readonly maps: (registry: Registry) => ServiceMaps | undefined;
  readonly proof: () => string;
};

const DOWN = 'the service map is not available: CLEARED_V2_PROJECT and CLEARED_V2_WORKSPACE are unset or the flow has no adapter';

export function serviceMapRoutes(deps: ServiceMapRouteDeps): Route[] {
  const guarded = (write: boolean, run: Parameters<typeof guard<ServiceMaps>>[2]) => guard({ target: deps.maps, proof: deps.proof, down: DOWN }, write, run);
  return [
    {
      method: 'GET', path: '/api/service-map',
      handle: guarded(false, async (maps, _user, c) => {
        const map = maps.current();
        send(c.response, 200, map.builtAt === null ? await maps.refresh() : map);
      }),
    },
    {
      method: 'POST', path: '/api/service-map/refresh',
      handle: guarded(true, async (maps, _user, c) => {
        send(c.response, 200, await maps.refresh());
      }),
    },
  ];
}
