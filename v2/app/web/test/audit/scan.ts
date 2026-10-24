// The i18n audit's reader (O23, lane j2-i18n-audit): parses each component of
// app/web with the parser Vite's bundler ships (oxc, through rolldown's
// experimental entry; TypeScript 7 has no script API) and lists, as findings,
// every place that writes a word a person reads, or a number, a duration or
// a date, on its own instead of through the catalogs and the formatter. The
// rules are in `scan`; the test (../i18n-audit.test.tsx) holds the justified
// exceptions and the catalogs. Pure, so the tests run it on snippets too.
import { parseSync } from 'rolldown/experimental';

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly text: string;
}

type Node = { type: string; start: number; end: number; [key: string]: unknown };

const LETTER = /\p{L}/u;
const hasLetter = (text: string) => LETTER.test(text);

// The attributes a person reads or hears, and the props that carry a word to
// a component that draws it.
export const VISIBLE_ATTRIBUTES: ReadonlySet<string> = new Set([
  'aria-label', 'aria-description', 'aria-placeholder', 'aria-valuetext', 'aria-roledescription',
  'title', 'placeholder', 'alt', 'data-tip', 'label', 'text', 'hint', 'description', 'heading',
  'caption', 'tooltip', 'message', 'summary', 'empty', 'subtitle', 'legend',
]);

// The properties of a plain object that hold a word the screen draws
// (palette items, rows, steps).
export const VISIBLE_PROPERTIES: ReadonlySet<string> = new Set([
  'label', 'title', 'text', 'placeholder', 'description', 'hint', 'heading', 'caption', 'tooltip',
  'message', 'summary', 'subtitle', 'ariaLabel', 'aria_label',
]);

// The names that hold catalog keys, and what a key looks like.
const KEY_HOLDER = /(?:KEYS?|LABEL|SEND|PLACEHOLDER|FAILED|Key|Failure)$/;
const KEY_SHAPE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

// The names of the counts a screen draws; said through Intl (quantity in lib/time.ts), never as they are.
const NUMBER_NAMES: ReadonlySet<string> = new Set(['added', 'removed', 'count', 'total', 'all', 'last', 'size', 'bytes', 'lines']);

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';

function children(node: Node): Node[] {
  const out: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent' || key === 'loc') continue;
    if (Array.isArray(value)) for (const item of value) { if (isNode(item)) out.push(item); }
    else if (isNode(value)) out.push(value);
  }
  return out;
}

// The strings a table or a function hands out: the direct values of an object
// or the items of an array, and what a function returns (through its
// conditionals), not the strings it compares with.
function keysHeld(node: Node): Node[] {
  const out: Node[] = [];
  const string = (n: Node | null | undefined) => { if (n && n.type === 'Literal' && typeof n.value === 'string') out.push(n); };
  const walk = (n: Node, top: boolean) => {
    if (n.type === 'ObjectExpression') { for (const p of n.properties as Node[]) if (p.type === 'Property') string(p.value as Node); return; }
    if (n.type === 'ArrayExpression') { for (const e of n.elements as (Node | null)[]) string(e); return; }
    if (n.type === 'ReturnStatement') { if (n.argument) out.push(...literalsOf(n.argument as Node).filter((l) => l.type === 'Literal')); return; }
    if (n.type === 'ArrowFunctionExpression' && (n.body as Node).type !== 'BlockStatement') { out.push(...literalsOf(n.body as Node).filter((l) => l.type === 'Literal')); return; }
    if (['TSAsExpression', 'TSSatisfiesExpression', 'ParenthesizedExpression'].includes(n.type)) { walk(n.expression as Node, top); return; }
    if (top || ['BlockStatement', 'IfStatement', 'SwitchStatement', 'SwitchCase', 'ArrowFunctionExpression', 'FunctionExpression', 'ExpressionStatement'].includes(n.type)) for (const c of children(n)) walk(c, true);
  };
  walk(node, true);
  return out;
}

// The words a value would draw as it is: the string literals and the
// template pieces reachable through a conditional, a logical operator, a
// concatenation or a template, not through a call (t(...) says them from a
// catalog, a function's result is its own file's business).
function literalsOf(node: Node | null | undefined): Node[] {
  if (!node) return [];
  switch (node.type) {
    case 'Literal': return typeof node.value === 'string' ? [node] : [];
    case 'TemplateLiteral': {
      const quasis = (node.quasis as Node[]).filter((q) => hasLetter(String((q.value as { cooked?: string }).cooked ?? '')));
      return [...quasis, ...(node.expressions as Node[]).flatMap(literalsOf)];
    }
    case 'ConditionalExpression': return [...literalsOf(node.consequent as Node), ...literalsOf(node.alternate as Node)];
    case 'LogicalExpression': return [...literalsOf(node.left as Node), ...literalsOf(node.right as Node)];
    case 'BinaryExpression': return node.operator === '+' ? [...literalsOf(node.left as Node), ...literalsOf(node.right as Node)] : [];
    case 'ParenthesizedExpression': case 'TSAsExpression': case 'TSNonNullExpression': case 'TSSatisfiesExpression': return literalsOf(node.expression as Node);
    default: return [];
  }
}

const textOf = (node: Node): string => node.type === 'TemplateLiteral' || node.type === 'TemplateElement'
  ? String(((node.value ?? {}) as { cooked?: string }).cooked ?? '') : String(node.value);

const nameOf = (node: Node | undefined): string => {
  if (!node) return '';
  if (node.type === 'JSXIdentifier' || node.type === 'Identifier') return String(node.name);
  if (node.type === 'JSXNamespacedName') return `${nameOf(node.namespace as Node)}:${nameOf(node.name as Node)}`;
  if (node.type === 'Literal') return String(node.value);
  return '';
};

// What a translator's first argument can be: a key, a template (a prefix and
// a suffix to match), or something only a run can tell. A conditional is
// both of its branches.
function keyParts(node: Node | undefined): { kind: 'key' | 'prefix' | 'dynamic'; node: Node }[] {
  if (!node) return [];
  switch (node.type) {
    case 'Literal': return typeof node.value === 'string' ? [{ kind: 'key', node }] : [{ kind: 'dynamic', node }];
    case 'TemplateLiteral': return (node.expressions as Node[]).length === 0 ? [{ kind: 'key', node: { ...node, value: textOf(((node.quasis as Node[])[0]) as Node) } as Node }] : [{ kind: 'prefix', node }];
    case 'ConditionalExpression': return [...keyParts(node.consequent as Node), ...keyParts(node.alternate as Node)];
    case 'ParenthesizedExpression': case 'TSAsExpression': case 'TSNonNullExpression': case 'TSSatisfiesExpression': return keyParts(node.expression as Node);
    default: return [{ kind: 'dynamic', node }];
  }
}

export interface Scan {
  readonly findings: Finding[];
  // The keys the code names: literal, built from a prefix, or neither.
  readonly keys: { readonly line: number; readonly key: string }[];
  readonly prefixes: { readonly line: number; readonly prefix: string; readonly suffix: string }[];
  readonly dynamic: { readonly line: number; readonly code: string }[];
  // Keys kept as data under a name ending in Key, error or note: a key, or the start of a family of keys (plan_proposes for plan_proposes_cost_one).
  readonly loose: { readonly line: number; readonly key: string }[];
}

// `translators`: the names the code calls to say a catalog's sentence.
export function scan(file: string, source: string, options: { readonly formatter?: boolean; readonly translators?: readonly string[] } = {}): Scan {
  const lang = file.endsWith('.tsx') ? 'tsx' : 'ts';
  const result = parseSync(file, source, { lang });
  if (result.errors.length > 0) throw new Error(`${file}: ${result.errors.map((e) => e.message).join('; ')}`);
  const lines: number[] = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') lines.push(i + 1);
  const lineOf = (offset: number) => { let lo = 0; let hi = lines.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if ((lines[mid] ?? 0) <= offset) lo = mid; else hi = mid - 1; } return lo + 1; };
  const out: Scan = { findings: [], keys: [], prefixes: [], dynamic: [], loose: [] };
  const translators = new Set(options.translators ?? ['t']);
  const add = (rule: string, node: Node, text: string) => out.findings.push({ file, line: lineOf(node.start), rule, text: text.replace(/\s+/g, ' ').trim() });

  const visit = (node: Node, parent: Node | null): void => {
    switch (node.type) {
      case 'JSXText': {
        const text = String(node.value);
        if (hasLetter(text)) add('jsx-text', node, text);
        break;
      }
      case 'JSXExpressionContainer': {
        // A child's expression; an attribute's is read with the attribute.
        if (parent && (parent.type === 'JSXElement' || parent.type === 'JSXFragment')) {
          // A count drawn as it is ({added}, {scope.all}) is not grouped by the page's language.
          const shown = node.expression as Node;
          const last = shown.type === 'MemberExpression' ? nameOf(shown.property as Node) : shown.type === 'Identifier' ? nameOf(shown) : '';
          if (options.formatter !== false && NUMBER_NAMES.has(last)) add('formatter:raw-number', node, source.slice(shown.start, shown.end));
          for (const literal of literalsOf(node.expression as Node)) { if (hasLetter(textOf(literal))) add('jsx-child-literal', literal, textOf(literal)); }
        }
        break;
      }
      case 'JSXAttribute': {
        const name = nameOf(node.name as Node);
        if (VISIBLE_ATTRIBUTES.has(name)) {
          const value = node.value as Node | null;
          const nodes = value?.type === 'JSXExpressionContainer' ? literalsOf(value.expression as Node) : value?.type === 'Literal' ? [value] : [];
          for (const literal of nodes) { if (hasLetter(textOf(literal))) add(`attribute:${name}`, literal, textOf(literal)); }
        }
        break;
      }
      case 'Property': {
        const name = nameOf(node.key as Node);
        if (VISIBLE_PROPERTIES.has(name) && !node.computed) {
          // A key kept as data (shell/keys.ts: label: 'key_palette') is a key; a word is a finding.
          for (const literal of literalsOf(node.value as Node)) {
            if (/^[a-z][a-z0-9_]*_$/.test(textOf(literal))) out.prefixes.push({ line: lineOf(literal.start), prefix: textOf(literal), suffix: '' });
            else if (literal.type === 'Literal' && KEY_SHAPE.test(textOf(literal))) out.keys.push({ line: lineOf(literal.start), key: textOf(literal) });
            else if (hasLetter(textOf(literal))) add(`property:${name}`, literal, textOf(literal));
          }
        }
        if (/(?:[a-z]Key|^error|^note|^key)$/.test(name) && !node.computed) {
          for (const literal of keyParts(node.value as Node)) { if (literal.kind === 'key' && (name !== 'key' || KEY_SHAPE.test(String(literal.node.value)))) out.loose.push({ line: lineOf(literal.node.start), key: String(literal.node.value) }); }
        }
        break;
      }
      case 'VariableDeclarator': case 'FunctionDeclaration': {
        // A table of keys (PHASE_KEY, SEND) or a function that picks one (closeFailureKey): the keys it holds are the code's.
        const name = nameOf((node.id as Node) ?? undefined);
        if (KEY_HOLDER.test(name)) {
          const body = (node.type === 'VariableDeclarator' ? node.init : node.body) as Node | null;
          if (body) for (const literal of keysHeld(body)) { if (KEY_SHAPE.test(String(literal.value))) out.loose.push({ line: lineOf(literal.start), key: String(literal.value) }); }
        }
        break;
      }
      case 'AssignmentExpression': {
        const left = node.left as Node;
        const target = left.type === 'MemberExpression' ? nameOf(left.property as Node) : '';
        if (['title', 'textContent', 'innerText', 'placeholder'].includes(target) && !left.computed) {
          for (const literal of literalsOf(node.right as Node)) { if (hasLetter(textOf(literal))) add(`assign:${target}`, literal, textOf(literal)); }
        }
        break;
      }
      case 'NewExpression': {
        if (nameOf(node.callee as Node) === 'Notification') {
          const args = node.arguments as Node[];
          for (const literal of [...literalsOf(args[0]), ...literalsOf(args[1])]) { if (hasLetter(textOf(literal))) add('notification', literal, textOf(literal)); }
        }
        if (options.formatter !== false) {
          const callee = node.callee as Node;
          // Intl in the page's language: a locale that is a variable (the language), never a literal or the machine's.
          const locale = (node.arguments as Node[])[0];
          if (callee.type === 'MemberExpression' && nameOf(callee.object as Node) === 'Intl' && (!locale || locale.type === 'Literal')) add('formatter:intl', node, `new Intl.${nameOf(callee.property as Node)}`);
        }
        break;
      }
      case 'CallExpression': {
        const callee = node.callee as Node;
        const args = node.arguments as Node[];
        if (callee.type === 'Identifier' && translators.has(String(callee.name))) {
          for (const part of keyParts(args[0])) {
            if (part.kind === 'key') out.keys.push({ line: lineOf(part.node.start), key: String(part.node.value) });
            else if (part.kind === 'prefix') {
              const quasis = (part.node.quasis as Node[]).map((q) => String((q.value as { cooked: string }).cooked));
              out.prefixes.push({ line: lineOf(part.node.start), prefix: quasis[0] ?? '', suffix: quasis[quasis.length - 1] ?? '' });
            } else out.dynamic.push({ line: lineOf(part.node.start), code: source.slice(part.node.start, part.node.end) });
          }
        }
        if (callee.type === 'Identifier' && ['alert', 'confirm', 'prompt'].includes(String(callee.name))) {
          for (const literal of literalsOf(args[0])) { if (hasLetter(textOf(literal))) add(`call:${String(callee.name)}`, literal, textOf(literal)); }
        }
        if (callee.type === 'MemberExpression' && !callee.computed) {
          const method = nameOf(callee.property as Node);
          if (method === 'setAttribute' && args[0]?.type === 'Literal' && ['aria-label', 'title', 'placeholder', 'alt', 'data-tip'].includes(String(args[0].value))) {
            for (const literal of literalsOf(args[1])) { if (hasLetter(textOf(literal))) add(`setAttribute:${String(args[0].value)}`, literal, textOf(literal)); }
          }
          if (options.formatter !== false) {
            if (method === 'toFixed') add('formatter:toFixed', node, source.slice(node.start, node.end));
            if (/^toLocale(Date|Time)?String$/.test(method)) {
              const locale = args[0];
              if (!locale || locale.type === 'Literal') add(`formatter:${method}`, node, source.slice(node.start, node.end));
            }
            if (['getHours', 'getMinutes', 'getSeconds', 'toTimeString', 'toDateString', 'toUTCString', 'toISOString'].includes(method) && (method !== 'toISOString')) add(`formatter:${method}`, node, source.slice(node.start, node.end));
            if (method === 'padStart') add('formatter:padStart', node, source.slice(node.start, node.end));
          }
        }
        break;
      }
      default:
    }
    for (const child of children(node)) visit(child, node);
  };
  visit(result.program as unknown as Node, null);
  return out;
}
