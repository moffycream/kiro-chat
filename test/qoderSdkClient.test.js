const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  QoderSdkClient,
  toolKindOf,
  toolTitleOf,
  pathFromLink,
  userMessageOf,
  modelOptionOf,
} = require("../out/qoderSdkClient");
const { readSessionConfig } = require("../out/configOptions");
const { readSessionInfo } = require("../out/usage");
const { qoderUsageFromInfo } = require("../out/qoderUsage");
const { isWriteLikeTool, isReadOnlyTool, isShellRequest } = require("../out/writeTools");

/** Trimmed from what SDK 1.0.59 answered against qodercli 1.1.91. */
const MODELS = [
  { value: "auto", displayName: "Auto", priceFactor: 0.3, isDefault: true, isEnabled: true, isVl: true, maxInputTokens: 200000 },
  { value: "ultimate", displayName: "Ultimate", priceFactor: 2, isEnabled: true, isReasoning: true },
  { value: "qfmodel", displayName: "Qwen Flash", priceFactor: 0.1, isEnabled: true },
  { value: "retired", displayName: "Retired", priceFactor: 1, isEnabled: false },
];

/** A stand-in for the SDK: each query's stream is fed by hand. */
function fakeSdk() {
  const sdk = { queries: [], daemonStopped: 0, daemonOptions: undefined };
  sdk.qodercliAuth = () => ({ type: "qodercli" });
  sdk.startDaemon = async (options) => {
    sdk.daemonOptions = options;
    return { stop: async () => void sdk.daemonStopped++, getUsageInfo: async () => ({ userType: "enterprise" }) };
  };
  sdk.query = ({ prompt, options }) => {
    const queue = [];
    let wake;
    let ended = false;
    const q = {
      options,
      sent: [],
      interrupted: 0,
      closed: 0,
      model: undefined,
      feed(message) {
        queue.push(message);
        wake?.();
      },
      end() {
        ended = true;
        wake?.();
      },
      initializationResult: async () => ({ models: MODELS }),
      interrupt: async () => void q.interrupted++,
      setModel: async (model) => void (q.model = model),
      close: async () => {
        q.closed++;
        q.end();
      },
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (queue.length) yield queue.shift();
          if (ended) return;
          await new Promise((resolve) => (wake = resolve));
          wake = undefined;
        }
      },
    };
    // Read the panel's messages the way the SDK reads its prompt iterable.
    (async () => {
      for await (const message of prompt) q.sent.push(message);
    })();
    sdk.queries.push(q);
    return q;
  };
  return sdk;
}

function harness(answer = { outcome: { outcome: "selected", optionId: "allow_once" } }) {
  const sdk = fakeSdk();
  const notes = [];
  const asked = [];
  const client = new QoderSdkClient({
    cliPath: "C:\\q\\qodercli.exe",
    cwd: "C:\\w",
    loadSdk: async () => sdk,
    onNotification: (method, params) => notes.push({ method, ...params }),
    onRequest: async (method, params) => {
      asked.push({ method, params });
      return typeof answer === "function" ? answer(params) : answer;
    },
    onLog: () => {},
    onExit: () => {},
  });
  client.start();
  return { sdk, client, notes, asked };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const updates = (notes) => notes.map((note) => note.update);

test("the user's own qodercli runs the daemon, signed in as the CLI is", async () => {
  const { sdk, client } = harness();
  const init = await client.request("initialize", {});
  assert.equal(sdk.daemonOptions.pathToQoderCLIExecutable, "C:\\q\\qodercli.exe");
  assert.deepEqual(sdk.daemonOptions.auth, { type: "qodercli" });
  assert.equal(init.agentCapabilities.loadSession, true);
  client.stop();
  await tick();
  // A daemon left running is one qodercli per restart.
  assert.equal(sdk.daemonStopped, 1);
});

test("a new chat names its own session id and lists Qoder's enabled models with their rates", async () => {
  const { sdk, client } = harness();
  await client.request("initialize", {});
  const created = await client.request("session/new", { cwd: "C:\\w" });
  const q = sdk.queries[0];
  assert.equal(q.options.sessionId, created.sessionId);
  assert.equal(q.options.resume, undefined);
  assert.equal(q.options.includePartialMessages, true);
  assert.deepEqual(q.options.disallowedTools, ["AskUserQuestion"]);
  const config = readSessionConfig(created.configOptions);
  assert.equal(config.currentModelId, "auto");
  assert.deepEqual(
    config.models.map((m) => [m.modelId, m.creditRate]),
    [
      ["auto", "0.30x"],
      ["ultimate", "2.00x"],
      ["qfmodel", "0.10x"],
    ]
  );
});

test("an unknown model is refused by answering with the old value, as Kiro does", async () => {
  const { sdk, client } = harness();
  await client.request("initialize", {});
  await client.request("session/new", {});
  const refused = await client.request("session/set_config_option", { configId: "model", value: "bogus" });
  assert.equal(readSessionConfig(refused.configOptions).currentModelId, "auto");
  const set = await client.request("session/set_config_option", { configId: "model", value: "qfmodel" });
  assert.equal(readSessionConfig(set.configOptions).currentModelId, "qfmodel");
  assert.equal(sdk.queries[0].model, "qfmodel");
});

test("a turn streams once, shows its steps, and is priced from the running total", async () => {
  const { sdk, client, notes } = harness();
  await client.request("initialize", {});
  const { sessionId } = await client.request("session/new", {});
  const q = sdk.queries[0];
  const turn = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] });
  await tick();
  assert.equal(q.sent.length, 1);
  assert.deepEqual(q.sent[0].message.content, [{ type: "text", text: "hi" }]);

  q.feed({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } });
  q.feed({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Hmm" } } });
  q.feed({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Do" } } });
  q.feed({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "ne" } } });
  // The full copy of a streamed message must not be painted a second time.
  q.feed({ type: "assistant", message: { id: "m1", content: [{ type: "thinking", thinking: "Hmm" }, { type: "text", text: "Done" }], usage: { context_usage_ratio: 0.0839 } } });
  q.feed({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "C:\\w\\a.txt", old_string: "two", new_string: "three" } }] } });
  q.feed({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "Successfully modified file" }] } });
  q.feed({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", total_credits: 0.0523 });
  assert.deepEqual(await turn, { stopReason: "end_turn" });

  const seen = updates(notes);
  assert.ok(notes.every((note) => note.method === "session/update" && note.sessionId === sessionId));
  assert.deepEqual(
    seen.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text),
    ["Do", "ne"]
  );
  assert.equal(seen.filter((u) => u.sessionUpdate === "agent_thought_chunk").length, 1);

  const edit = seen.find((u) => u.sessionUpdate === "tool_call");
  assert.equal(edit.title, "Edit C:\\w\\a.txt");
  assert.deepEqual(edit.locations, [{ path: "C:\\w\\a.txt" }]);
  // What reviews depend on: Qoder's edit reads as an edit.
  assert.equal(isWriteLikeTool(edit), true);
  const done = seen.find((u) => u.sessionUpdate === "tool_call_update");
  assert.equal(done.status, "completed");
  assert.equal(done.rawOutput, "Successfully modified file");

  const info = seen.filter((u) => u.sessionUpdate === "session_info_update").map((u) => readSessionInfo(u._meta.kiro));
  assert.equal(info[0].contextPercent, 8.39);
  assert.equal(info[1].turnCredits, 0.0523);
  assert.equal(info[2].sessionCredits, 0.0523);

  // The next turn costs the difference, not the running total again.
  notes.length = 0;
  const second = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "again" }] });
  await tick();
  q.feed({ type: "result", subtype: "success", stop_reason: "end_turn", total_credits: 0.0653 });
  await second;
  const next = updates(notes).map((u) => readSessionInfo(u._meta.kiro));
  assert.ok(Math.abs(next[0].turnCredits - 0.013) < 1e-9);
  assert.equal(next[1].sessionCredits, 0.0653);
});

test("with streaming on, the context figure is read off the result, and a finished step keeps its title", async () => {
  const { sdk, client, notes } = harness();
  await client.request("initialize", {});
  const { sessionId } = await client.request("session/new", {});
  const q = sdk.queries[0];
  const turn = client.request("session/prompt", { sessionId, prompt: [] });
  await tick();
  q.feed({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "C:\\w\\a.txt" } }] } });
  q.feed({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "1\tone" }] }] } });
  // Measured: with includePartialMessages the ratio is only on the result.
  q.feed({ type: "result", subtype: "success", usage: { context_usage_ratio: 0.08381 }, total_credits: 0.01 });
  await turn;
  const seen = updates(notes);
  const finished = seen.find((u) => u.status === "completed");
  assert.equal(finished.title, "Read C:\\w\\a.txt");
  assert.equal(finished.kind, "read");
  assert.equal(finished.rawOutput, "1\tone");
  const context = seen.map((u) => u._meta && readSessionInfo(u._meta.kiro)).find((r) => r && r.kind === "context_usage");
  assert.equal(context.contextPercent, 8.381);
});

test("a reopened chat prices its first turn from what its stored turns cost", async () => {
  const { sdk, client, notes } = harness();
  await client.request("initialize", {});
  await client.request("session/load", { sessionId: "s1", _meta: { qoder: { priorCredits: 0.0653 } } });
  const q = sdk.queries[0];
  assert.equal(q.options.resume, "s1");
  assert.equal(q.options.sessionId, undefined);
  const turn = client.request("session/prompt", { sessionId: "s1", prompt: [{ type: "text", text: "x" }] });
  await tick();
  q.feed({ type: "result", subtype: "success", total_credits: 0.0784 });
  await turn;
  const info = updates(notes).map((u) => readSessionInfo(u._meta.kiro));
  assert.ok(Math.abs(info[0].turnCredits - 0.0131) < 1e-9);
});

test("without a known starting total, a reopened chat's first turn claims no figure", async () => {
  const { sdk, client, notes } = harness();
  await client.request("initialize", {});
  await client.request("session/load", { sessionId: "s1" });
  const turn = client.request("session/prompt", { sessionId: "s1", prompt: [] });
  await tick();
  sdk.queries[0].feed({ type: "result", subtype: "success", total_credits: 0.0784 });
  await turn;
  const info = updates(notes).map((u) => readSessionInfo(u._meta.kiro));
  assert.deepEqual(info.map((r) => r.kind), ["session_usage"]);
});

test("reopening waits for the last close, which the daemon otherwise refuses", async () => {
  const { sdk, client } = harness();
  await client.request("initialize", {});
  const { sessionId } = await client.request("session/new", {});
  let release;
  sdk.queries[0].close = () => new Promise((resolve) => (release = resolve));
  await client.request("session/close", { sessionId });
  const load = client.request("session/load", { sessionId });
  await tick();
  assert.equal(sdk.queries.length, 1, "opened again while the old one was still closing");
  release();
  await load;
  assert.equal(sdk.queries.length, 2);
});

test("a permission goes to the panel as an ACP request, and its answer decides", async () => {
  const { sdk, client, asked } = harness((params) =>
    params.toolCall.kind === "execute"
      ? { outcome: { outcome: "selected", optionId: "reject_once" } }
      : { outcome: { outcome: "selected", optionId: "allow_always" } }
  );
  await client.request("initialize", {});
  await client.request("session/new", {});
  const canUseTool = sdk.queries[0].options.canUseTool;
  const suggestions = [{ type: "setMode", mode: "acceptEdits", destination: "session" }];

  const edit = await canUseTool("Edit", { file_path: "C:\\w\\a.txt" }, { toolUseID: "t1", title: "Edit a.txt", suggestions });
  assert.equal(edit.behavior, "allow");
  assert.deepEqual(edit.updatedPermissions, suggestions);
  const request = asked[0];
  assert.equal(request.method, "session/request_permission");
  assert.equal(request.params.toolCall.toolCallId, "t1");
  assert.equal(request.params.toolCall.title, "Edit a.txt");
  assert.deepEqual(request.params.options.map((o) => o.optionId), ["allow_once", "allow_always", "reject_once"]);
  assert.equal(isShellRequest(request.params), false);

  const shell = await canUseTool("Bash", { command: "rm -rf x" }, { toolUseID: "t2" });
  assert.equal(shell.behavior, "deny");
  // Plan mode forces the card for a shell command; this is how it knows.
  assert.equal(isShellRequest(asked[1].params), true);
  // No "always" without something for Qoder to remember.
  assert.deepEqual(asked[1].params.options.map((o) => o.optionId), ["allow_once", "reject_once"]);
});

test("a permission the panel could not answer is a refusal, never an approval", async () => {
  const { sdk, client } = harness(() => {
    throw new Error("panel gone");
  });
  await client.request("initialize", {});
  await client.request("session/new", {});
  const answer = await sdk.queries[0].options.canUseTool("Edit", {}, { toolUseID: "t1" });
  assert.equal(answer.behavior, "deny");
});

test("Stop interrupts the turn and it ends as cancelled, not as an error", async () => {
  const { sdk, client } = harness();
  await client.request("initialize", {});
  const { sessionId } = await client.request("session/new", {});
  const q = sdk.queries[0];
  const turn = client.request("session/prompt", { sessionId, prompt: [] });
  await tick();
  client.notify("session/cancel", { sessionId });
  assert.equal(q.interrupted, 1);
  q.feed({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["interrupted"] });
  assert.deepEqual(await turn, { stopReason: "cancelled" });
});

test("a failed turn rejects with Qoder's own words, which the sign-in check reads", async () => {
  const { sdk, client } = harness();
  await client.request("initialize", {});
  const { sessionId } = await client.request("session/new", {});
  const turn = client.request("session/prompt", { sessionId, prompt: [] });
  await tick();
  sdk.queries[0].feed({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: ["Authentication required. Log in with qodercli login or provide valid SDK credentials."],
  });
  await assert.rejects(turn, /Authentication required/);
  const { looksLikeSignIn } = require("../out/startupError");
  assert.equal(looksLikeSignIn("Authentication required. Log in with qodercli login"), true);
});

test("a subagent's own messages stay out of the reply", async () => {
  const { sdk, client, notes } = harness();
  await client.request("initialize", {});
  await client.request("session/new", {});
  sdk.queries[0].feed({ type: "assistant", parent_tool_use_id: "agent1", message: { id: "x", content: [{ type: "text", text: "inner" }] } });
  await tick();
  assert.equal(notes.length, 0);
});

test("steps are classified the way the review and Plan mode need", () => {
  assert.equal(toolKindOf("Read"), "read");
  assert.equal(toolKindOf("Edit"), "edit");
  assert.equal(toolKindOf("Write"), "edit");
  assert.equal(toolKindOf("Bash"), "execute");
  assert.equal(toolKindOf("Grep"), "search");
  assert.equal(toolKindOf("Agent"), "other");
  // An unknown tool is assumed to have written — the rule in writeTools.ts.
  assert.equal(isReadOnlyTool({ kind: toolKindOf("Agent") }), false);
  assert.equal(toolTitleOf("Bash", { command: "npm test\nmore" }), "Bash npm test");
  assert.equal(toolTitleOf("Agent", {}), "Agent");
});

test("attached files reach Qoder as a path it can open, in either link spelling", () => {
  assert.equal(pathFromLink("file://C:/w/sub dir/a.css"), "C:\\w\\sub dir\\a.css");
  assert.equal(pathFromLink("file:///c%3A/w/sub%20dir/a.css"), "c:\\w\\sub dir\\a.css");
  const message = userMessageOf([
    { type: "text", text: "look" },
    { type: "resource_link", uri: "file://C:/w/a.css", name: "a.css" },
    { type: "image", data: "AAAA", mimeType: "image/png" },
  ]);
  assert.equal(message.type, "user");
  // The daemon refuses a message carrying any session id but its own.
  assert.equal("session_id" in message, false);
  assert.deepEqual(message.message.content, [
    { type: "text", text: "look" },
    { type: "text", text: "Attached file: C:\\w\\a.css" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
  ]);
});

test("a model list with nothing enabled still answers with a model", () => {
  assert.equal(modelOptionOf([], undefined).currentValue, "auto");
});

test("Qoder's account comes from the SDK under the screen's labels, and absent is N/A", () => {
  // As getUsageInfo answered for an Enterprise seat.
  const usage = qoderUsageFromInfo({
    userType: "enterprise",
    expiresAt: 1796054400000,
    orgResourcePackage: { used: 2, cap: 2000, remaining: 1998, percentage: 1, available: true, unit: "credits" },
  });
  assert.equal(usage.planName, "Enterprise");
  assert.deepEqual(usage.rows.map((row) => row.label), [
    "Plan",
    "Plan Expires At",
    "Plan Credits Used",
    "Add-on Credits Used",
    "Org Resource Package",
  ]);
  assert.equal(usage.rows.find((row) => row.label === "Plan Credits Used").value, "N/A");
  assert.equal(usage.rows.find((row) => row.label === "Org Resource Package").value, "2/2000");
  assert.equal(qoderUsageFromInfo({ userQuota: { used: 12.345, total: 500 } }).rows.find((row) => row.label === "Plan Credits Used").value, "12.35/500");
  assert.equal(qoderUsageFromInfo(null), undefined);
});

test("the SDK ships as a bundle loaded with a real import, and its terms ship with it", () => {
  const root = path.join(__dirname, "..");
  const session = fs.readFileSync(path.join(root, "src", "kiroSession.ts"), "utf8");
  // tsc turns a bare import() into require(), which cannot load an ES module on older VS Code.
  assert.match(session, /new Function\("specifier", "return import\(specifier\)"\)/);
  assert.match(session, /"vendor", "qoder-agent-sdk\.mjs"/);
  assert.match(session, /config\.get<boolean>\("qoderUseSdk", true\)/);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.match(pkg.scripts.compile, /bundle-qoder-sdk\.js/);
  // A dev dependency: only the bundle reaches users, never node_modules.
  assert.ok(pkg.devDependencies["@qoder-ai/qoder-agent-sdk"]);
  assert.equal((pkg.dependencies ?? {})["@qoder-ai/qoder-agent-sdk"], undefined);
  assert.ok(pkg.contributes.configuration.properties["kiroChat.qoderUseSdk"]);
  assert.ok(fs.existsSync(path.join(root, "out", "vendor", "qoder-agent-sdk.mjs")));
  assert.ok(fs.existsSync(path.join(root, "out", "vendor", "qoder-agent-sdk.LICENSE")));
  const ignore = fs.readFileSync(path.join(root, ".vscodeignore"), "utf8");
  assert.doesNotMatch(ignore, /^out\/\*\*$|^out\/vendor/m);
});
