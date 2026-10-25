#!/usr/bin/env node
// The guard of the repository on one text a tracker adapter is about to
// send (lib/tracker/adapters/github.ts): exit 0 when it may leave, 1 with
// the reason said otherwise, as guard.sh did.
//
//   guard.ts <text file>
import { existsSync, statSync } from 'node:fs';
import { die, guardText, main } from '../script.ts';

await main(() => {
  const file = process.argv[2] ?? '';
  if (!file || !existsSync(file) || !statSync(file).isFile()) die('no text file to check');
  return guardText(file) ? 0 : 1;
});
