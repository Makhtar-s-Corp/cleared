// The Agent profile panel's rules (issue #452): a version's facts in words,
// its line (day, person, where it was restored from), a refusal in words.
// No React here, so the node tests read it.
import type { AgentEnvironment, AgentProfile, VersionView } from '../../../../src/profiles/types.ts';
import { hasMark, type Translate } from '../../lib/i18n.ts';
import { dayOf } from '../setup/model.ts';

export function profileFacts(body: AgentProfile, t: Translate): string[] {
  const own = (model: string | null) => model ?? t('profiles_service_own');
  const prompts = (['author', 'reviewer'] as const).filter((role) => body.rolePrompts[role] !== '').map((role) => t(`profiles_prompts_${role}`));
  return [
    t('profiles_fact_harness', { value: t(body.harness === 'auto' ? 'profiles_harness_auto' : 'profiles_harness_claude_code') }),
    t('profiles_fact_author_model', { value: own(body.authorModel) }),
    t('profiles_fact_reviewer_model', { value: own(body.reviewerModel) }),
    t('profiles_fact_prompts', { value: prompts.length > 0 ? prompts.join(', ') : t('profiles_none') }),
    t('profiles_fact_tools', { value: body.allowedTools.length > 0 ? t('profiles_tools_more', { list: body.allowedTools.join(', ') }) : t('profiles_tools_default') }),
    t('profiles_fact_mcp', { value: t('profiles_none') }),
    t('profiles_fact_skills', { value: t('profiles_skills_project') }),
  ];
}

export function environmentFacts(body: AgentEnvironment, t: Translate): string[] {
  const own = (value: string | null) => value ?? t('profiles_cleared_own');
  return [
    t('profiles_fact_image', { value: own(body.image) }),
    t('profiles_fact_network', { value: t(body.network === 'model-only' ? 'profiles_network_model_only' : 'profiles_network_project') }),
    t('profiles_fact_hosts', { value: body.allowedHosts.length > 0 ? body.allowedHosts.join(', ') : t('profiles_hosts_none') }),
    t('profiles_fact_cpus', { value: own(body.cpus) }),
    t('profiles_fact_memory', { value: own(body.memory) }),
  ];
}

// "27 October by sam", without the person when there is none; the
// service's first version, which has no day, as the service ran before profiles.
export function versionMeta(version: VersionView<unknown>, t: Translate): string {
  if (version.createdAt === null) return t('profiles_first');
  const date = dayOf(version.createdAt, t);
  return version.createdBy ? t('profiles_by', { date, by: version.createdBy }) : t('profiles_on', { date });
}

// A refusal of the service as the catalogs say it; anything else as the general one.
export function profileRefusal(t: Translate, body: unknown): string {
  const code = typeof (body as { error?: unknown } | null)?.error === 'string' ? (body as { error: string }).error : '';
  const said = /^[a-z_]+$/.test(code) ? t(`profiles_error_${code}`) : '';
  return said && !hasMark(said) ? said : t('profiles_error_other');
}
