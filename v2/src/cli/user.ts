// cleared-v2 user add <name>: adds a person who signs in to the app. It asks
// for the password twice, without echo on a terminal (or reads two lines
// from a pipe), and stores only its Argon2id hash in ledger.db, found as
// the service finds it (store/db.ts ledgerPath).
//   node src/cli/user.ts add <name>      (npm run user -- add <name>)
import users, { SqliteUsers, UserError } from '../modules/users.ts';
import { LedgerPathError, StoreError, applyTables, ledgerPath, openStore } from '../store/db.ts';

const USAGE = 'usage: cleared-v2 user add <name>';

function fail(message: string, code: number): never {
  console.error(`cleared-v2: ${message}`);
  process.exit(code);
}

// One line typed on the terminal, not shown. Ctrl-C stops the command.
function askHidden(prompt: string): Promise<string> {
  const input = process.stdin;
  process.stderr.write(prompt);
  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');
  return new Promise((resolve) => {
    let line = '';
    const done = (value: string) => {
      input.off('data', read);
      input.setRawMode(false);
      input.pause();
      process.stderr.write('\n');
      resolve(value);
    };
    const read = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return done(line);
        if (char === '\u0003') {
          input.setRawMode(false);
          process.stderr.write('\n');
          process.exit(130);
        }
        if (char === '\u007f' || char === '\b') line = line.slice(0, -1);
        else if (char >= ' ') line += char;
      }
    };
    input.on('data', read);
  });
}

async function readPiped(): Promise<string[]> {
  let text = '';
  for await (const chunk of process.stdin) text += String(chunk);
  return text.split(/\r?\n/);
}

async function passwords(): Promise<[string, string]> {
  if (process.stdin.isTTY) return [await askHidden('Password: '), await askHidden('Password again: ')];
  const [first = '', second = ''] = await readPiped();
  return [first, second];
}

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== 'add' || !args[1]) fail(USAGE, 64);
const name = args[1];

let path: string;
try {
  path = ledgerPath();
} catch (error) {
  if (error instanceof LedgerPathError) fail(error.message, 64);
  throw error;
}
const [password, again] = await passwords();
if (password === '') fail('the password is empty', 1);
if (password !== again) fail('the two passwords differ', 1);

let store;
try {
  store = openStore(path);
} catch (error) {
  if (error instanceof StoreError) fail(error.message, 64);
  throw error;
}
try {
  applyTables(store.db, users.tables);
  await new SqliteUsers(store.db).add(name, password);
  console.log(`cleared-v2: user ${name} added`);
} catch (error) {
  if (error instanceof UserError) fail(error.message, 1);
  throw error;
} finally {
  store.close();
}
