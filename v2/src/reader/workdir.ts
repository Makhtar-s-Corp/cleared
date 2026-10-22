// The reader's effects on the host (docs/v2/milestone-2-plan.md, decision
// 28): a file of a service as its base branch holds it, and the ask's
// folder, `<root>/<ask id>`, which the session sees read only at /workspace:
//
//   <service>/      each named service at its base branch, landed code only,
//                   without .git (workspace/checkout.ts exportBase); a
//                   folder service is its folder alone
//   CLAUDE.md       the reader's briefing (briefing.ts)
//   HANDOVER.md     a placeholder: the runner's Stop hook asks every role
//                   but the lead and the reviewer for one, and a reader
//                   cannot write it
//   READ_ONLY_MARK  the mark that has the runtime mount the folder read only
//
// A file named by a question is read from git's objects in the service's
// own checkout, which no session writes: a committed link is refused, never
// followed, and the policy's secret names are refused as a session's Read
// of them would be.
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { Docker } from '../container/docker.ts';
import { LOGIN_FILE_MOUNT, READ_ONLY_MARK, WORKDIR_MOUNT, removeSessionVolume, stopSession } from '../container/session-runtime.ts';
import { evaluate } from '../session/policy.ts';
import { CheckoutError, exportBase, git } from '../workspace/checkout.ts';
import type { ReaderEffects } from './service.ts';
import { ReaderError, servicePath } from './target.ts';

// The largest file a question may name.
export const READER_FILE_MAX_BYTES = 1024 * 1024;

export const HANDOVER_PLACEHOLDER = '# Nothing to hand over\n\nThis folder is a reader\'s: it answers a question about the code and changes nothing. Cleared wrote this file.\n';

export type ReaderService = {
  readonly name: string;
  readonly base: string;
  readonly dir: string;                  // the service's own checkout, as the flow fetches it
  readonly path: string | null;          // the folder of a monorepo service
};

const ASK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function realReaderEffects(options: { readonly root: string; readonly services: readonly ReaderService[]; readonly docker?: Docker }): ReaderEffects {
  const docker = options.docker ?? new Docker();
  const serviceOf = (name: string): ReaderService => {
    const service = options.services.find((candidate) => candidate.name === name);
    if (!service) throw new ReaderError('invalid', `${name} is not a service of the workspace`);
    return service;
  };
  const folderOf = (id: string): string => {
    if (!ASK_ID.test(id)) throw new ReaderError('invalid', `not an ask id: ${JSON.stringify(id)}`);
    return join(options.root, id);
  };

  return {
    async fileAt(name, path) {
      const service = serviceOf(name);
      const inside = servicePath(path);
      if (inside === undefined) throw new ReaderError('invalid', `${path} is not a path inside ${name}`);
      const verdict = evaluate({ tool: 'Read', input: { file_path: posix.join(WORKDIR_MOUNT, name, inside), limit: 1 } }, {
        role: 'reader', base: service.base, workdir: WORKDIR_MOUNT, scripts: [], credentialFile: LOGIN_FILE_MOUNT,
        safeCommands: [], allowedHosts: [], forbiddenHosts: [], ticketFiles: [], learned: [],
      });
      if (verdict.decision === 'deny') throw new ReaderError('invalid', verdict.message);
      const full = service.path === null ? inside : posix.join(service.path, inside);
      const absent = () => new ReaderError('invalid', `${inside} is not a file of ${name} at its base branch ${service.base}`);
      let entry: string;
      try {
        entry = (await git(service.dir, ['ls-tree', '-z', '--long', `refs/remotes/origin/${service.base}`, '--', full])).split('\0')[0] ?? '';
      } catch (error) {
        if (error instanceof CheckoutError) throw absent();
        throw error;
      }
      // <mode> SP <type> SP <object> SP+ <size> TAB <path>
      const match = /^(\d+) (\w+) ([0-9a-f]+) +(\d+|-)\t(.*)$/s.exec(entry);
      if (!match || match[5] !== full) throw absent();
      if (match[2] !== 'blob' || (match[1] !== '100644' && match[1] !== '100755')) throw new ReaderError('invalid', `${inside} is not a plain file of ${name}: a link or a folder is not read`);
      if (Number(match[4]) > READER_FILE_MAX_BYTES) throw new ReaderError('invalid', `${inside} is larger than ${READER_FILE_MAX_BYTES} bytes`);
      const text = await git(service.dir, ['cat-file', 'blob', match[3] as string]);
      if (text.includes('\0') || text.includes('�')) throw new ReaderError('invalid', `${inside} is not a text file`);
      return text;
    },

    async prepare(input) {
      const dir = folderOf(input.id);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true, mode: 0o755 });
      for (const name of input.services) {
        const service = serviceOf(name);
        // Exported next to the folder, then moved into it: the export is of the commit, its own folder.
        const staging = join(options.root, `.${input.id}-${name}`);
        rmSync(staging, { recursive: true, force: true });
        try {
          const exported = await exportBase({ project: service.dir, base: service.base, root: staging, ...(service.path === null ? {} : { only: service.path }) });
          if (exported) renameSync(exported.dir, join(dir, name));
          else mkdirSync(join(dir, name));
        } finally {
          rmSync(staging, { recursive: true, force: true });
        }
      }
      writeFileSync(join(dir, 'CLAUDE.md'), input.briefing);
      writeFileSync(join(dir, 'HANDOVER.md'), HANDOVER_PLACEHOLDER);
      writeFileSync(join(dir, READ_ONLY_MARK), '');
      return dir;
    },

    async release(input) {
      if (input.session !== null) {
        await stopSession(docker, input.session);
        await removeSessionVolume(docker, input.session);
      }
      rmSync(folderOf(input.id), { recursive: true, force: true });
    },
  };
}
