// The JSON-RPC 2.0 core of the service's MCP servers: the ledger's over
// stdio (server.ts) and the lanes' over HTTP (lanes.ts, http.ts). It answers
// initialize, ping, tools/list and tools/call, reads a tool's arguments as
// its schema declares them, and says a refusal (a ToolError) as the tool's
// own error in the server's words. Every tool it offers only reads.
import type { Translate, Values } from '../../app/web/lib/i18n.ts';

// Newest first: the version answered to a client that asks for another.
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

// A call the server refuses: the key of its message in the catalog.
export class ToolError extends Error {
  override name = 'ToolError';
  readonly key: string;
  readonly values: Values;
  constructor(key: string, values: Values = {}) {
    super(key);
    this.key = key;
    this.values = values;
  }
}

type Kind = 'string' | 'integer';
export type Argument = { readonly kind: Kind; readonly description: string; readonly enum?: readonly string[] };
export type Tool = { readonly name: string; readonly description: string; readonly args: Readonly<Record<string, Argument>>; readonly required?: readonly string[] };
export type Args = Readonly<Record<string, string | number>>;

const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const schema = (tool: Tool) => ({
  type: 'object',
  properties: Object.fromEntries(Object.entries(tool.args).map(([name, arg]) => [name, { type: arg.kind, description: arg.description, ...(arg.enum ? { enum: arg.enum } : {}) }])),
  ...(tool.required ? { required: tool.required } : {}),
  additionalProperties: false,
});

type Id = string | number | null;
export type Response = { readonly jsonrpc: '2.0'; readonly id: Id; readonly result?: unknown; readonly error?: { readonly code: number; readonly message: string } };

export type ToolServer = {
  // The answer to one message, or undefined for a notification.
  handle(message: unknown): Promise<Response | undefined>;
  // The answer to a line that is not JSON.
  unparsable(): Response;
};

export type ToolServerOptions = {
  readonly t: Translate;
  readonly info: { readonly name: string; readonly version: string };
  readonly tools: readonly Tool[];
  // A tool's answer, from its checked arguments; a ToolError is its refusal.
  readonly run: (tool: Tool, args: Args) => unknown;
  readonly label: string;                     // the server's name in a line for the operator
  readonly log?: (line: string) => void;      // what failed, for the operator; never sent to the client
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// A tool's answer: its value as text and as structured content.
export const answer = (value: Record<string, unknown>) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });

export function createToolServer(options: ToolServerOptions): ToolServer {
  const { t, tools } = options;
  const ok = (id: Id, result: unknown): Response => ({ jsonrpc: '2.0', id, result });
  const fail = (id: Id, code: number, message: string): Response => ({ jsonrpc: '2.0', id, error: { code, message } });
  const refused = (key: string, values?: Values) => ({ content: [{ type: 'text', text: t(key, values) }], isError: true });

  // The arguments as the schema declares them: an unknown name, a wrong
  // type or a missing required one is refused with its name.
  function read(tool: Tool, input: unknown): Args {
    const args = isRecord(input) ? input : {};
    for (const [name, value] of Object.entries(args)) {
      const arg = tool.args[name];
      if (!arg) throw new ToolError('error_unknown_argument', { name });
      if (arg.kind === 'string' ? typeof value !== 'string' : !Number.isInteger(value)) throw new ToolError('error_argument_type', { name });
      if (arg.enum && !arg.enum.includes(value as string)) throw new ToolError('error_argument_type', { name });
    }
    for (const name of tool.required ?? []) if (args[name] === undefined) throw new ToolError('error_required', { name });
    return args as Args;
  }

  async function call(id: Id, params: unknown): Promise<Response> {
    const name = isRecord(params) ? params.name : undefined;
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) return fail(id, -32602, t('error_unknown_tool', { name: typeof name === 'string' ? name.slice(0, 64) : '' }));
    try {
      return ok(id, await options.run(tool, read(tool, isRecord(params) ? params.arguments : undefined)));
    } catch (error) {
      if (error instanceof ToolError) return ok(id, refused(error.key, error.values));
      options.log?.(`cleared-v2 ${options.label}: ${tool.name} failed: ${error instanceof Error ? error.message : String(error)}`);
      return ok(id, refused('error_read'));
    }
  }

  return {
    async handle(message) {
      if (!isRecord(message)) return fail(null, -32600, t('rpc_invalid'));
      const notification = !('id' in message);
      const id: Id = typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null;
      if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') return notification ? undefined : fail(id, -32600, t('rpc_invalid'));
      if (notification) return undefined;
      const params = message.params;
      switch (message.method) {
        case 'initialize': {
          const asked = isRecord(params) ? params.protocolVersion : undefined;
          const version = PROTOCOL_VERSIONS.find((v) => v === asked) ?? PROTOCOL_VERSIONS[0];
          return ok(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: options.info, instructions: t('instructions') });
        }
        case 'ping': return ok(id, {});
        case 'tools/list': return ok(id, { tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: schema(tool), annotations: ANNOTATIONS })) });
        case 'tools/call': return call(id, params);
        default: return fail(id, -32601, t('rpc_method', { name: message.method.slice(0, 64) }));
      }
    },
    unparsable: () => fail(null, -32700, t('rpc_parse')),
  };
}
