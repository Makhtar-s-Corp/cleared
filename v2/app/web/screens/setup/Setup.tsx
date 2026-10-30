// The setup assistant (docs/v2/milestone-5-plan.md, section 5; redone by the
// owner's direction of 2026-10-30, issue #497): a page of its own at /setup and
// /setup/<step>, beside the shell. The steps at the left, each a name and a
// mark; the step of the address, one sentence and one action; Back, Skip where
// the step allows it, and Continue once it is done. The sessions it starts are
// a click away and a session that waits is said on every step (live.tsx). Before
// the owner exists (the page's stage `first`), the owner's form alone; after it,
// the owner's steps through the service. Moving between steps changes the
// address in the page (history), so Back in the browser goes back a step.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import type { OwnerMade, SetupView, StepId } from '../../../../src/setup/types.ts';
import { STEP_IDS } from '../../../../src/setup/types.ts';
import { Button } from '@/components/ui/button.tsx';
import { Toggle } from '@/components/ui/toggle.tsx';
import { Check } from '@phosphor-icons/react';
import type { Language } from '@/lib/catalogs.ts';
import { browserStore, rememberLanguage } from '@/lib/language.ts';
import type { Translate } from '@/lib/i18n.ts';
import { setupPath, setupPlaceOf } from '@/lib/routes.ts';
import { Logo } from '@/shell/Logo.tsx';
import { firstView, nextStep, previousStep, setupApi, setupTranslator, stepKey, type SetupApi } from './model.ts';
import { WaitingAlert, WatchContext, useWatch } from './live.tsx';
import { Detail, type StepProps } from './step.tsx';
import { ChecksStep } from './steps/Checks.tsx';
import { EnvironmentStep } from './steps/Environment.tsx';
import { FirstTicketStep, SetupSummary } from './steps/FirstTicket.tsx';
import { ForgeStep } from './steps/Forge.tsx';
import { ModelStep } from './steps/Model.tsx';
import { OwnerFirst, OwnerMadePanel, OwnerStep } from './steps/Owner.tsx';
import { SecretsStep } from './steps/Secrets.tsx';
import { WorkspaceStep } from './steps/Workspace.tsx';
import './setup.css';

const SCREENS: Readonly<Record<StepId, ComponentType<StepProps<never>>>> = {
  owner: OwnerStep, forge: ForgeStep, model: ModelStep, workspace: WorkspaceStep,
  environment: EnvironmentStep, secrets: SecretsStep, checks: ChecksStep, 'first-ticket': FirstTicketStep,
};

export function Progress({ t, view, current, linked = false }: { readonly t: Translate; readonly view: SetupView; readonly current: StepId | null; readonly linked?: boolean }) {
  const at = current ? STEP_IDS.indexOf(current) : -1;
  return (
    <nav className="setup-nav" aria-label={t('setup_progress_label')}>
      {current ? <p className="setup-count">{t('setup_step_of', { n: at + 1, total: STEP_IDS.length })}</p> : null}
      <ol className="setup-progress">
        {view.steps.map((step, index) => {
          const here = step.id === current;
          const name = t(`setup_step_${stepKey(step.id)}`);
          const done = step.state === 'done';
          return (
            <li key={step.id} data-step={step.id} data-state={step.state} aria-current={here ? 'step' : undefined}>
              <span className="setup-mark" aria-hidden="true">{done ? <Check size={12} weight="bold" /> : index + 1}</span>
              {linked && !here ? <a href={setupPath(step.id)}>{name}</a> : <span className="setup-progress-name">{name}</span>}
              {/* Its state in words, for who does not see the mark. */}
              <span className="sr-only">{t(`setup_state_${step.state}`)}</span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// The language choice of the shell's menu, on the assistant's page too
// (issue #431): the page follows the person's choice, else the browser's
// languages, else CLEARED_V2_APP_LANGUAGE (src/catalog.ts, languageOf), so
// a newcomer whose browser asks for another language than the install's
// can change it before the menu exists.
export function LanguageChoice({ t, language, onLanguage }: { readonly t: Translate; readonly language: Language; readonly onLanguage: (language: Language) => void }) {
  return (
    <div className="setup-language" role="group" aria-label={t('language_label')}>
      {LANGUAGES.map((each) => (
        <Toggle key={each} lang={each} data-language={each} pressed={language === each} onPressedChange={() => onLanguage(each)}>{t(`language_${each}`)}</Toggle>
      ))}
    </div>
  );
}

// French first, as the shell's menu lists them.
const LANGUAGES: readonly Language[] = ['fr', 'en'];

const Languages = createContext<{ readonly language: Language; readonly onLanguage: (language: Language) => void } | null>(null);

function Shell({ t, view, current, linked, children }: { readonly t: Translate; readonly view: SetupView; readonly current: StepId | null; readonly linked?: boolean; readonly children: ReactNode }) {
  const languages = useContext(Languages);
  const { waiting } = useContext(WatchContext);
  return (
    <div className="setup">
      <header className="setup-head">
        <div className="setup-brand">
          <Logo /><span className="name">{t('app_name')}</span>
          {linked ? (
            <a className="setup-sessions" href="/sessions" data-setup-sessions aria-label={waiting.length > 0 ? t('setup_sessions_waiting', { count: waiting.length }) : undefined}>
              {t('setup_sessions')}{waiting.length > 0 ? <span className="setup-count-badge" aria-hidden="true">{waiting.length}</span> : null}
            </a>
          ) : null}
          {languages ? <LanguageChoice t={t} {...languages} /> : null}
        </div>
        <h1 className="sr-only">{t('setup_heading')}</h1>
      </header>
      <div className="setup-body">
        <Progress t={t} view={view} current={current} linked={linked} />
        <main className="setup-main">
          {linked ? <WaitingAlert t={t} /> : null}
          <div className="setup-panel">{children}</div>
        </main>
      </div>
    </div>
  );
}

// Before the owner exists: the code's form, then the public key and Continue.
function FirstStage({ t }: { readonly t: Translate }) {
  const [made, setMade] = useState<OwnerMade | undefined>();
  const view = useMemo(firstView, []);
  return (
    <Shell t={t} view={made ? { ...view, steps: view.steps.map((s) => (s.id === 'owner' ? { ...s, state: 'done' } : s)) } : view} current="owner">
      {made ? (
        <section className="setup-step" aria-labelledby="setup-step-title">
          <h2 id="setup-step-title">{t('owner_done_title')}</h2>
          <OwnerMadePanel t={t} made={made} />
          <div className="setup-actions">
            <span className="setup-actions-gap" />
            <Button variant="ink" className="primary" data-act="setup_next" onClick={() => location.assign(setupPath('forge'))}>{t('setup_next')}</Button>
          </div>
        </section>
      ) : <OwnerFirst t={t} onMade={setMade} />}
    </Shell>
  );
}

type Loaded = { readonly csrf: string; readonly terminal: boolean; readonly api: SetupApi };

function SignedStage({ t, start }: { readonly t: Translate; readonly start: StepId | null }) {
  const [loaded, setLoaded] = useState<Loaded | undefined>();
  const [view, setView] = useState<SetupView | undefined>();
  const [step, setStep] = useState<StepId | null>(start);
  const [failed, setFailed] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [own, setOwn] = useState(false);
  const watch = useWatch(loaded !== undefined);

  useEffect(() => {
    let gone = false;
    setFailed('');
    void (async () => {
      const me = await fetch('/api/me', { headers: { accept: 'application/json' } });
      if (!me.ok) throw new Error(String(me.status));
      const { csrf, terminal } = await me.json() as { csrf: string; terminal: boolean };
      const api = setupApi(csrf);
      const answer = await api.get<SetupView>('');
      if (gone) return;
      if (answer.status === 403) return setFailed(t('setup_not_owner'));
      if (answer.status !== 200) throw new Error(String(answer.status));
      setLoaded({ csrf, terminal, api });
      setView(answer.body);
      setStep((shown) => shown ?? answer.body.current);
    })().catch(() => { if (!gone) setFailed(t('setup_failed')); });
    return () => { gone = true; };
  }, [t, attempt]);

  // The address follows the step; Back in the browser goes back a step.
  useEffect(() => {
    const target = step ? setupPath(step) : '/setup';
    if (loaded && location.pathname !== target) history.pushState(null, '', target);
  }, [loaded, step]);
  useEffect(() => {
    const back = () => { const place = setupPlaceOf(location.pathname); if (place) setStep(place.step); };
    addEventListener('popstate', back);
    return () => removeEventListener('popstate', back);
  }, []);
  // A step shown: its clock starts (the first time counts).
  useEffect(() => {
    if (!loaded || !step) return;
    void loaded.api.post<SetupView>(`/${step}/shown`).then((answer) => { if (answer.status === 200) setView(answer.body); });
  }, [loaded, step]);

  const reload = useCallback(() => {
    if (!loaded) return;
    void loaded.api.get<SetupView>('').then((answer) => { if (answer.status === 200) setView(answer.body); });
  }, [loaded]);

  if (failed) {
    return (
      <Shell t={t} view={view ?? firstView()} current={null}>
        <p className="setup-error" role="alert">{failed}</p>
        <Button className="btn" data-act="setup_retry" onClick={() => setAttempt((n) => n + 1)}>{t('setup_retry')}</Button>
      </Shell>
    );
  }
  if (!loaded || !view) return <Shell t={t} view={firstView()} current={null}><p className="setup-note" aria-busy="true">{t('setup_loading')}</p></Shell>;

  if (!step) {
    return (
      <WatchContext.Provider value={watch}>
        <Shell t={t} view={view} current={null} linked>
          <section className="setup-step" aria-labelledby="setup-step-title" data-setup-finished>
            <h2 id="setup-step-title">{t('setup_finished_title')}</h2>
            <p className="setup-intro">{t('setup_finished_body')}</p>
            {view.steps.some((s) => s.state === 'skipped') ? <p className="setup-note">{t('setup_finished_skipped')}</p> : null}
            <div className="setup-actions">
              <span className="setup-actions-gap" />
              <Button variant="ink" className="primary" data-act="setup_tower" onClick={() => location.assign('/')}>{t('setup_tower')}</Button>
            </div>
            <Detail t={t} label={t('first_ticket_summary_toggle')}><SetupSummary t={t} view={view} /></Detail>
          </section>
        </Shell>
      </WatchContext.Provider>
    );
  }

  const shown = view.steps.find((s) => s.id === step);
  if (!shown) return null;
  const Screen = SCREENS[step];
  const back = previousStep(step);
  const skip = () => void loaded.api.post<SetupView>(`/${step}/skip`).then((answer) => {
    if (answer.status !== 200) return;
    setView(answer.body);
    setOwn(false);
    setStep(nextStep(step));
  });
  const go = (target: StepId | null) => { setOwn(false); setStep(target); };
  return (
    <WatchContext.Provider value={watch}>
      <Shell t={t} view={view} current={step} linked>
        <Screen key={step} t={t} step={shown} api={loaded.api} onDone={reload} csrf={loaded.csrf} terminalHere={loaded.terminal} onOwnAction={setOwn} />
        <div className="setup-actions">
          {back ? <Button variant="ghost" className="btn quiet" data-act="setup_back" onClick={() => go(back)}>{t('setup_back')}</Button> : null}
          <span className="setup-actions-gap" />
          {shown.skippable && shown.state === 'todo' ? <Button variant="ghost" className="btn quiet" data-act="setup_skip" onClick={skip}>{t('setup_skip')}</Button> : null}
          {shown.state !== 'todo' ? <Button variant={own ? 'outline' : 'ink'} className={own ? 'btn' : 'primary'} data-act="setup_next" onClick={() => go(nextStep(step))}>{t('setup_next')}</Button> : null}
        </div>
      </Shell>
    </WatchContext.Provider>
  );
}

export function SetupScreen({ language: start, stage, step }: { readonly language: Language; readonly stage: 'first' | 'signed'; readonly step: StepId | null }) {
  const [language, setLanguage] = useState<Language>(start);
  const languages = useMemo(() => ({
    language,
    onLanguage: (next: Language) => { rememberLanguage(next, browserStore(), document, location.protocol === 'https:'); setLanguage(next); },
  }), [language]);
  const t = useMemo(() => setupTranslator(language), [language]);
  return (
    <Languages.Provider value={languages}>
      {stage === 'first' ? <FirstStage t={t} /> : <SignedStage t={t} start={step} />}
    </Languages.Provider>
  );
}

export default SetupScreen;
