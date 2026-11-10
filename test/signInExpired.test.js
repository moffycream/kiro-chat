/*
 * A login that expires under a running conversation.
 *
 * Measured against kiro-cli 3.0.0: with a stale token, `initialize` and
 * `session/new` both succeed, and the first thing to fail is `session/prompt`,
 * with -32000 and the sentence below. `send` used to hand that to `onError`
 * like any chat failure, so the panel showed Kiro's own "please sign in and
 * retry" in a bubble, and Retry sent the same turn through the same process
 * to fail the same way. The sign-in detection existed for the handshake and
 * never ran here. These drive the real class against that refusal.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const root = path.join(__dirname, "..");

/** Kiro's refusal, as `rpcError` folds `data` into the message. */
const REFUSAL =
  "Kiro could not load the available models because you are not signed in. " +
  'Please sign in and retry. {"errorType":"ModelRegistryUnauthenticatedError",' +
  '"retryErrorType":"CLIENT_ERROR","detail":"TokenExpiredError"}';

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
    for (const key of Object.keys(require.cache)) {
      if (key.includes(`${path.sep}out${path.sep}`)) delete require.cache[key];
    }
    return require(path.join(root, "out", "kiroSession.js")).KiroSession;
  } finally {
    Module._load = original;
  }
}

/** A session whose Kiro refuses every prompt with `message`. */
function refusing(message) {
  const KiroSession = loadKiroSession();
  const seen = { errors: [], setup: [], turnEnds: [], status: [] };
  const events = new Proxy(
    {
      onError: (m) => seen.errors.push(m),
      onNeedsSetup: (reason, detail) => {
        // What the panel can still read at the moment it is told.
        seen.setup.push({ reason, detail, sessionId: session.currentSessionId });
      },
      onTurnEnd: (reason) => seen.turnEnds.push(reason),
      onStatus: (status) => seen.status.push(status),
    },
    { get: (target, key) => target[key] ?? (() => {}) }
  );
  const session = new KiroSession({ appendLine() {} }, events);
  session.readSavedContext = () => undefined;
  session.connect = async () => {};
  session.ensureReady = async () => {};
  session.sessionId = "sess_live";
  const client = {
    isRunning: true,
    stopped: 0,
    stop() {
      this.stopped += 1;
      this.isRunning = false;
    },
    async request(method) {
      if (method === "session/prompt") throw new Error(message);
      return {};
    },
  };
  session.client = client;
  session.connected = client;
  return { session, seen, client };
}

test("an expired login mid-chat asks for a sign-in, not a retry", async () => {
  const { session, seen, client } = refusing(REFUSAL);
  await session.send([{ type: "text", text: "test" }]);

  assert.deepEqual(seen.errors, [], "Kiro's sentence must not land as a chat error");
  assert.equal(seen.setup.length, 1, "the sign-in screen is asked for once");
  assert.equal(seen.setup[0].reason, "signin");
  assert.match(seen.setup[0].detail, /not signed in/);
  // The panel pins the chat to its session from this callback, so the id has
  // to still be readable when it fires.
  assert.equal(seen.setup[0].sessionId, "sess_live");

  // The turn still ends, so the bubble on screen is finished and recorded.
  assert.deepEqual(seen.turnEnds, ["error"]);

  // The process goes: a reconnect that reused it would prove nothing about
  // the new login, and `ensureReady` returns at once for a live client.
  assert.equal(client.stopped, 1);
  assert.equal(session.currentSessionId, undefined);
  // And "ready" is never announced, which the webview takes as its cue to
  // leave the setup screen.
  assert.equal(seen.status[seen.status.length - 1], "stopped");
  assert.ok(!seen.status.includes("ready"), `status went: ${seen.status.join(" → ")}`);
});

test("any other refusal is still a chat error on a live process", async () => {
  const { session, seen, client } = refusing("Something unrelated went wrong.");
  await session.send([{ type: "text", text: "test" }]);

  assert.deepEqual(seen.errors, ["Something unrelated went wrong."]);
  assert.deepEqual(seen.setup, []);
  assert.deepEqual(seen.turnEnds, ["error"]);
  assert.equal(client.stopped, 0, "an ordinary error does not cost the process");
  assert.equal(session.currentSessionId, "sess_live");
  assert.equal(seen.status[seen.status.length - 1], "ready");
});
