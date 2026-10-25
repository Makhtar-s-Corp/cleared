// The flow module (lane 7): the ticket's path from Todo to the release
// request lives in flow/engine.ts; this module declares the ticket routes
// that start it (create, list, get, move). The approval route is lane 8's.
// The release trains of a workspace of several services (lane 16) are kept
// in release_trains. The session plan's Go and Change (lane 17) are
// flow/plan-gate.ts's; the Editor tab's files and Take over and Give back
// (lane 20) are flow/files.ts's and flow/takeover.ts's. A ticket's steps,
// in ticket_steps, and the contract item's Approve and Send back (lane 23)
// are flow/steps.ts's; a ticket's variants, in ticket_variants, and the
// variants item's choice (issue #271) are flow/variants.ts's; Resume from
// here (issue #272), in ticket_replays, is flow/replay.ts's; the batches of
// tickets (requirement C6), in batches and batch_items, are flow/batch.ts's,
// whose runner starts with the engine and passes on the flow's events and
// on its own timer. The web terminal of a session taken over and the
// editor's save (lane 31) are terminal/routes.ts's and flow/files.ts's,
// with one human side per process (terminal/human.ts), made with the
// engine and the store this module receives. The idle watchdog (issue #290,
// session/watchdog.ts) starts with the engine, on its own timer. The
// captures of a pull request's proof receipt (P210) and the human's choice
// of them on a ticket (P226, capture_choices) are flow/proof-routes.ts's.
// A ticket launched from a chat (P212), POST /hooks/chat with chat_seen,
// chat_launches and chat_replies, is flow/chat.ts's: a batch of one on the
// batches' runner, whose replies follow the flow's events. The lanes' MCP
// server (P216), POST /mcp behind the v2-mcp-token file made at start, is
// mcp/http.ts's: it reads the engine and the store, and writes nothing.
import { dirname } from 'node:path';
import type { Language } from '../../app/src/catalog.ts';
import { LeverStore } from '../consumption/levers.ts';
import { Docker } from '../container/docker.ts';
import { BATCH_TABLES, BatchRunner, batchRoutes } from '../flow/batch.ts';
import { CAPTURE_CHOICES_TABLE } from '../flow/capture-choice.ts';
import { CHAT_TABLES, ChatConfigError, ChatLauncher, chatRoutes, loadChatConfig, type ChatConfig } from '../flow/chat.ts';
import { editorRoutes } from '../flow/editor.ts';
import { FAST_LANES_TABLE } from '../flow/fast-lane.ts';
import { filesRoutes } from '../flow/files.ts';
import { planGateRoutes } from '../flow/plan-gate.ts';
import { proofRoutes } from '../flow/proof-routes.ts';
import { REPLAYS_TABLE, replayRoutes } from '../flow/replay.ts';
import { runtime } from '../flow/runtime.ts';
import { STEPS_TABLE, stepRoutes } from '../flow/steps.ts';
import { takeoverRoutes } from '../flow/takeover.ts';
import { VARIANTS_TABLE, variantRoutes } from '../flow/variants.ts';
import { loadPlanConfig } from '../lead/plans/runner.ts';
import { lanesMcpRoutes, mcpTokenPath, readOrCreateMcpToken } from '../mcp/http.ts';
import { createRedactor, type Redactor } from '../mcp/redact.ts';
import { TRAIN_TABLE } from '../release/store.ts';
import { ledgerPath, type Store } from '../store/db.ts';
import { dockerContainer } from '../terminal/container.ts';
import { IdleWatchdog } from '../session/watchdog.ts';
import { HumanSide } from '../terminal/human.ts';
import { terminalRoutes } from '../terminal/routes.ts';
import type { Module, Registry } from './registry.ts';

let store: Store | undefined;
let human: HumanSide | undefined;
let watchdog: IdleWatchdog | undefined;
let batches: BatchRunner | undefined;
// The batches' runner, on the engine and the store; the week stop is the plans' (CLEARED_V2_WEEK_STOP_PERCENT).
function batchesOf(registry: Registry): BatchRunner | undefined {
  if (batches || !store) return batches;
  const engine = runtime.engine(registry);
  if (!engine) return undefined;
  const project = engine.config.project;
  batches = new BatchRunner({
    db: store.db, tickets: engine.registry.ticketStore, flow: engine, project,
    levers: new LeverStore(store.db, project), weekStopPercent: loadPlanConfig(process.env).weekStopPercent,
  });
  batches.listen();
  batches.startTimer();
  return batches;
}
let chat: ChatLauncher | undefined;
let chatConfig: ChatConfig | undefined | null = null;
// The chat's settings, read once; a bad setting is said and leaves the route off.
function chatConfigOf(): ChatConfig | undefined {
  if (chatConfig !== null) return chatConfig;
  try {
    chatConfig = loadChatConfig(process.env);
  } catch (error) {
    if (!(error instanceof ChatConfigError)) throw error;
    console.error(`cleared-v2: ${error.message}`);
    chatConfig = undefined;
  }
  return chatConfig;
}
// The chat's launcher, on the batches' runner and the engine's users.
function chatOf(registry: Registry): ChatLauncher | undefined {
  if (chat || !store) return chat;
  const config = chatConfigOf();
  const runner = config ? batchesOf(registry) : undefined;
  const engine = runtime.engine(registry);
  if (!config || !runner || !engine) return undefined;
  chat = new ChatLauncher({ db: store.db, runner, flow: engine, users: engine.registry.users, config });
  chat.listen();
  return chat;
}
// The ledger's folder, for the cleaner. main.ts places the ledger before any
// module starts and exits with 64 when it cannot (test/main.test.ts), so
// none only for a start without main.ts, whose POST /mcp then has no token.
function ledgerFolder(): string[] {
  try { return [dirname(ledgerPath(process.env))]; } catch { return []; }
}
// The lanes' MCP language and cleaner, read at start from the environment
// of that moment (issue #348); a request before any start reads them then.
let mcpSettings: { language: Language; redactor: Redactor } | undefined;
function readMcpSettings(): { language: Language; redactor: Redactor } {
  return {
    language: process.env.CLEARED_V2_APP_LANGUAGE === 'en' ? 'en' : 'fr',
    redactor: createRedactor({ env: process.env, paths: ledgerFolder() }),
  };
}
const mcpSettingsOf = () => (mcpSettings ??= readMcpSettings());

let mcpToken: string | undefined | null = null;
// The lanes' MCP token, made or read once; a token that cannot be is said
// (never its value) and leaves POST /mcp answering 503.
function mcpTokenOf(): string | undefined {
  if (mcpToken !== null) return mcpToken;
  try {
    mcpToken = readOrCreateMcpToken(mcpTokenPath(ledgerPath(process.env)));
  } catch (error) {
    console.error(`cleared-v2: ${error instanceof Error ? error.message : String(error)}`);
    mcpToken = undefined;
  }
  return mcpToken;
}

function humanOf(registry: Registry): HumanSide | undefined {
  if (human || !store) return human;
  const engine = runtime.engine(registry);
  if (!engine) return undefined;
  human = new HumanSide({ engine, store, container: dockerContainer(new Docker()) });
  human.startTimer();
  return human;
}

const flow: Module = {
  tables: [TRAIN_TABLE, STEPS_TABLE, VARIANTS_TABLE, REPLAYS_TABLE, ...BATCH_TABLES, ...CHAT_TABLES, FAST_LANES_TABLE, CAPTURE_CHOICES_TABLE],
  routes: [
    ...runtime.routes((path) => path.startsWith('/api/tickets')),
    ...planGateRoutes({ engine: (registry) => runtime.engine(registry), proof: () => runtime.proof() }),
    ...takeoverRoutes({ engine: (registry) => runtime.engine(registry), proof: () => runtime.proof(), human: humanOf }),
    ...filesRoutes({ engine: (registry) => runtime.engine(registry), proof: () => runtime.proof(), human: humanOf }),
    ...editorRoutes({ engine: (registry) => runtime.engine(registry), proof: () => runtime.proof() }),
    ...terminalRoutes({ engine: (registry) => runtime.engine(registry), proof: () => runtime.proof(), human: humanOf }),
    ...stepRoutes({ engine: (registry) => runtime.engine(registry), proof: () => runtime.proof() }),
    ...variantRoutes({ engine: (registry) => runtime.engine(registry), proof: () => runtime.proof() }),
    ...proofRoutes({ engine: (registry) => runtime.engine(registry), proof: () => runtime.proof() }),
    ...replayRoutes({ engine: (registry) => runtime.engine(registry), proof: () => runtime.proof() }),
    ...batchRoutes({ runner: batchesOf, proof: () => runtime.proof() }),
    ...chatRoutes({ config: chatConfigOf, launcher: chatOf }),
    ...lanesMcpRoutes({
      engine: (registry) => runtime.engine(registry), store: () => store, token: mcpTokenOf,
      language: () => mcpSettingsOf().language,
      redactor: () => mcpSettingsOf().redactor,
      log: (line) => console.error(line),
    }),
  ],
  provide: (deps) => {
    store = deps.store;
    return {};
  },
  // The engine is built at start, not at the first request: its restart
  // recovery stops what the last process left, puts its tickets back, and
  // releases the stopped sessions' containers and networks. The watchdog
  // starts with it, once a minute, and so does the batches' runner, whose
  // queue a restart finishes, and the chat's replies, which a restart
  // still sends. The lanes' MCP token is made then, for its install line,
  // with or without a project (issue #350), and the MCP route's language
  // and cleaner are read then, engine or not.
  start: (registry) => {
    mcpTokenOf();
    mcpSettings = readMcpSettings();
    const engine = runtime.engine(registry);
    if (!engine || !store) return;
    batchesOf(registry);
    chatOf(registry);
    if (watchdog) return;
    const docker = new Docker();
    watchdog = new IdleWatchdog({
      store, project: engine.config.project, idleMs: engine.config.idleMs,
      owner: (session) => engine.idleStop(session),
      release: (session) => docker.releaseStopped([session]),
    });
    watchdog.startTimer();
  },
  // Ends the watchdog's and the batches' timers and awaits the passes they run, and the chat's
  // replies, so that the store does not close under them; a second start builds new ones.
  stop: async () => {
    const ending = watchdog;
    const runner = batches;
    const replies = chat;
    watchdog = undefined;
    batches = undefined;
    chat = undefined;
    await ending?.close();
    await replies?.close();
    await runner?.close();
  },
};

export default flow;
