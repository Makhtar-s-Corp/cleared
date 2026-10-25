// The lead's tool service_impact (docs/v2/milestone-4-plan.md, section
// 12.4), given to the lead's engine through its extensions, beside the
// plans' tools: the services a goal changes in, the impact read from the
// map out (impact.ts impactText), the map built first when it never was.
// Its line, description and schema are lead/contract.ts's.
import type { LeadExtensions } from '../lead/engine.ts';
import { HostToolRefused } from '../session/contract.ts';
import { ImpactError, impactOf, impactText } from './impact.ts';
import type { ServiceMaps } from './service.ts';

const refuse = (message: string): never => { throw new HostToolRefused(message); };

export function mapExtensions(maps: () => ServiceMaps | undefined): LeadExtensions {
  return {
    tools: {
      service_impact: async (input) => {
        const running = maps() ?? refuse('The service map is not running yet: try again in a moment.');
        const services = (typeof input === 'object' && input !== null ? (input as { services?: unknown }).services : undefined);
        if (!Array.isArray(services) || !services.every((name) => typeof name === 'string')) return refuse('Give services, a list of service names.');
        const stored = running.current();
        const map = stored.builtAt === null ? await running.refresh() : stored;
        try {
          return impactText(map, impactOf(map, services.map((name) => name.trim())), running.now());
        } catch (error) {
          if (error instanceof ImpactError) return refuse(error.message);
          throw error;
        }
      },
    },
  };
}
