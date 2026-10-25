// The model step's throwaway container (docs/v2/milestone-5-plan.md,
// decision 7): where the newcomer runs `claude setup-token` without
// installing anything. Each terminal gets a container of its own from the
// session image, under a fresh id, labelled cleared.dev=v2 with the role
// `setup`: no checkout, no login file, no forge credential, no folder of the
// host, every capability dropped, the session's limits. It has Docker's
// default network, since the command signs in on the web. Its terminal is a
// docker exec under `script`, as a session's (terminal/container.ts), and
// its close removes the container, by its label and its name only.
import { randomUUID } from 'node:crypto';
import type { Docker } from '../container/docker.ts';
import { END_TERMINAL, scriptTerminal, terminalCommand, type SessionContainer } from '../terminal/container.ts';

export const SETUP_ROLE = 'setup';
const LIFETIME_SECONDS = 3600;                 // the container ends itself after an hour, whatever happens to the service

export function throwawayContainer(docker: Docker, image: string): SessionContainer {
  return {
    exec: async () => ({ code: 1, stdout: '', stderr: 'the setup container runs a terminal only' }),
    async terminal(_id, size, command) {
      const session = randomUUID();
      const name = `cleared-v2-${session}`;
      await docker.createContainer({
        name, session, role: SETUP_ROLE, image, networks: [],
        command: ['sleep', String(LIFETIME_SECONDS)],
        dropAllCapabilities: true, noNewPrivileges: true,
        limits: { memory: '512m', cpus: '1', pids: 128 },
        workdir: '/tmp',
      });
      const remove = () => docker.removeSession(session, { stopTimeoutSeconds: 1 }).catch(() => undefined);
      try {
        await docker.start(session, name);
        // The image's own user, else node, the session image's.
        const inspected = await docker.inspect(session, name) as { Config?: { User?: string } };
        const child = await docker.terminal(session, name, { user: inspected.Config?.User || 'node', workdir: '/tmp', command: terminalCommand(command) });
        const process = scriptTerminal(child, async () => {
          await docker.exec(session, name, END_TERMINAL, { timeoutMs: 15_000 }).catch(() => undefined);
          await remove();
        });
        await process.resize(size.cols, size.rows);
        return process;
      } catch (error) {
        await remove();
        throw error;
      }
    },
  };
}
