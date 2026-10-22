import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, YamlError } from './helpers/yaml.ts';

test('the subset: nested mappings, sequences of scalars, quoted and typed scalars', () => {
  const source = [
    '# a comment',
    'openapi: 3.1.0',
    'paths:',
    '  /check:',
    '    post:',
    '      required:',
    '        - text',
    '        - "two words"',
    '      empty: []',
    '      none: {}',
    "      quoted: 'it''s: fine'",
    '      flag: true',
    '      count: 12',
    '      nothing: null',
    '  "200":',
    '    description: Ok',
  ].join('\n');
  assert.deepEqual(parseYaml(source), {
    openapi: '3.1.0',
    paths: {
      '/check': { post: { required: ['text', 'two words'], empty: [], none: {}, quoted: "it's: fine", flag: true, count: 12, nothing: null } },
      '200': { description: 'Ok' },
    },
  });
});

test('anything outside the subset is refused with its line', () => {
  const refused: [string, RegExp][] = [
    ['a:\n\tb: 1', /line 2: a tab/],
    ['a:\n   b: 1', /line 2: indent of 3/],
    ['a: &anchor 1', /line 1/],
    ['a: [1, 2]', /line 1/],
    ['a: {b: 1}', /line 1/],
    ['a: |\n  text', /line 1/],
    ['a: value # comment', /line 1/],
    ['a: 1\na: 2', /line 2: the key "a" appears twice/],
    ['a:\n  - b: 1', /line 2: a sequence holds scalars only/],
    ['a:', /line 1: "a" has no value/],
    ['a: 1\n  b: 2', /line 2/],
  ];
  for (const [source, message] of refused) assert.throws(() => parseYaml(source), (error: unknown) => error instanceof YamlError && message.test(error.message), source);
});
