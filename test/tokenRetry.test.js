/*
 * Kiro could not refresh its access token, usually because the network is not
 * back yet. The payload is the one Kiro really sent to `session/prompt`, and it
 * goes through the real `rpcError` and the real KiroSession, because an object
 * in `data` used to be thrown away before anything could read it.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const root = path.join(__dirname, "..");
const { isExpiredToken, retryExpiredToken, TOKEN_RETRY_DELAYS_MS } = require("../out/tokenRetry");
const { rpcError } = require("../out/acpClient");

const CAPTURED = {
  code: -32000,
  message:
    "Kiro could not load the available models because you are not signed in. Please sign in and retry.",
  data: {
    errorType: "ModelRegistryUnauthenticatedError",
    retryErrorType: "CLIENT_ERROR",
    detail: "TokenExpiredError",
  },
};

function anything() {
  const fn = function () {
    return proxy;
  };
  const proxy = new Proxy(fn, {
    get(_target, key) {
      if (key === Symbol.toPrimitive) return () => "";
      if (key === "then") return undefined;
      if (key === "workspaceFolders") return [{ uri: { fsPath: root } }];
      if (key === "getConfiguration") return () => ({ get: (_k, d) => d, update: async () => {} });
      return proxy;
    },
    apply: () => proxy,
    construct: () => proxy,
  });
  return proxy;
}

function loadKiroSession() {
  const original = Module._load;
  Module._load = function (request, ...args) {
    if (request === "vscode") return anything();
    return original.call(this, request, ...args);
  };
  try {
    delete require.cache[path.join(root, "out", "kiroSession.js")];
    return require(path.join(root, "out", "kiroSession.js")).KiroSession;
  } finally {
    Module._load = original;
  }
}

/** A session whose Kiro answers each prompt with the next item in `script`. */
function scripted(script) {
  const KiroSession = loadKiroSession();
  const seen = { errors: [], setup: [], turnEnds: [], tools: [], refreshFailed: [] };
  const events = new Proxy(
    {
      onError: (m) => seen.errors.push(m),
      onNeedsSetup: (reason) => seen.setup.push(reason),
      onTurnEnd: (reason) => seen.turnEnds.push(reason),
      onTool: (tool) => seen.tools.push(tool),
      onLoginRefreshFailed: (m) => seen.refreshFailed.push(m),
    },
    { get: (target, key) => target[key] ?? (() => {}) }
  );
  const session = new KiroSession({ appendLine() {} }, events);
  session.readSavedContext = () => undefined;
  session.connect = async () => {};
  session.ensureReady = async () => {};
  session.sessionId = "sess_live";
  session.waitForTokenRetry = async () => {};
  const sent = [];
  const client = {
    isRunning: true,
    stopped: 0,
    stop() {
      this.stopped += 1;
    },
    notify() {},
    async request(method, params) {
      if (method !== "session/prompt") return {};
      sent.push(params);
      const step = script[Math.min(sent.length - 1, script.length - 1)];
      return step(session);
    },
  };
  session.client = client;
  session.connected = client;
  return { session, seen, sent, client };
}

const refuse = () => {
  throw rpcError(CAPTURED);
};
const answer = () => ({ stopReason: "end_turn" });
const blocks = [{ type: "text", text: "test" }];

test("Kiro's structured detail survives rpcError and identifies the token", () => {
  const err = rpcError(CAPTURED);
  assert.equal(err.message, CAPTURED.message);
  assert.equal(isExpiredToken(err), true);
});

test("the words alone never count as an expired token", () => {
  for (const err of [
    new Error(CAPTURED.message),
    Object.assign(new Error("x"), { data: "TokenExpiredError" }),
    Object.assign(new Error("x"), { data: { detail: "Other" } }),
    Object.assign(new Error("x"), { data: null }),
    null,
    undefined,
  ]) {
    assert.equal(isExpiredToken(err), false);
  }
});

test("the retries wait out about two minutes, soonest first", async () => {
  const waits = [];
  await assert.rejects(
    retryExpiredToken(refuse, { wait: async (ms) => void waits.push(ms), shouldStop: () => false })
  );
  assert.deepEqual(waits, [...TOKEN_RETRY_DELAYS_MS]);
  const total = waits.reduce((a, b) => a + b, 0);
  assert.ok(total >= 90000 && total <= 150000, `waited ${total}ms`);
});

test("any other failure is not retried", async () => {
  let attempts = 0;
  await assert.rejects(
    retryExpiredToken(
      () => {
        attempts += 1;
        throw new Error("something else");
      },
      { wait: async () => {}, shouldStop: () => false }
    )
  );
  assert.equal(attempts, 1);
});

test("a token that comes back finishes the turn with no error shown", async () => {
  const { session, seen, sent, client } = scripted([refuse, refuse, answer]);
  await session.send(blocks);
  assert.equal(sent.length, 3);
  assert.deepEqual(seen.errors, []);
  assert.deepEqual(seen.refreshFailed, []);
  assert.deepEqual(seen.setup, []);
  assert.deepEqual(seen.turnEnds, ["end_turn"]);
  assert.equal(client.stopped, 0);
  assert.deepEqual(
    seen.tools.map((t) => t.status),
    ["in_progress", "completed"],
    "the wait is said once, and finished"
  );
});

test("out of retries, the chat stays put and Try again sends the same turn", async () => {
  const { session, seen, sent, client } = scripted([refuse]);
  await session.send(blocks);
  assert.equal(sent.length, TOKEN_RETRY_DELAYS_MS.length + 1);
  assert.equal(seen.refreshFailed.length, 1);
  assert.deepEqual(seen.errors, [], "not a bare error bubble as well");
  assert.deepEqual(seen.setup, [], "and not the screen that empties the transcript");
  assert.deepEqual(seen.turnEnds, ["error"]);
  assert.equal(client.stopped, 0);
  assert.equal(session.currentSessionId, "sess_live");

  const before = sent.length;
  client.request = async (method, params) => {
    if (method === "session/prompt") sent.push(params);
    return { stopReason: "end_turn" };
  };
  assert.equal(await session.retryRefusedTurn(), true);
  assert.equal(sent.length, before + 1);
  assert.deepEqual(sent[before].prompt, blocks);
  assert.equal(seen.turnEnds[seen.turnEnds.length - 1], "end_turn");
  assert.equal(await session.retryRefusedTurn(), false, "a sent turn is not sent twice");
});

test("Try again refuses when the conversation has changed", async () => {
  const { session, sent } = scripted([refuse]);
  await session.send(blocks);
  const before = sent.length;
  session.sessionId = "sess_other";
  assert.equal(await session.retryRefusedTurn(), false);
  assert.equal(sent.length, before);
});

test("Stop during the wait ends the turn with nothing to answer", async () => {
  const { session, seen, sent } = scripted([refuse]);
  session.waitForTokenRetry = async () => session.cancel();
  await session.send(blocks);
  assert.equal(sent.length, 1);
  assert.deepEqual(seen.refreshFailed, []);
  assert.deepEqual(seen.errors, []);
  assert.deepEqual(seen.turnEnds, ["cancelled"]);
});

test("a turn Kiro had started on is never sent again", async () => {
  const { session, seen, sent } = scripted([
    (s) => {
      s.handleNotification("session/update", {
        sessionId: "sess_live",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" } },
      });
      throw rpcError(CAPTURED);
    },
  ]);
  await session.send(blocks);
  assert.equal(sent.length, 1, "resending could bill the turn twice");
  assert.equal(seen.refreshFailed.length, 1);
});
