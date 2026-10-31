// A browser in Cleared's own image (issue #504), so that a Compose install's
// receipts can carry captures: Playwright's Chromium and its ffmpeg, the versions
// the lockfile's playwright-core names. Read from the Dockerfile here, and run in a
// container of a built image when CLEARED_V2_IMAGE_TEST names one: the container
// carries the label, and runs as a person who is not root, as the service does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const DOCKERFILE = readFileSync(new URL('../../images/cleared/Dockerfile', import.meta.url), 'utf8');
const IMAGE = process.env.CLEARED_V2_IMAGE_TEST;

test('the browser is the one the lockfile\'s playwright-core names, never a latest', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { devDependencies: Record<string, string> };
  assert.match(pkg.devDependencies['playwright-core'] ?? '', /^\d+\.\d+\.\d+$/, 'pinned to one version');
  const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8')) as { packages: Record<string, { version: string }> };
  assert.equal(lock.packages['node_modules/playwright-core']?.version, pkg.devDependencies['playwright-core']);
  assert.match(DOCKERFILE, /node_modules\/\.bin\/playwright-core install chromium-headless-shell ffmpeg/);
  assert.doesNotMatch(DOCKERFILE, /npx|playwright(?:-core)?@|--with-deps/);
  assert.ok(DOCKERFILE.indexOf('npm ci') < DOCKERFILE.indexOf('playwright-core install'), 'installed after the lockfile\'s packages');
});

test('it is where each role can read it, the service\'s owner not being root', () => {
  assert.match(DOCKERFILE, /^ENV PLAYWRIGHT_BROWSERS_PATH=\/opt\/playwright$/m);
  assert.match(DOCKERFILE, /chmod -R a\+rX \/opt\/playwright/);
});

test('the image stays lean: the headless shell alone, its libraries with no recommended package, the lists removed', () => {
  assert.doesNotMatch(DOCKERFILE, /install chromium(?:\s|$)/, 'not the full browser');
  const step = DOCKERFILE.slice(DOCKERFILE.indexOf('libnss3') - 200, DOCKERFILE.indexOf('playwright-core install'));
  assert.match(step, /--no-install-recommends/);
  assert.match(step, /rm -rf \/var\/lib\/apt\/lists/);
  assert.doesNotMatch(step, /xvfb/);
});

test('in the built image, as a person who is not root: the browser opens a page, takes a capture and records a video', { skip: IMAGE ? false : 'CLEARED_V2_IMAGE_TEST names no image' }, () => {
  const program = `
    const { createRequire } = await import('node:module');
    const { chromium } = createRequire('/opt/cleared/v2/package.json')('playwright-core');
    const { mkdtempSync, statSync } = await import('node:fs');
    const dir = mkdtempSync('/tmp/capture-');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir, size: { width: 1280, height: 800 } } });
    const page = await context.newPage();
    await page.setContent('<h1>Livre d\\'or</h1>');
    await page.screenshot({ path: dir + '/page.png' });
    await page.waitForTimeout(500);
    const video = page.video();
    await context.close();
    await video.saveAs(dir + '/flow.webm');
    await browser.close();
    process.stdout.write(JSON.stringify({ capture: statSync(dir + '/page.png').size, video: statSync(dir + '/flow.webm').size }));
  `;
  const said = execFileSync('docker', ['run', '--rm', '--label', 'cleared.dev=v2', '--name', 'cleared-v2-j7-real-fixes-browser', '--user', '1000:1000', '--entrypoint', 'node', IMAGE as string, '--input-type=module', '--eval', program], { encoding: 'utf8', timeout: 120_000 });
  const { capture, video } = JSON.parse(said) as { capture: number; video: number };
  assert.ok(capture > 1000, `the capture has ${capture} bytes`);
  assert.ok(video > 1000, `the video has ${video} bytes`);
});
