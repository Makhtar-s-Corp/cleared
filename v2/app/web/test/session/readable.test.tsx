// A session readable in five seconds (the owner's request of 2026-10-30): a
// ticket's Markdown rendered, its checks deduplicated, what it waits for said.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { Markdown } from '../../components/markdown/Markdown.tsx';
import { blocksOf, runsOf } from '../../components/markdown/model.ts';
import { readChecks } from '../../screens/session/ticket.ts';
import { html, visibleText } from '../render.tsx';

test('a heading, a list, a fence and inline marks are read as such; a line stays one paragraph', () => {
  assert.deepEqual(blocksOf('## What to write\n\nA first\nline.\n\n- one\n- two\n\n1. a\n2. b\n\n```\ncode here\n```').map((block) => block.kind), ['heading', 'paragraph', 'list', 'list', 'code']);
  assert.deepEqual(runsOf('a `b` **c** [d](https://example.org)').map((run) => run.kind), ['text', 'code', 'text', 'strong', 'text', 'link']);
});

test('the raw marks are gone from what a person reads', () => {
  const markup = html(<Markdown text={'## Quoi écrire\n\nLe fichier **utile** et `npm test`.\n\n- un\n- deux'} />);
  const text = visibleText(markup).join(' ');
  assert.doesNotMatch(text, /##|\*\*|`|^- /m);
  assert.match(markup, /<h3 class="markdown-heading">Quoi écrire<\/h3>/);
  assert.match(markup, /<strong>utile<\/strong>/);
  assert.match(markup, /<code>npm test<\/code>/);
  assert.equal(markup.match(/<li>/g)?.length, 2);
});

test('a ticket\'s text is never markup, and only an http or https address becomes a link', () => {
  const markup = html(<Markdown text={'<img src=x onerror=alert(1)> [click](javascript:alert(1)) [ok](https://example.org)'} />);
  assert.doesNotMatch(markup, /<img|href="javascript/);
  assert.match(markup, /href="https:\/\/example\.org"/);
  assert.match(markup, /rel="noopener noreferrer"/);
});

test('checks that read the same are one line, their state the worst, the commands kept', () => {
  const read = (name: string) => (name.startsWith('git') ? 'Read the repository' : name);
  const checks = readChecks([
    { name: 'git status', state: 'passed' }, { name: 'git log', state: 'pending' }, { name: 'git diff', state: 'passed' }, { name: 'npm test', state: 'failed' },
  ], read);
  assert.deepEqual(checks, [
    { name: 'Read the repository', state: 'pending', commands: ['git status', 'git log', 'git diff'] },
    { name: 'npm test', state: 'failed', commands: ['npm test'] },
  ]);
  assert.equal(readChecks([{ name: 'a', state: 'failed' }, { name: 'a', state: 'passed' }], (name) => name)[0]?.state, 'failed');
});
