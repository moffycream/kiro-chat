import { randomUUID } from "node:crypto";
import type { RequestHandler } from "./acpClient";

/**
 * Qoder through its own Agent SDK, presented to `KiroSession` as though it
 * were an ACP agent.
 *
 * `qodercli --acp` reports no credits at all — every token count is 0 — and
 * its stream-json mode, which does, auto-denies every edit because it cannot
 * ask. The SDK is the one route that has both: it runs `qodercli --sdk` as a
 * daemon, asks through `canUseTool`, and ends each turn with the session's
 * running `total_credits`. Measured against qodercli 1.1.91 with SDK 1.0.59.
 *
 * The surface is `AcpClient`'s (`start`, `stop`, `request`, `notify`,
 * `isRunning`), and what comes back is the ACP shapes `KiroSession` already
 * reads — `session/update` with message, thought and tool updates,
 * `session_info_update` for context and credits, and
 * `session/request_permission` for the question. That keeps every rule the
 * session enforces (reviews, the one-gate skip, Plan's restore, the queue of
 * permission cards) in one place rather than two.
 *
 * Free of `vscode` on purpose; the SDK is handed in as `loadSdk` so the tests
 * can drive this with a fake.
 */

export interface QoderSdkClientOptions {
  /** The user's own qodercli, which the SDK's daemon runs. */
  cliPath: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Resolves to the SDK module (`out/vendor/qoder-agent-sdk.mjs`). */
  loadSdk: () => Promise<any>;
  onNotification: (method: string, params: any) => void;
  onRequest: RequestHandler;
  onLog: (line: string) => void;
  onExit: (code: number | null, signal: string | null) => void;
}

interface Turn {
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  cancelled: boolean;
}

interface Session {
  id: string;
  query: any;
  inbox: Inbox;
  turn?: Turn;
  /** The session's credits before the turn in flight; unknown after a resume. */
  creditBase?: number;
  /** The assistant message the stream is inside, so its full copy is not shown twice. */
  messageId?: string;
  streamed: Set<string>;
  /** Each step's tool and input, so its later updates keep the title it started with. */
  announced: Map<string, { name: string; input: any }>;
  closed: boolean;
}

/** An async iterable the SDK reads user messages from, for as long as the session lives. */
class Inbox {
  private queue: any[] = [];
  private wake?: () => void;
  private done = false;

  push(message: any): void {
    this.queue.push(message);
    this.wake?.();
  }

  end(): void {
    this.done = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<any> {
    for (;;) {
      while (this.queue.length) yield this.queue.shift();
      if (this.done) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = undefined;
    }
  }
}

/** ACP's tool kinds, which is what `writeTools.ts` and the step list classify on. */
export function toolKindOf(name: string): string {
  switch (name) {
    case "Read":
      return "read";
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return "edit";
    case "Bash":
      return "execute";
    case "Grep":
    case "Glob":
      return "search";
    case "WebFetch":
    case "WebSearch":
      return "fetch";
    default:
      return "other";
  }
}

function pathOf(input: any): string | undefined {
  const value = input?.file_path ?? input?.notebook_path ?? input?.path;
  return typeof value === "string" && value ? value : undefined;
}

/** "Edit C:\w\hello.txt", the form `qodercli --acp` titled its steps with. */
export function toolTitleOf(name: string, input: any): string {
  const target =
    pathOf(input) ??
    [input?.command, input?.pattern, input?.url, input?.query, input?.description].find(
      (value) => typeof value === "string" && value.trim()
    );
  const text = typeof target === "string" ? target.trim().split("\n")[0].slice(0, 160) : "";
  return text ? `${name} ${text}` : name;
}

/** An ACP `tool_call` / `tool_call_update` for one SDK tool use. */
export function toolUpdateOf(
  id: string,
  name: string,
  input: any,
  status: string,
  first: boolean
): any {
  const path = pathOf(input);
  return {
    sessionUpdate: first ? "tool_call" : "tool_call_update",
    toolCallId: id,
    title: toolTitleOf(name, input),
    kind: toolKindOf(name),
    status,
    rawInput: input ?? {},
    ...(path ? { locations: [{ path }] } : {}),
  };
}

function textOfToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** A local path from a `resource_link` URI, in either spelling the panel sends. */
export function pathFromLink(uri: string): string {
  if (!/^file:/i.test(uri)) return uri;
  let rest = uri.replace(/^file:\/\//i, "");
  if (/^\/[A-Za-z](:|%3A)/i.test(rest)) rest = rest.slice(1);
  try {
    rest = decodeURIComponent(rest);
  } catch {
    // Already a plain path; Qoder's own form is not encoded.
  }
  return rest.replace(/\//g, "\\");
}

/**
 * The SDK's user message from ACP prompt blocks. A `resource_link` becomes a
 * line naming the file, which Qoder then opens with its Read tool — the same
 * thing `qodercli --acp` did with one, and without sending the file twice.
 */
export function userMessageOf(blocks: any[]): any {
  const content: any[] = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block?.type === "text" && typeof block.text === "string") {
      content.push({ type: "text", text: block.text });
    } else if (block?.type === "image" && typeof block.data === "string") {
      content.push({
        type: "image",
        source: { type: "base64", media_type: block.mimeType ?? "image/png", data: block.data },
      });
    } else if (block?.type === "resource_link" && typeof block.uri === "string") {
      content.push({ type: "text", text: `Attached file: ${pathFromLink(block.uri)}` });
    }
  }
  return { type: "user", parent_tool_use_id: null, message: { role: "user", content } };
}

/** Qoder's model list as the `configOptions` model select `configOptions.ts` reads. */
export function modelOptionOf(models: any[], current: string | undefined): any {
  const listed = (Array.isArray(models) ? models : []).filter(
    (model) => model && model.isEnabled !== false && typeof model.value === "string"
  );
  const fallback = listed.find((model) => model.isDefault)?.value ?? listed[0]?.value ?? "auto";
  return {
    type: "select",
    id: "model",
    name: "Model",
    category: "model",
    currentValue: current && listed.some((model) => model.value === current) ? current : fallback,
    options: listed.map((model) => {
      const rate = typeof model.priceFactor === "number" ? `${model.priceFactor.toFixed(2)}x Credit` : "";
      const notes = [model.isReasoning ? "Reasoning" : "", model.isVl ? "Vision" : "", rate].filter(Boolean);
      return {
        value: model.value,
        name: String(model.displayName ?? model.value),
        description: notes.join(" · "),
        ...(typeof model.maxInputTokens === "number" ? { _meta: { contextWindowTokens: model.maxInputTokens } } : {}),
      };
    }),
  };
}

/** Why a turn ended badly, in Qoder's words where it gave any. */
function resultError(message: any): string {
  const errors = Array.isArray(message?.errors) ? message.errors.filter((e: any) => typeof e === "string") : [];
  if (errors.length) return errors.join(" ");
  if (typeof message?.result === "string" && message.result.trim()) return message.result.trim();
  return `Qoder ended the turn (${String(message?.subtype ?? "error")}).`;
}

export class QoderSdkClient {
  private running = false;
  private sdk: any;
  private daemon: any;
  private session?: Session;
  private models: any[] = [];
  private model?: string;
  /** The last conversation's close, which a reopen of the same id must wait out. */
  private closing: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: QoderSdkClientOptions) {}

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    this.running = true;
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    const session = this.session;
    this.session = undefined;
    if (session) this.closeSession(session, new Error("The Qoder agent was stopped."));
    const daemon = this.daemon;
    this.daemon = undefined;
    // The daemon is the qodercli process; leaving it would leave one per restart.
    void Promise.resolve(daemon?.stop?.()).catch((err: unknown) =>
      this.options.onLog(`Could not stop the Qoder daemon: ${String(err)}`)
    );
  }

  request<T = any>(method: string, params?: any, timeoutMs?: number): Promise<T> {
    if (!this.running) return Promise.reject(new Error("The Qoder agent is not running."));
    const work = this.handle(method, params ?? {});
    if (!timeoutMs || timeoutMs <= 0) return work;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Qoder did not answer "${method}" in time.`)), timeoutMs);
      work.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  notify(method: string, params?: any): void {
    if (method !== "session/cancel") return;
    const session = this.session;
    if (!session?.turn || (params?.sessionId && params.sessionId !== session.id)) return;
    session.turn.cancelled = true;
    void Promise.resolve(session.query.interrupt?.()).catch((err: unknown) =>
      this.options.onLog(`Qoder interrupt failed: ${String(err)}`)
    );
  }

  private async handle(method: string, params: any): Promise<any> {
    switch (method) {
      case "initialize":
        return this.initialize();
      case "session/new":
        return this.open(undefined);
      case "session/load":
        return this.open(String(params.sessionId ?? ""), params._meta?.qoder?.priorCredits);
      case "session/close":
        if (this.session && this.session.id === params.sessionId) {
          const session = this.session;
          this.session = undefined;
          this.closeSession(session, new Error("The conversation was closed."));
        }
        return {};
      case "session/set_config_option":
        return this.setConfigOption(String(params.configId ?? ""), String(params.value ?? ""));
      case "session/prompt":
        return this.prompt(String(params.sessionId ?? ""), params.prompt ?? params.content);
      case "_qoder/usage":
        return this.daemon?.getUsageInfo ? this.daemon.getUsageInfo() : this.requireSession().query.getUsageInfo();
      default:
        throw new Error(`Qoder does not support ${method}.`);
    }
  }

  private async initialize(): Promise<any> {
    this.sdk = await this.options.loadSdk();
    this.options.onLog(`Starting the Qoder SDK daemon with ${this.options.cliPath}`);
    const daemon = await this.sdk.startDaemon({
      auth: this.sdk.qodercliAuth(),
      pathToQoderCLIExecutable: this.options.cliPath,
      env: this.options.env && Object.keys(this.options.env).length ? { ...process.env, ...this.options.env } : undefined,
      stderr: (line: string) => this.options.onLog(`[qoder stderr] ${String(line).trimEnd()}`),
    });
    // Stopped while the daemon was starting: stop() had nothing to stop, so do it here.
    if (!this.running) {
      void Promise.resolve(daemon?.stop?.()).catch(() => undefined);
      throw new Error("The Qoder agent was stopped.");
    }
    this.daemon = daemon;
    return {
      agentInfo: { name: "Qoder" },
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
    };
  }

  private requireSession(): Session {
    if (!this.session || this.session.closed) throw new Error("Qoder has no open conversation.");
    return this.session;
  }

  /** A new conversation, or `resume` one Qoder has on disk. */
  private async open(resume: string | undefined, priorCredits?: unknown): Promise<any> {
    if (!this.sdk || !this.daemon) throw new Error("Qoder is not connected.");
    if (this.session) {
      const previous = this.session;
      this.session = undefined;
      this.closeSession(previous, new Error("Another conversation was opened."));
    }
    await this.closing;
    const id = resume || randomUUID();
    const inbox = new Inbox();
    const session: Session = {
      id,
      query: undefined,
      inbox,
      /*
       * A new conversation has spent nothing. A resumed one's total is not
       * reported until its first turn ends, so the panel says what its stored
       * turns cost; without that the first turn after reopening has no figure.
       */
      creditBase: !resume ? 0 : typeof priorCredits === "number" && Number.isFinite(priorCredits) ? priorCredits : undefined,
      streamed: new Set(),
      announced: new Map(),
      closed: false,
    };
    session.query = this.sdk.query({
      prompt: inbox,
      options: {
        daemon: this.daemon,
        cwd: this.options.cwd,
        model: this.model,
        ...(resume ? { resume } : { sessionId: id }),
        includePartialMessages: true,
        // The panel has no way to answer it; Qoder asks in its reply instead.
        disallowedTools: ["AskUserQuestion"],
        canUseTool: (name: string, input: any, options: any) => this.canUseTool(session, name, input, options),
      },
    });
    this.session = session;
    void this.pump(session);
    try {
      const init = await session.query.initializationResult();
      if (Array.isArray(init?.models) && init.models.length) this.models = init.models;
      if (!this.models.length) this.models = (await session.query.getAvailableModels?.()) ?? [];
    } catch (err) {
      if (this.session === session) this.session = undefined;
      this.closeSession(session, err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
    return { sessionId: id, configOptions: [modelOptionOf(this.models, this.model)] };
  }

  private async setConfigOption(configId: string, value: string): Promise<any> {
    if (configId !== "model") throw new Error(`Qoder has no option "${configId}".`);
    if (!this.models.some((model) => model.value === value)) {
      // Answered like Kiro does: the old value stands, and the caller reads it back.
      return { configOptions: [modelOptionOf(this.models, this.model)] };
    }
    await this.session?.query.setModel(value);
    this.model = value;
    return { configOptions: [modelOptionOf(this.models, this.model)] };
  }

  private prompt(sessionId: string, blocks: any[]): Promise<any> {
    const session = this.requireSession();
    if (sessionId && sessionId !== session.id) {
      return Promise.reject(new Error("That conversation is not the one Qoder has open."));
    }
    if (session.turn) return Promise.reject(new Error("Qoder is still working on the last message."));
    return new Promise((resolve, reject) => {
      session.turn = { resolve, reject, cancelled: false };
      session.inbox.push(userMessageOf(blocks));
    });
  }

  private closeSession(session: Session, reason: Error): void {
    if (session.closed) return;
    session.closed = true;
    session.inbox.end();
    const turn = session.turn;
    session.turn = undefined;
    if (turn) {
      if (turn.cancelled) turn.resolve({ stopReason: "cancelled" });
      else turn.reject(reason);
    }
    /*
     * Waited on by the next `open`: the daemon refuses a session id it still
     * holds ("session … is already open"), and closing is asynchronous, so a
     * chat reopened straight after being left was refused.
     */
    this.closing = Promise.all([this.closing, Promise.resolve(session.query?.close?.()).catch(() => undefined)]);
  }

  private async pump(session: Session): Promise<void> {
    let reason = new Error("Qoder stopped answering: its stream ended.");
    try {
      for await (const message of session.query) {
        if (session.closed) break;
        this.dispatch(session, message);
      }
    } catch (err) {
      if (!session.closed) this.options.onLog(`Qoder stream ended: ${String(err)}`);
      reason = err instanceof Error ? err : new Error(String(err));
    }
    // A stream that ended without a close would leave the turn, and the panel, waiting forever.
    if (this.session === session) this.session = undefined;
    this.closeSession(session, reason);
  }

  private update(session: Session, update: any): void {
    try {
      this.options.onNotification("session/update", { sessionId: session.id, update });
    } catch (err) {
      // As `AcpClient.dispatch` does: one handler's throw must not cost the rest of the stream.
      this.options.onLog(`A Qoder update could not be handled: ${String(err)}`);
    }
  }

  private announceTool(session: Session, id: string, name: string, input: any, status: string): void {
    const first = !session.announced.has(id);
    session.announced.set(id, { name, input });
    this.update(session, toolUpdateOf(id, name, input, status, first));
  }

  /** One SDK message, translated. Exported shapes are pinned in `test/qoderSdkClient.test.js`. */
  dispatch(session: Session, message: any): void {
    // A subagent's own steps and text belong to its Agent step, not to the reply.
    if (message?.parent_tool_use_id) return;
    switch (message?.type) {
      case "stream_event": {
        const event = message.event;
        if (event?.type === "message_start") session.messageId = event.message?.id;
        if (event?.type !== "content_block_delta") return;
        const delta = event.delta;
        if (delta?.type === "text_delta" && delta.text) {
          if (session.messageId) session.streamed.add(session.messageId);
          this.update(session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: delta.text } });
        } else if (delta?.type === "thinking_delta" && delta.thinking) {
          if (session.messageId) session.streamed.add(`${session.messageId}#thinking`);
          this.update(session, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: delta.thinking } });
        }
        return;
      }
      case "assistant": {
        const id = message.message?.id;
        // Without deltas the ratio rides on the assistant message; with them, on the result.
        const ratio = message.message?.usage?.context_usage_ratio;
        for (const block of Array.isArray(message.message?.content) ? message.message.content : []) {
          if (block?.type === "tool_use" && typeof block.id === "string") {
            this.announceTool(session, block.id, String(block.name ?? "Tool"), block.input, "in_progress");
          } else if (block?.type === "text" && block.text && !(id && session.streamed.has(id))) {
            // A build that sends no deltas still gets its reply shown, once.
            this.update(session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: block.text } });
          } else if (block?.type === "thinking" && block.thinking && !(id && session.streamed.has(`${id}#thinking`))) {
            this.update(session, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: block.thinking } });
          }
        }
        this.reportContext(session, ratio);
        return;
      }
      case "user": {
        for (const block of Array.isArray(message.message?.content) ? message.message.content : []) {
          if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
          const known = session.announced.get(block.tool_use_id);
          const status = block.is_error ? "failed" : "completed";
          this.update(session, {
            ...(known
              ? toolUpdateOf(block.tool_use_id, known.name, known.input, status, false)
              : { sessionUpdate: "tool_call", toolCallId: block.tool_use_id, status }),
            rawOutput: textOfToolResult(block.content),
          });
        }
        return;
      }
      case "result":
        this.finishTurn(session, message);
        return;
      default:
        return;
    }
  }

  private reportContext(session: Session, ratio: unknown): void {
    if (typeof ratio !== "number" || !Number.isFinite(ratio)) return;
    this.update(session, {
      sessionUpdate: "session_info_update",
      _meta: { kiro: { kind: "context_usage", usagePercentage: ratio * 100 } },
    });
  }

  private finishTurn(session: Session, message: any): void {
    // Measured: with `includePartialMessages` this is the only place it arrives.
    this.reportContext(session, message.usage?.context_usage_ratio);
    const total = message.total_credits;
    if (typeof total === "number" && Number.isFinite(total)) {
      // `total_credits` is the session's running total, and it survives a resume.
      if (session.creditBase !== undefined) {
        const spent = Math.max(0, total - session.creditBase);
        this.update(session, {
          sessionUpdate: "session_info_update",
          _meta: { kiro: { kind: "turn_completion", promptTurnSummaries: [{ unit: "credit", unitPlural: "credits", usage: spent }] } },
        });
      }
      this.update(session, {
        sessionUpdate: "session_info_update",
        _meta: { kiro: { kind: "session_usage", credits: total } },
      });
      session.creditBase = total;
    }
    session.messageId = undefined;
    session.streamed.clear();
    const turn = session.turn;
    session.turn = undefined;
    if (!turn) return;
    if (turn.cancelled) turn.resolve({ stopReason: "cancelled" });
    else if (message.is_error) turn.reject(new Error(resultError(message)));
    else turn.resolve({ stopReason: message.stop_reason ?? "end_turn" });
  }

  private async canUseTool(session: Session, name: string, input: any, options: any): Promise<any> {
    const toolCallId = String(options?.toolUseID ?? randomUUID());
    const kind = toolKindOf(name);
    // Usually already announced as running from the assistant message; saying
    // "pending" again would walk the step backwards.
    if (!session.announced.has(toolCallId)) this.announceTool(session, toolCallId, name, input, "pending");
    const path = pathOf(input);
    const suggestions = Array.isArray(options?.suggestions) ? options.suggestions : [];
    const choices = [
      { optionId: "allow_once", name: "Allow", kind: "allow_once" },
      ...(suggestions.length ? [{ optionId: "allow_always", name: "Always allow", kind: "allow_always" }] : []),
      { optionId: "reject_once", name: "Reject", kind: "reject_once" },
    ];
    let answer: any;
    try {
      answer = await this.options.onRequest("session/request_permission", {
        sessionId: session.id,
        toolCall: {
          toolCallId,
          title: typeof options?.title === "string" && options.title ? options.title : toolTitleOf(name, input),
          kind,
          rawInput: input ?? {},
          ...(path ? { locations: [{ path }] } : {}),
        },
        options: choices,
        ...(kind === "execute" ? { _meta: { kiro: { consent: { capability: "shell" } } } } : {}),
      });
    } catch (err) {
      return { behavior: "deny", message: `Not allowed: ${String(err)}`, toolUseID: toolCallId };
    }
    const outcome = answer?.outcome;
    const picked = outcome?.outcome === "selected" ? String(outcome.optionId ?? "") : "";
    if (picked === "allow_once") return { behavior: "allow", updatedInput: input, toolUseID: toolCallId };
    if (picked === "allow_always") {
      return { behavior: "allow", updatedInput: input, updatedPermissions: suggestions, toolUseID: toolCallId };
    }
    return { behavior: "deny", message: "The user declined this step.", toolUseID: toolCallId };
  }
}
