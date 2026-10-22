// CopilotKit for a screen, headless and local: a CopilotKitCoreReact with
// the screen's agents, provided through CopilotKit's own React context, and
// useThread(), which connects an agent and redraws on what it says.
//
// Only @copilotkit/react-core/v2/headless and /v2/context are imported: the
// root and /v2 entries bring CopilotKit's stylesheet, its prebuilt chat
// (Lucide icons) and its web inspector (Google Fonts). No runtimeUrl, no
// publicApiKey, no license key: the core then has no server to call, and
// sends nothing (test/copilot.test.tsx watches every request).
import './zod.ts';
import { CopilotKitContext, CopilotKitCoreReact, EMPTY_SET, type CopilotKitContextValue } from '@copilotkit/react-core/v2/context';
import { UseAgentUpdate, useAgent, useCopilotKit } from '@copilotkit/react-core/v2/headless';
import { useEffect, useMemo, type ReactNode } from 'react';
import type { ThreadAgent } from './agent.ts';

export function makeCopilot(agents: Readonly<Record<string, ThreadAgent<object>>>): CopilotKitContextValue {
  const copilotkit = new CopilotKitCoreReact({ agents__unsafe_dev_only: { ...agents } });
  return { copilotkit, executingToolCallIds: EMPTY_SET, showIntelligenceIndicator: false };
}

export function CopilotThreads({ agents, children }: { readonly agents: Readonly<Record<string, ThreadAgent<object>>>; readonly children: ReactNode }) {
  // The agents are the screen's for its whole life: made once.
  const value = useMemo(() => makeCopilot(agents), []);
  return <CopilotKitContext.Provider value={value}>{children}</CopilotKitContext.Provider>;
}

const UPDATES = [UseAgentUpdate.OnStateChanged, UseAgentUpdate.OnMessagesChanged];

// The agent's state, once its stream has said something; undefined before.
export function useThread<S extends object>(agentId: string, ready: (state: object) => state is S): { readonly agent: ThreadAgent<S>; readonly state: S | undefined } {
  const { agent } = useAgent({ agentId, updates: UPDATES });
  const { copilotkit } = useCopilotKit();
  useEffect(() => {
    void copilotkit.connectAgent({ agent });
    return () => { void agent.detachActiveRun(); };
  }, [copilotkit, agent]);
  const state = agent.state as object;
  return { agent: agent as unknown as ThreadAgent<S>, state: ready(state) ? state : undefined };
}
