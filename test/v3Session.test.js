/*
 * The real KiroSession, fed what the v3 engine sends.
 *
 * Payloads are captured from kiro-cli 3.1.0 (`test/fixtures/`), or written in
 * the shape those captures showed where one small field is all that matters.
 * The credit meter lost three versions to unit tests that agreed with the code
 * and not with Kiro, so these start at the notification.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const root = path.join(__dirname, "..");
const INFO = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "kiro-session-info.json"), "utf8"));
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "kiro-config-options.json"), "utf8"));

const { readSessionInfo } = require(path.join(root, "out", "usage.js"));

function anything(settings = {}) {
  const fn = function () {
    return proxy;
  };
  const proxy = new Proxy(fn, {
    get(_target, key) {
      if (key === Symbol.toPrimitive) return () => "";
      if (key === "then") return undefined;
      if (key === "workspaceFolders") return [{ uri: { fsPath: root } }];
      if (key === "getConfiguration") return () => ({ get: (k, d) => (k in settings ? settings[k] : d), update: async () => {} });
      return proxy;
    },
    apply: () => proxy,
    construct: () => proxy,
  });
  return proxy;
}

function loadKiroSession(settings) {
  const original = Module._load;
  Module._load = function (request, ...args) {
    if (request === "vscode") return anything(settings);
    return original.call(this, request, ...args);
  };
  try {
    for (const key of Object.keys(require.cache)) {
      if (key.includes(`${path.sep}out${path.sep}`)) delete require.cache[key];
    }
    return require(path.join(root, "out", "kiroSession.js")).KiroSession;
  } finally {
    Module._load = original;
  }
}

function harness({ onRequest, settings } = {}) {
  const KiroSession = loadKiroSession(settings);
  const seen = { usage: [], text: [], models: [], turnCredits: [] };
  const events = new Proxy(
    {
      onUsage: (u) => seen.usage.push(u),
      onText: (t) => seen.text.push(t),
      onModels: (models, currentModelId, effort) => seen.models.push({ models, currentModelId, effort }),
      onTurnCredits: (t) => seen.turnCredits.push(t),
    },
    { get: (target, key) => target[key] ?? (() => {}) }
  );
  const session = new KiroSession({ appendLine() {} }, events);
  session.readSavedContext = () => undefined;
  const requests = [];
  session.connect = async () => {};
  session.ensureReady = async () => {};
  session.sessionId = "sess_a";
  session.client = {
    isRunning: true,
    async request(method, params) {
      requests.push({ method, params });
      return onRequest ? onRequest(method, params) : {};
    },
  };
  const info = (kiro) =>
    session.handleNotification("session/update", {
      sessionId: "sess_a",
      update: { sessionUpdate: "session_info_update", _meta: { kiro } },
    });
  return { session, seen, requests, info };
}

const last = (list) => list[list.length - 1];

test("each captured session info payload is read as what it is", () => {
  const context = readSessionInfo(INFO.context);
  assert.ok(context.contextPercent > 1);
  assert.ok(context.context.breakdown.yourPrompts);
  assert.ok(readSessionInfo(INFO.turnCompletion).turnCredits > 0);
  assert.ok(readSessionInfo(INFO.sessionUsage).sessionCredits > 0);
  assert.ok(readSessionInfo(INFO.userMessage).userMessageId);
  assert.equal(readSessionInfo(INFO.compacted).compacted, true);
  assert.deepEqual(readSessionInfo(undefined).compacted, false);
});

test("a percentage that is missing is not reported as zero", () => {
  assert.equal(readSessionInfo({ kind: "context_usage", usagePercentage: null }).contextPercent, undefined);
});

test("context and credits reach the strip from session info", () => {
  const { session, seen, info } = harness();
  info(INFO.context);
  assert.ok(last(seen.usage).contextPercent > 1);
  info(INFO.turnCompletion);
  info(INFO.sessionUsage);
  assert.equal(last(seen.usage).sessionCredits, readSessionInfo(INFO.sessionUsage).sessionCredits);

  // The turn is banked once, and arrives at Kiro's own total.
  session.emitTurnCredits();
  assert.equal(seen.turnCredits.length, 1);
  assert.equal(session.completedCredits, readSessionInfo(INFO.sessionUsage).sessionCredits);
});

/* The total for a reopened chat comes with the replay. A past turn's cost must not. */
test("a replay supplies the chat's total without billing its past turns", async () => {
  const { session, seen, info } = harness({
    onRequest: (method) => {
      if (method === "session/load") {
        info({ ...INFO.turnCompletion, replay: true });
        info({ ...INFO.sessionUsage, replay: true });
      }
      return {};
    },
  });
  session.sessionId = "sess_a";
  await session.loadSession("sess_a", undefined);
  assert.equal(session.currentTurnCredits, undefined, "the past turn is not this turn");
  assert.equal(last(seen.usage).sessionCredits, readSessionInfo(INFO.sessionUsage).sessionCredits);
  assert.equal(session.creditsUnknown, false, "Kiro's total is the whole chat");
});

test("a replay is not painted, even after the load has answered", () => {
  const { session, seen } = harness();
  session.handleNotification("session/update", {
    sessionId: "sess_a",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "from last week" },
      _meta: { kiro: { replay: true } },
    },
  });
  assert.deepEqual(seen.text, []);
  session.handleNotification("session/update", {
    sessionId: "sess_a",
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "live" } },
  });
  assert.deepEqual(seen.text, ["live"]);
});

test("a config update redraws the models and effort", () => {
  const { session, seen } = harness();
  session.handleNotification("session/update", {
    sessionId: "sess_a",
    update: { sessionUpdate: "config_option_update", configOptions: CONFIG.opus46 },
  });
  assert.equal(last(seen.models).currentModelId, "claude-opus-4.6");
  assert.equal(last(seen.models).effort.current, "high");
});

function configWith(current) {
  const options = JSON.parse(JSON.stringify(CONFIG.opus46));
  options.find((o) => o.id === "effortLevel").currentValue = current;
  return options;
}

test("setting effort writes the option Kiro named", async () => {
  const { session, requests } = harness({
    onRequest: (method, params) =>
      method === "session/set_config_option" ? { configOptions: configWith(params.value) } : {},
  });
  session.applyConfig(CONFIG.opus46);
  await session.setEffort("low");
  assert.deepEqual(last(requests), {
    method: "session/set_config_option",
    params: { sessionId: "sess_a", configId: "effortLevel", value: "low" },
  });
  assert.equal(session.getModels().effort.current, "low");
});

/* Measured: a value Kiro will not take answers success with the old value. */
test("an effort Kiro silently ignored is reported as a failure", async () => {
  const { session } = harness({
    onRequest: () => ({ configOptions: configWith("high") }),
  });
  session.applyConfig(CONFIG.opus46);
  await assert.rejects(session.setEffort("low"), /did not set effort/);
});

test("a level the model does not have is refused before it is sent", async () => {
  const { session, requests } = harness();
  session.applyConfig(CONFIG.opus46);
  await assert.rejects(session.setEffort("xhigh"), /is not one of/);
  assert.equal(requests.length, 0);
});

test("a model with no effort levels refuses cleanly", async () => {
  const { session } = harness();
  session.applyConfig(CONFIG.autoModel);
  await assert.rejects(session.setEffort("low"), /no effort levels/);
});

/* The race the first fixture capture ran into. */
test("the remembered model waits for Kiro to list it", async () => {
  const { session, requests } = harness({
    settings: { model: "claude-opus-4.6" },
    onRequest: (method) =>
      method === "session/new"
        ? { sessionId: "sess_a", configOptions: [] }
        : method === "session/set_config_option"
          ? { configOptions: CONFIG.opus46 }
          : {},
  });
  session.sessionId = undefined;
  await session.createSession();
  assert.ok(!requests.some((r) => r.method === "session/set_config_option"), "not yet");

  session.handleNotification("session/update", {
    sessionId: "sess_a",
    update: { sessionUpdate: "config_option_update", configOptions: CONFIG.autoModel },
  });
  const set = requests.filter((r) => r.method === "session/set_config_option");
  assert.equal(set.length, 1);
  assert.equal(set[0].params.value, "claude-opus-4.6");
});

test("rewind forks at the id Kiro assigned, and loads the fork", async () => {
  const { session, requests, info } = harness({
    onRequest: (method) => (method === "session/fork" ? { sessionId: "sess_b" } : {}),
  });
  session.turnLabel = "first";
  info({ kind: "user_message_id_assigned", userMessageId: "m1" });
  session.turnLabel = "second";
  info({ kind: "user_message_id_assigned", userMessageId: "m2" });

  const turns = await session.rewindTurns();
  assert.deepEqual(turns.map((t) => t.label), ["second", "first"], "newest first");

  const forked = await session.rewindTo(turns[1].logIndex);
  assert.equal(forked, "sess_b");
  const fork = requests.find((r) => r.method === "session/fork");
  assert.equal(fork.params._meta.kiro.messageId, "m1");
  assert.ok(requests.some((r) => r.method === "session/load" && r.params.sessionId === "sess_b"));
});

/* Measured: a fork comes back on `auto` with no effort, unlike a reload. */
test("rewinding keeps the model and effort in use", async () => {
  const { session, requests, info } = harness({
    onRequest: (method, params) => {
      if (method === "session/fork") return { sessionId: "sess_b" };
      if (method === "session/load") return { configOptions: CONFIG.autoModel };
      if (method === "session/set_config_option") {
        return { configOptions: params.configId === "model" ? configWith("high") : configWith(params.value) };
      }
      return {};
    },
  });
  session.applyConfig(configWith("low"));
  info({ kind: "user_message_id_assigned", userMessageId: "m1" });
  await session.rewindTo(0);

  const written = requests
    .filter((r) => r.method === "session/set_config_option")
    .map((r) => [r.params.configId, r.params.value]);
  assert.deepEqual(written, [
    ["model", "claude-opus-4.6"],
    ["effortLevel", "low"],
  ]);
  assert.equal(session.getModels().effort.current, "low");
});

test("a replay rebuilds the rewind points", async () => {
  const chunk = (sessionUpdate, text, messageId) => ({
    sessionId: "sess_a",
    update: { sessionUpdate, content: { type: "text", text }, _meta: { kiro: { messageId, replay: true } } },
  });
  const { session } = harness({
    onRequest: (method) => {
      if (method === "session/load") {
        session.handleNotification("session/update", chunk("user_message_chunk", "hello", "m1"));
        session.handleNotification("session/update", chunk("agent_message_chunk", "hi there", "r1"));
        session.handleNotification("session/update", chunk("user_message_chunk", "again", "m2"));
      }
      return {};
    },
  });
  await session.loadSession("sess_a", 0);
  const turns = await session.rewindTurns();
  assert.deepEqual(turns.map((t) => t.label), ["again", "hello"]);
  assert.equal(turns[1].responseSnippet, "hi there");
});

/* Measured: forking at a compacted-away message answers "Message not found". */
test("compaction empties the rewind points", async () => {
  const { session, info } = harness();
  info({ kind: "user_message_id_assigned", userMessageId: "m1" });
  assert.equal((await session.rewindTurns()).length, 1);
  info(INFO.compacted);
  assert.equal((await session.rewindTurns()).length, 0);
});

test("/compact finishes on its one request", async () => {
  const { session, requests } = harness({
    onRequest: (method) => (method === "_kiro/session/compact" ? { success: true } : {}),
  });
  const result = await session.runCommand("compact");
  assert.equal(result.ok, true);
  assert.match(result.text, /^Compacted/);
  assert.equal(requests[0].params.sessionId, "sess_a");
});

test("/context is answered from what Kiro already sent", async () => {
  const { session, requests, info } = harness();
  assert.equal((await session.runCommand("context")).ok, false, "nothing reported yet");
  info(INFO.context);
  const result = await session.runCommand("context");
  assert.equal(result.ok, true);
  assert.ok(result.data.breakdown);
  assert.match(result.text, /Your messages: /);
  assert.equal(requests.length, 0, "and costs no request");
});

test("/effort and /model answer in words", async () => {
  const { session } = harness({
    onRequest: (method, params) =>
      method === "session/set_config_option" ? { configOptions: configWith(params.value) } : {},
  });
  session.applyConfig(CONFIG.opus46);
  assert.match((await session.runCommand("effort")).text, /^Effort is High\. Levels: low/);
  assert.match((await session.runCommand("effort", { value: "LOW" })).text, /^Effort is Low/);
  assert.equal((await session.runCommand("effort", { value: "bogus" })).ok, false);
  assert.equal((await session.runCommand("model", { value: "no-such" })).ok, false);
});

test("the model is matched only when it can mean one thing", async () => {
  const { session } = harness({
    onRequest: () => ({ configOptions: CONFIG.autoModel }),
  });
  session.applyConfig(CONFIG.autoModel);
  const result = await session.runCommand("model", { value: "claude" });
  assert.equal(result.ok, false);
  assert.match(result.text, /could be/);
});

test("the account usage agent runs the v2 engine", () => {
  const { accountUsageArgs } = require(path.join(root, "out", "accountUsage.js"));
  assert.deepEqual(accountUsageArgs(["kiro-cli"]), ["kiro-cli", "acp", "--agent-engine", "v2"]);
});

test("too old a Kiro is named from what it printed", () => {
  const { needsNewerKiro } = require(path.join(root, "out", "startupError.js"));
  assert.equal(needsNewerKiro("[kiro stderr] error: unexpected argument '--agent-engine' found"), true);
  assert.equal(needsNewerKiro("error: something else"), false);
});

/*
 * A real process that fails the way an old CLI does, with the wording kiro-cli
 * uses for a flag it does not know. It has to reach the setup screen as its own
 * reason: said as a chat error, it was wiped when that screen opened, leaving
 * "this is probably temporary" for something that will not fix itself.
 */
test("a Kiro too old for the flag gets the update screen, not a chat error", async () => {
  const os = require("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kiro-old-"));
  const fake = path.join(dir, "kiro-cli.cmd");
  fs.writeFileSync(
    fake,
    "@echo off\r\necho error: unexpected argument '--agent-engine' found 1>&2\r\nexit /b 2\r\n"
  );
  const KiroSession = loadKiroSession({ command: fake, args: [], env: {} });
  const told = [];
  const events = new Proxy(
    {
      onError: (message) => told.push(["error", message]),
      onNeedsSetup: (reason) => told.push(["setup", reason]),
    },
    { get: (target, key) => target[key] ?? (() => {}) }
  );
  const session = new KiroSession({ appendLine() {} }, events);
  await assert.rejects(session.ensureReady(), /needs Kiro CLI 3\.0 or newer/);
  assert.deepEqual(told, [["setup", "outdated"]]);
  session.dispose();
});

/*
 * A real process, dying the way a user's did. The reason is on stderr and the
 * request waiting on the process only learns that it stopped.
 */
test("a Kiro that dies starting is reported with the reason it printed", async () => {
  const os = require("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kiro-denied-"));
  const fake = path.join(dir, "kiro-cli.cmd");
  fs.writeFileSync(
    fake,
    "@echo off\r\necho error: 1>&2\r\necho Access is denied. (os error 5) 1>&2\r\nexit /b 1\r\n"
  );
  const KiroSession = loadKiroSession({ command: fake, args: [], env: {} });
  const told = [];
  const events = new Proxy(
    { onNeedsSetup: (reason, detail) => told.push([reason, detail]) },
    { get: (target, key) => target[key] ?? (() => {}) }
  );
  const session = new KiroSession({ appendLine() {} }, events);
  await assert.rejects(session.ensureReady(), /Access is denied\. \(os error 5\)/);
  assert.deepEqual(told, [["failed", "Access is denied. (os error 5)"]]);
  session.dispose();
});
