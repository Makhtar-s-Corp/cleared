// The recipes as each service's base branch holds them (docs/v2/
// milestone-2-plan.md, decision 29): `.cleared/recipes/*.md` of the
// service's repository (of its folder, for a folder of a monorepo), read
// from git's objects at refs/remotes/origin/<base> of the service's own
// checkout, which no session writes, as the reader reads a file
// (reader/workdir.ts): the working tree and an unpushed commit are not
// seen, a committed link is refused, never followed.
//
// What cannot be read is a problem of its file, never the list's: a recipe
// that does not parse, a link, a name an earlier service already uses (the
// run route names a recipe by its name alone, so the first service in the
// workspace's order keeps it), a service not fetched yet.
import { posix } from 'node:path';
import { CheckoutError, git } from '../workspace/checkout.ts';
import { RECIPES_FOLDER, RecipeError, parseRecipe, type RecipeFile } from './recipe.ts';

export const RECIPE_MAX_BYTES = 64 * 1024;

export type RecipeService = {
  readonly name: string;
  readonly base: string;
  readonly dir: string;                  // the service's own checkout, as the flow fetches it
  readonly path: string | null;          // the folder of a monorepo service
};

export type RecipeProblem = { readonly service: string; readonly file: string; readonly message: string };
export type RecipeList = { readonly recipes: readonly RecipeFile[]; readonly problems: readonly RecipeProblem[] };

export type RecipeSource = {
  list(): Promise<RecipeList>;
  // Fetches the service's base before a run, so the recipe run is the one landed now.
  refresh(service: string): Promise<void>;
};

// <mode> SP <type> SP <object> SP+ <size> TAB <path>
const ENTRY = /^(\d+) (\w+) ([0-9a-f]+) +(\d+|-)\t(.*)$/s;

export function gitRecipeSource(options: { readonly services: readonly RecipeService[]; readonly refresh?: (service: string) => Promise<void> }): RecipeSource {
  const names = options.services.map((service) => service.name);
  return {
    async list() {
      const recipes: RecipeFile[] = [];
      const problems: RecipeProblem[] = [];
      const owner = new Map<string, string>();
      for (const service of options.services) {
        const folder = service.path === null ? RECIPES_FOLDER : posix.join(service.path, RECIPES_FOLDER);
        const ref = `refs/remotes/origin/${service.base}`;
        let listing: string;
        try {
          listing = await git(service.dir, ['ls-tree', '-z', '--long', ref, '--', `${folder}/`]);
        } catch (error) {
          if (!(error instanceof CheckoutError)) throw error;
          problems.push({ service: service.name, file: folder, message: `the base branch ${service.base} is not fetched in the service's checkout yet` });
          continue;
        }
        for (const entry of listing.split('\0').filter((line) => line !== '')) {
          const match = ENTRY.exec(entry);
          if (!match) continue;
          const full = match[5] as string;
          if (!full.endsWith('.md') || posix.dirname(full) !== folder) continue;
          const file = service.path === null ? full : posix.relative(service.path, full);
          const problem = (message: string) => { problems.push({ service: service.name, file, message }); };
          if (match[2] !== 'blob' || (match[1] !== '100644' && match[1] !== '100755')) { problem('a recipe is a plain file: a link or a folder is not read'); continue; }
          if (Number(match[4]) > RECIPE_MAX_BYTES) { problem(`a recipe is at most ${RECIPE_MAX_BYTES} bytes`); continue; }
          const text = await git(service.dir, ['cat-file', 'blob', match[3] as string]);
          if (text.includes('\0') || text.includes('�')) { problem('a recipe is a text file'); continue; }
          let recipe: RecipeFile;
          try {
            recipe = parseRecipe(text, { file, service: service.name, services: names });
          } catch (error) {
            if (!(error instanceof RecipeError)) throw error;
            problem(error.message);
            continue;
          }
          const first = owner.get(recipe.name);
          if (first !== undefined) { problem(`the recipe ${recipe.name} of ${first} comes first: a recipe is run by its name, so the name must be unique in the workspace`); continue; }
          owner.set(recipe.name, service.name);
          recipes.push(recipe);
        }
      }
      return { recipes, problems };
    },
    async refresh(service) {
      await options.refresh?.(service);
    },
  };
}
