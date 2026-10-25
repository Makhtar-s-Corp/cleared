#!/usr/bin/env node
// Picks the model of a task from agents.conf: the role default, then the
// first matching override, then the declared fallbacks. Prints the chain of
// candidates as JSON; the dispatcher takes the first one that is available.
// `rule` and `notes` are shown to the user in tracker, hence in French.
//
//   route.ts --role dev [--label Bug] [--project "…"] [--path server/x.mjs]…
//             [--pr-lines 120] [--author-model <alias or id>] [--model <alias>] [--lane fast]
//   --lane fast: the ticket is on the fast lane (lib/fast-lane.ts decides it,
//   never the caller's guess): the author role takes [fast_lane] author_model
//   and the review [fast_lane] review_model, before [rules]. The reviewer
//   still differs from the author ([review] differs_from_author).
//   route.ts configured        the models the configuration can start (configuredModels)
import { loadConf, runAsCommand, section } from './conf.ts';
import type { Condition, Conf, Model } from './conf.ts';

type Task = { role: string; labels: string[]; project: string | null; paths: string[]; prLines: number | null;
  authorModel: string | null; forced: string | null; lane: string | null };

function known(conf: Conf, alias: string, where: string) {
  const model = conf.models[alias];
  if (!model) {
    throw new Error(`${where}: unknown model "${alias}". Add a line in [models] of agents.conf (and an adapter if the provider is new).`);
  }
  return model;
}

function holds(condition: Condition, task: Task) {
  const { key, op, value } = condition;
  if (key === 'path') {
    return op === '=' && task.paths.some((path) => path.startsWith(value));
  }
  if (key === 'pr_lines') {
    if (task.prLines == null) return false;
    return op === '>' ? task.prLines > Number(value) : op === '<' ? task.prLines < Number(value) : task.prLines === Number(value);
  }
  if (key === 'label') return op === '=' && task.labels.includes(value);
  if (key === 'project') return op === '=' && task.project === value;
  throw new Error(`agents.conf [rules]: unknown condition "${key}" in "${condition.key}${op}${value}"`);
}

function sameModel(conf: Conf, alias: string, other: string | null | undefined) {
  if (!other) return false;
  const model = conf.models[alias];
  return alias === other || model?.model === other || conf.models[other]?.model === model?.model;
}

export function route(conf: Conf, task: Task) {
  if (conf.missingRules) throw new Error('Missing required [rules] section in project agents.conf');
  const notes: string[] = [];
  let alias: string | undefined;
  let rule: string;
  const fast = section(conf, 'fast_lane');
  const authorRole = section(conf, 'review').author_role || 'dev';
  const light = task.lane === 'fast' ? (task.role === 'review' ? fast.review_model : task.role === authorRole ? fast.author_model : '') : '';
  if (task.forced) {
    alias = task.forced;
    rule = 'model selected at launch';
  } else if (light) {
    alias = light;
    rule = `fast lane: light ${task.role === 'review' ? 'reviewer' : 'author'} ([fast_lane] ${task.role === 'review' ? 'review_model' : 'author_model'})`;
  } else {
    const match = conf.rules.find((candidate) => candidate.role === task.role && candidate.conditions.every((c) => holds(c, task)));
    if (match) {
      alias = match.alias;
      rule = match.line;
    } else {
      alias = conf.roles[task.role];
      rule = `default model for role ${task.role}`;
      if (!alias) throw new Error(`agents.conf [roles]: no model for the role "${task.role}"`);
    }
  }
  known(conf, alias, rule);

  const review = section(conf, 'review');
  if (task.role === 'review' && review.differs_from_author === 'yes' && !task.authorModel) {
    throw new Error('the author of the pull request is unknown: pass --author-model, a review never starts on a guess');
  }
  const mustDiffer = task.role === 'review' && review.differs_from_author === 'yes';
  if (mustDiffer && sameModel(conf, alias, task.authorModel)) {
    const other = review.when_same;
    if (!other || sameModel(conf, other, task.authorModel)) {
      throw new Error('agents.conf [review]: when_same must name a model other than the author of the pull request');
    }
    notes.push(`reviewer changed from ${alias} to ${other}: ${alias} wrote the PR`);
    alias = other;
    known(conf, alias, '[review] when_same');
  }

  const chain: Model[] = [];
  const seen = new Set<string>();
  let next: string | undefined = alias;
  while (next && !seen.has(next)) {
    seen.add(next);
    const model = known(conf, next, `[fallbacks] of ${alias}`);
    if (!(mustDiffer && sameModel(conf, next, task.authorModel))) chain.push({ ...model });
    next = conf.fallbacks[next];
  }
  return { role: task.role, rule, chain, notes };
}

// The models the configuration can start: the aliases named by [roles],
// [rules], [harness] and [review] when_same, followed through their
// [fallbacks], as distinct adapter:model pairs with the aliases that lead to
// each. An alias nothing names is left out; a named alias missing from
// [models] is listed apart, with where it is named. serve/check-harness.sh
// probes each pair once.
export function configuredModels(conf: Conf) {
  const named: [string | undefined, string][] = [];
  for (const [role, alias] of Object.entries(conf.roles)) named.push([alias, `[roles] ${role}`]);
  for (const rule of conf.rules) named.push([rule.alias, `[rules] ${rule.line}`]);
  for (const [role, alias] of Object.entries(section(conf, 'harness'))) named.push([alias, `[harness] ${role}`]);
  named.push([section(conf, 'review').when_same, '[review] when_same']);
  for (const key of ['author_model', 'review_model']) named.push([section(conf, 'fast_lane')[key], `[fast_lane] ${key}`]);
  const models = new Map<string, { adapter: string; model: string; aliases: string[] }>();
  const unknown = new Map<string, string>();
  for (const [first, where] of named) {
    const seen = new Set<string>();
    let next = first;
    let from = where;
    while (next && !seen.has(next)) {
      seen.add(next);
      const model = conf.models[next];
      if (!model) {
        if (!unknown.has(next)) unknown.set(next, from);
        break;
      }
      const key = `${model.adapter}:${model.model}`;
      if (!models.has(key)) models.set(key, { adapter: model.adapter, model: model.model, aliases: [] });
      if (!models.get(key)!.aliases.includes(next)) models.get(key)!.aliases.push(next);
      from = `[fallbacks] ${next}`;
      next = conf.fallbacks[next];
    }
  }
  return { models: [...models.values()], unknown: [...unknown].map(([alias, where]) => ({ alias, where })) };
}

function parseArgs(argv: string[]) {
  const task: Omit<Task, 'role'> & { role: string | null } = { role: null, labels: [], project: null, paths: [], prLines: null, authorModel: null, forced: null, lane: null };
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for ${argv[i]}`);
    switch (argv[i]) {
      case '--role': task.role = value; break;
      case '--label': if (value) task.labels.push(value); break;
      case '--project': task.project = value || null; break;
      case '--path': if (value) task.paths.push(value); break;
      case '--pr-lines': task.prLines = value === '' ? null : Number(value); break;
      case '--author-model': task.authorModel = value || null; break;
      case '--model': task.forced = value || null; break;
      case '--lane': if (!['fast', 'full', ''].includes(value)) throw new Error('--lane is fast or full'); task.lane = value || null; break;
      default: throw new Error(`unknown option ${argv[i]}`);
    }
  }
  if (!task.role) throw new Error('--role is required');
  return task as Task;
}

if (runAsCommand(import.meta.url) && process.argv[2] === 'configured') {
  // One line a model ("model <adapter> <model id> <aliases, comma separated>")
  // and one a named alias [models] does not know ("unknown <alias> <where>"),
  // separated by tabs.
  try {
    const { models, unknown } = configuredModels(loadConf());
    for (const m of models) process.stdout.write(`model\t${m.adapter}\t${m.model}\t${m.aliases.join(',')}\n`);
    for (const u of unknown) process.stdout.write(`unknown\t${u.alias}\t${u.where}\n`);
  } catch (error) {
    process.stderr.write(`route: ${(error as Error).message}\n`);
    process.exit(1);
  }
} else if (runAsCommand(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(route(loadConf(), parseArgs(process.argv.slice(2))))}\n`);
  } catch (error) {
    process.stderr.write(`route: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
