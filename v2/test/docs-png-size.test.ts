// No heavy capture under docs/ (lane `v2-j6-png-compress`, the promise to
// the owner of 2026-10-27): every PNG the repository tracks under docs/
// weighs at most 500 KB, counted as 500,000 bytes. A capture over that is
// compressed before it is committed, with oxipng (lossless) or pngquant
// (without visible loss), at the same size in pixels. Checking every
// tracked file, not only a diff's, refuses a new capture as well as an
// existing one that grows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';

const LIMIT = 500_000;
const root = join(new URL('..', import.meta.url).pathname, '..');

test('every PNG under docs/ weighs at most 500 KB', () => {
  const pngs = execFileSync('git', ['-C', root, 'ls-files', '-z', '--', 'docs'], { encoding: 'utf8' })
    .split('\0').filter((file) => /\.png$/i.test(file));
  assert.ok(pngs.length > 0, 'no PNG found under docs/');
  const heavy = pngs.map((file) => [file, statSync(join(root, file)).size] as const).filter(([, size]) => size > LIMIT);
  assert.deepEqual(heavy.map(([file, size]) => `${file}: ${size} bytes`), [], `over ${LIMIT} bytes; compress with oxipng or pngquant`);
});
