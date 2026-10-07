#!/usr/bin/env node
// Picks the model of a task from agents.conf: the role default, then the
// first matching override, then the declared fallbacks. Prints the chain of
// candidates as JSON; the dispatcher takes the first one that is available.
// `rule` and `notes` are shown to the user in Linear, hence in French.
//
//   route.mjs --role dev [--label Bug] [--project "…"] [--path server/x.mjs]…
//             [--pr-lines 120] [--author-model <alias or id>] [--model <alias>]
import { loadConf, section } from './conf.mjs';

function known(conf, alias, where) {
  const model = conf.models[alias];
  if (!model) {
    throw new Error(`${where}: unknown model "${alias}". Add a line in [models] of agents.conf (and an adapter if the provider is new).`);
  }
  return model;
}

function holds(condition, task) {
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

function sameModel(conf, alias, other) {
  if (!other) return false;
  const model = conf.models[alias];
  return alias === other || model?.model === other || conf.models[other]?.model === model?.model;
}

export function route(conf, task) {
  const notes = [];
  let alias;
  let rule;
  if (task.forced) {
    alias = task.forced;
    rule = 'modèle imposé au lancement';
  } else {
    const match = conf.rules.find((candidate) => candidate.role === task.role && candidate.conditions.every((c) => holds(c, task)));
    if (match) {
      alias = match.alias;
      rule = match.line;
    } else {
      alias = conf.roles[task.role];
      rule = `modèle par défaut du rôle ${task.role}`;
      if (!alias) throw new Error(`agents.conf [roles]: no model for the role "${task.role}"`);
    }
  }
  known(conf, alias, rule);

  const review = section(conf, 'review');
  const mustDiffer = task.role === 'review' && review.differs_from_author === 'yes' && task.authorModel;
  if (mustDiffer && sameModel(conf, alias, task.authorModel)) {
    const other = review.when_same;
    if (!other || sameModel(conf, other, task.authorModel)) {
      throw new Error('agents.conf [review]: when_same must name a model other than the author of the pull request');
    }
    notes.push(`relecteur changé de ${alias} à ${other} : ${alias} a écrit la PR`);
    alias = other;
    known(conf, alias, '[review] when_same');
  }

  const chain = [];
  const seen = new Set();
  let next = alias;
  while (next && !seen.has(next)) {
    seen.add(next);
    const model = known(conf, next, `[fallbacks] of ${alias}`);
    if (!(mustDiffer && sameModel(conf, next, task.authorModel))) chain.push({ ...model });
    next = conf.fallbacks[next];
  }
  return { role: task.role, rule, chain, notes };
}

function parseArgs(argv) {
  const task = { role: null, labels: [], project: null, paths: [], prLines: null, authorModel: null, forced: null };
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
      default: throw new Error(`unknown option ${argv[i]}`);
    }
  }
  if (!task.role) throw new Error('--role is required');
  return task;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.stdout.write(`${JSON.stringify(route(loadConf(), parseArgs(process.argv.slice(2))))}\n`);
  } catch (error) {
    process.stderr.write(`route: ${error.message}\n`);
    process.exit(1);
  }
}
