// The assistant's workspace step's screen (docs/v2/milestone-5-plan.md,
// section 9, decision 15; issue #494): the repositories the forge credential
// reaches, one box each; once picked, the service clones and reads them. One
// service with no contract and no call is said in one sentence. Otherwise the
// step proposes the services, a monorepo's two layouts, each contract file it
// found and each call between the services, with the places that suggested
// it; a section with nothing in it is not drawn, and a proposed line is the
// person's to tick: only what is ticked is written. The Services screen's
// Connect opens this step too.
import { useEffect, useState, type FormEvent } from 'react';
import type { ConfirmBody, ProposeBody, ProposedLink, ProposedService, WorkspaceProposal, WorkspaceView, WorkspaceWritten } from '../../../../../src/workspace/types.ts';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import type { Translate } from '@/lib/i18n.ts';
import { dayOf, refusal } from '../model.ts';
import { StepFrame, type StepProps } from '../step.tsx';
import './workspace.css';

// Past this many repositories, the list gets a field that narrows it.
const FILTER_FROM = 8;

type Initial = { readonly view: WorkspaceView; readonly proposal?: WorkspaceProposal; readonly picked?: readonly string[] };

const toggled = (set: ReadonlySet<string>, value: string, on: boolean): Set<string> => {
  const next = new Set(set);
  if (on) next.add(value); else next.delete(value);
  return next;
};

// Where a service lies: nothing to say when it is its whole repository, under the same name.
function serviceLine(t: Translate, service: ProposedService): string {
  if (service.path !== null) return t('workspace_service_folder', { repo: service.repo, path: service.path });
  return service.repo === service.name || service.repo.endsWith(`/${service.name}`) ? '' : t('workspace_service_repository', { repo: service.repo });
}

function contractLine(t: Translate, service: ProposedService): string {
  if (!service.contract) return '';
  return service.contract.format === 'openapi' ? t('workspace_contract_openapi', { path: service.contract.path }) : t('workspace_contract_events', { path: service.contract.path });
}

function placesLine(t: Translate, link: ProposedLink): string {
  return link.places.map((place) => t('workspace_place', { file: place.file, line: place.line })).join('; ');
}

export function WorkspaceStep({ t, api, onDone, initial }: StepProps<Initial>) {
  const [view, setView] = useState<WorkspaceView | undefined>(initial?.view);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set(initial?.picked ?? []));
  const [whole, setWhole] = useState<ReadonlySet<string>>(new Set());
  const [proposal, setProposal] = useState<WorkspaceProposal | undefined>(initial?.proposal);
  const [left, setLeft] = useState<ReadonlySet<string>>(new Set());          // services the person unticked
  const [links, setLinks] = useState<ReadonlySet<string>>(new Set());
  const [contracts, setContracts] = useState<ReadonlySet<string>>(new Set());
  const [again, setAgain] = useState(false);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [written, setWritten] = useState<WorkspaceWritten | undefined>();

  const load = () => api.get<WorkspaceView>('/workspace').then((answer) => { if (answer.status === 200) setView(answer.body); });
  useEffect(() => {
    if (initial) return;
    void load();
  }, [api, initial]);

  const ask = (repositories: readonly string[], keptWhole: ReadonlySet<string>) => {
    setBusy(true);
    setError('');
    // Kept whole: only repositories of this request, so an earlier choice of one no longer picked is not sent.
    const body: ProposeBody = { repositories, whole: [...keptWhole].filter((repo) => repositories.includes(repo)) };
    void api.post<WorkspaceProposal>('/workspace/propose', body).then((answer) => {
      if (answer.status !== 200) return setError(refusal(t, 'workspace', answer.body));
      setProposal(answer.body);
      setLeft(new Set());
      setLinks(new Set());
      setContracts(new Set());
    }, () => setError(t('workspace_error_other'))).finally(() => setBusy(false));
  };

  const submitPick = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setWritten(undefined);
    ask([...picked], whole);
  };

  const write = () => {
    if (!proposal) return;
    setBusy(true);
    setError('');
    const repositories = proposal.repositories.map((r) => r.repo);
    const body: ConfirmBody = {
      repositories, whole: [...whole].filter((repo) => repositories.includes(repo)),
      services: proposal.services.filter((s) => !left.has(s.name)).map((s) => s.name), links: [...links], contracts: [...contracts],
    };
    void api.post<WorkspaceWritten>('/workspace', body).then((answer) => {
      if (answer.status !== 200) return setError(refusal(t, 'workspace', answer.body));
      setWritten(answer.body);
      setProposal(undefined);
      setAgain(false);
      onDone();
      void load();
    }, () => setError(t('workspace_error_other'))).finally(() => setBusy(false));
  };

  const layout = (repo: string, keepWhole: boolean) => {
    const next = toggled(whole, repo, keepWhole);
    setWhole(next);
    ask(proposal?.repositories.map((r) => r.repo) ?? [...picked], next);
  };

  if (!view) return <StepFrame t={t} prefix="workspace"><p className="setup-note" aria-busy="true">{t('setup_loading')}</p></StepFrame>;
  if (view.source === 'environment') return <StepFrame t={t} prefix="workspace" sentence={t('workspace_environment')} detail={<p data-workspace-environment>{t('workspace_environment_detail')}</p>} />;

  const kept = proposal?.services.filter((s) => !left.has(s.name)) ?? [];
  const keptNames = new Set(kept.map((s) => s.name));
  const withContract = kept.filter((s) => s.contract !== null);
  const shownLinks = proposal?.links.filter((link) => keptNames.has(link.from) && keptNames.has(link.to)) ?? [];
  const narrowed = view.repositories.filter((r) => !filter || r.repo.toLowerCase().includes(filter.toLowerCase()));
  // One repository, one service, nothing else found: nothing to choose, one sentence and its button.
  const simple = proposal !== undefined && proposal.services.length === 1 && proposal.links.length === 0
    && proposal.services.every((s) => s.contract === null) && proposal.repositories.every((r) => r.folders.length === 0);
  const showPicker = (!view.connected || again || proposal !== undefined) && !simple;
  const connected = view.connected && !again && !proposal;
  const detail = connected && view.connected ? (
    <div className="setup-saved" data-workspace-connected-detail>
      {view.connected.at ? <p>{t('workspace_connected_detail', { date: dayOf(view.connected.at, t) })}</p> : null}
      <Button className="btn" data-act="setup_workspace_again" onClick={() => { setAgain(true); setWritten(undefined); }}>{t('workspace_again')}</Button>
    </div>
  ) : undefined;

  return (
    <StepFrame t={t} prefix="workspace" detail={detail}>
      <div className="ws" data-workspace-step>
        {written ? <p className="setup-ok" data-workspace-result="ok" role="status">{t('workspace_written', { services: written.services.map((s) => s.name).join(', ') })}</p> : null}
        {connected && view.connected && !written ? (
          <p className="setup-ok" data-workspace-connected role="status">{t('workspace_connected_undated', { services: view.connected.services.map((s) => s.name).join(', ') })}</p>
        ) : null}
        {showPicker && view.problem === 'no_forge' ? (
          <p data-workspace-problem="no_forge">{t('workspace_problem_no_forge')} <a className="setup-link" href="/setup/forge">{t('workspace_to_forge')}</a></p>
        ) : null}
        {showPicker && view.problem === 'unreachable' ? (
          <div className="setup-saved">
            <p className="setup-error" data-workspace-problem="unreachable">{t('workspace_problem_unreachable')}</p>
            <Button className="btn" data-act="setup_workspace_reload" onClick={() => void load()}>{t('workspace_reload')}</Button>
          </div>
        ) : null}
        {showPicker && view.problem === null ? (
          <form className="ws-pick" onSubmit={submitPick} aria-busy={busy}>
            <fieldset>
              <legend className="sr-only">{t('workspace_repositories')}</legend>
              {view.repositories.length > FILTER_FROM ? (
                <div className="ws-filter">
                  <label htmlFor="workspace-filter">{t('workspace_filter')}</label>
                  <Input id="workspace-filter" type="search" value={filter} onChange={(event) => setFilter(event.currentTarget.value)} autoComplete="off" spellCheck={false} />
                </div>
              ) : null}
              {view.repositories.length === 0 ? <p className="setup-note">{t('workspace_none')}</p> : null}
              <ul className="ws-list">
                {narrowed.map((r, i) => (
                  <li key={r.repo}>
                    <input type="checkbox" id={`workspace-repo-${i}`} name="repository" value={r.repo} checked={picked.has(r.repo)}
                      onChange={(event) => { setPicked(toggled(picked, r.repo, event.currentTarget.checked)); setProposal(undefined); }} />
                    <label htmlFor={`workspace-repo-${i}`}><span className="ws-name">{r.repo}</span>{r.private ? <span className="setup-tag">{t('workspace_private')}</span> : null}</label>
                  </li>
                ))}
              </ul>
              {view.archived > 0 ? <p className="setup-note">{view.archived === 1 ? t('workspace_archived_one') : t('workspace_archived', { count: view.archived })}</p> : null}
            </fieldset>
            {error && !proposal ? <p className="setup-error" role="alert">{error}</p> : null}
            {/* Once there is a proposal, writing it is the gesture the step waits for: this one steps back. */}
            <Button variant={proposal ? 'outline' : 'ink'} className={proposal ? 'btn' : 'primary'} type="submit" data-act="setup_workspace_propose" disabled={busy || picked.size === 0}>
              {busy && !proposal ? t('workspace_proposing') : proposal ? t('workspace_propose_again') : t('workspace_propose')}
            </Button>
          </form>
        ) : null}
        {simple && proposal ? (
          <section className="ws-proposal ws-simple" data-workspace-proposal data-workspace-simple aria-busy={busy}>
            <p>{t('workspace_one_service', { service: proposal.services[0]?.name ?? '' })}</p>
            {error ? <p className="setup-error" role="alert">{error}</p> : null}
            <div className="setup-row-actions">
              <Button variant="ink" className="primary" data-act="setup_workspace_write" disabled={busy} onClick={write}>{busy ? t('workspace_writing') : t('workspace_write_one')}</Button>
              <Button variant="ghost" className="btn quiet" data-act="setup_workspace_change" disabled={busy} onClick={() => setProposal(undefined)}>{t('workspace_change')}</Button>
            </div>
          </section>
        ) : null}
        {proposal && !simple ? (
          <section className="ws-proposal" data-workspace-proposal aria-labelledby="workspace-proposal-title" aria-busy={busy}>
            <h3 id="workspace-proposal-title">{t('workspace_proposal_title')}</h3>
            <p className="setup-note">{t('workspace_tick_hint')}</p>
            {/* The radios follow the person's choice at once (whole); the proposal of that choice follows. */}
            {proposal.repositories.filter((r) => r.folders.length > 0).map((r, i) => (
              <fieldset key={r.repo} className="ws-group">
                <legend>{r.from === 'workspaces' ? t('workspace_layout_workspaces', { repo: r.repo }) : t('workspace_layout_manifests', { repo: r.repo })}</legend>
                <ul className="ws-list">
                  <li>
                    <input type="radio" id={`workspace-layout-${i}-folders`} name={`layout-${i}`} value="folders" checked={!whole.has(r.repo)} onChange={() => layout(r.repo, false)} disabled={busy} />
                    <label htmlFor={`workspace-layout-${i}-folders`}>{t('workspace_layout_folders', { count: r.folders.length })}</label>
                  </li>
                  <li>
                    <input type="radio" id={`workspace-layout-${i}-whole`} name={`layout-${i}`} value="whole" checked={whole.has(r.repo)} onChange={() => layout(r.repo, true)} disabled={busy} />
                    <label htmlFor={`workspace-layout-${i}-whole`}>{t('workspace_layout_whole')}</label>
                  </li>
                </ul>
              </fieldset>
            ))}
            <fieldset className="ws-group">
              <legend>{t('workspace_services')}</legend>
              <ul className="ws-list">
                {proposal.services.map((s, i) => {
                  const where = serviceLine(t, s);
                  return (
                    <li key={s.name}>
                      <input type="checkbox" id={`workspace-service-${i}`} name="service" value={s.name} checked={!left.has(s.name)}
                        onChange={(event) => setLeft(toggled(left, s.name, !event.currentTarget.checked))} />
                      <label htmlFor={`workspace-service-${i}`}><span className="ws-name">{s.name}</span>{where ? <span className="ws-meta">{where}</span> : null}</label>
                    </li>
                  );
                })}
              </ul>
            </fieldset>
            {withContract.length > 0 ? (
              <fieldset className="ws-group">
                <legend>{t('workspace_contracts')}</legend>
                <ul className="ws-list">
                  {withContract.map((s, i) => (
                    <li key={s.name}>
                      <input type="checkbox" id={`workspace-contract-${i}`} name="contract" value={s.name} checked={contracts.has(s.name)}
                        onChange={(event) => setContracts(toggled(contracts, s.name, event.currentTarget.checked))} />
                      <label htmlFor={`workspace-contract-${i}`}><span className="ws-name">{s.name}</span><span className="ws-meta">{contractLine(t, s)}</span></label>
                    </li>
                  ))}
                </ul>
              </fieldset>
            ) : null}
            {shownLinks.length > 0 ? (
              <fieldset className="ws-group">
                <legend>{t('workspace_links')}</legend>
                <ul className="ws-list">
                  {shownLinks.map((link, i) => (
                    <li key={link.id}>
                      <input type="checkbox" id={`workspace-link-${i}`} name="link" value={link.id} checked={links.has(link.id)}
                        onChange={(event) => setLinks(toggled(links, link.id, event.currentTarget.checked))} />
                      <label htmlFor={`workspace-link-${i}`}>
                        <span className="ws-name">{t('workspace_link', { from: link.from, to: link.to, operations: link.items.join(', ') })}</span>
                        <span className="ws-meta">{t('workspace_link_found', { places: placesLine(t, link) })}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>
            ) : null}
            {error ? <p className="setup-error" role="alert">{error}</p> : null}
            <Button variant="ink" className="primary" data-act="setup_workspace_write" disabled={busy || kept.length === 0} onClick={write}>
              {busy ? t('workspace_writing') : t('workspace_write')}
            </Button>
          </section>
        ) : null}
      </div>
    </StepFrame>
  );
}
