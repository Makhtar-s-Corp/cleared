#!/usr/bin/env node
// One gesture of the human, written to the tracker as the human. Started by the
// app server for one request, then gone: the human's tokens are read here and
// nowhere else. Request on stdin (JSON), one JSON line on stdout.
import { readFileSync } from 'node:fs';
import { loadConf, projectDir, section, stateDir, expandHome } from '../lib/conf.mjs';
import { defaultDir, readCredentials } from './lib/credentials.mjs';
import { perform } from './lib/human-tracker.mjs';

const answer = (value) => { process.stdout.write(`${JSON.stringify(value)}\n`); };
try {
  const request = JSON.parse(readFileSync(0, 'utf8'));
  const conf = loadConf();
  const settings = section(conf, 'app');
  const dir = expandHome(settings.human_credentials_dir || defaultDir());
  const adapter = conf.sections.tracker?.adapter;
  const creds = readCredentials(dir, { project: projectDir(), adapter });
  answer(await perform(request, { conf, creds, settings, project: { state: stateDir() } }));
} catch (error) {
  // The reason stays in the server's journal; the browser gets the code only.
  console.error(`human-write: ${String(error.message).slice(0, 300)}`);
  answer({ ok: false, code: error.code && /^[a-z]{3,12}$/.test(error.code) ? error.code : 'failed' });
}
