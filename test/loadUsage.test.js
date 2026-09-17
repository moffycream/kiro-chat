// Opening a past chat must show that chat's real context figure.
//
// Measured against kiro-cli 2.21.4 by driving `kiro-cli acp` directly, and
// then by running the built KiroSession against it: reopening a chat, Kiro
// sends `_kiro.dev/metadata` with a percentage just after `session/load`
// answers — and that figure is an estimate from the conversation's text. One
// session whose last turn had used 9.06% read 4.88% on every load, in a fresh
// process and in one that had just loaded it; `/context` agreed with the
// estimate. The committed 0.38.8 settled on 4.88% as well. The real figure is
// the one Kiro saved after the last request (`savedContext.ts`), so a
// reopened chat shows that, and the load's estimate does not replace it until
// a turn produces a real reading. These drive the real class in that order.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const root = path.join(__dirname, "..");

/** A vscode module that answers anything with something harmless. */
function anything() {
  const fn = function () {
    return proxy;
  };
  const proxy = new Proxy(fn, {
    get(_target, key) {
      if (key === Symbol.toPrimitive) return () => "";
      if (key === "then") return undefined;
      if (key === "workspaceFolders") return [{ uri: { fsPath: root } }];
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

function sessionWith(onLoad, saved) {
  const KiroSession = loadKiroSession();
  const usage = [];
  const events = new Proxy(
    { onUsage: (u) => usage.push(u) },
    { get: (target, key) => target[key] ?? (() => {}) }
  );
  const session = new KiroSession({ appendLine() {} }, events);
  // Never the real home directory: the saved figure is whatever the test says.
  session.readSavedContext = () => saved;
  session.connect = async () => {};
  session.client = {
    isRunning: true,
    async request(method, params) {
      if (method === "session/load") return onLoad(session, params);
      return {};
    },
  };
  return { session, usage };
}

test("a reopened chat shows the figure Kiro saved, not the load-time estimate", async () => {
  const { session, usage } = sessionWith(() => null, 9.0638);
  // The chat being left had its own figures.
  session.usage = { contextPercent: 62, sessionCredits: 2.47, planName: "Pro" };
  session.sessionId = "leaving";

  await session.loadSession("opened");
  // The measured order: the estimate arrives just after the load answers.
  session.handleNotification("_kiro.dev/metadata", {
    sessionId: "opened",
    contextUsagePercentage: 4.881999969482422,
  });

  const last = usage[usage.length - 1];
  assert.equal(last.contextPercent, 9.0638, "the saved figure stands over the estimate");
  assert.ok(!usage.some((u) => u.contextPercent === 62), "the chat left behind never shows");
  assert.equal(last.sessionCredits, undefined, "and does not lend its credits");
  assert.equal(last.planName, "Pro", "and the account's figures are untouched");
  assert.equal(session.showsSavedContext, true);
});

test("the estimate sent during the load does not replace the saved figure either", async () => {
  const { session, usage } = sessionWith((s, params) => {
    s.handleNotification("_kiro.dev/metadata", { sessionId: params.sessionId, contextUsagePercentage: 1.02 });
    return null;
  }, 2.7821);
  await session.loadSession("opened");
  assert.equal(usage[usage.length - 1].contextPercent, 2.7821);
});

test("the first turn after reopening takes a real reading again", async () => {
  const { session, usage } = sessionWith(() => null, 9.0638);
  await session.loadSession("opened");
  // What `send` does as a turn starts; a real request's reading follows.
  session.contextFromSave = false;
  session.handleNotification("_kiro.dev/metadata", { sessionId: "opened", contextUsagePercentage: 9.31 });
  assert.equal(usage[usage.length - 1].contextPercent, 9.31);
  assert.equal(session.showsSavedContext, false);
});

test("with nothing saved, the load's reading is still shown", async () => {
  // A chat that never made a request, or Kiro inside WSL: no better figure
  // exists, and this is what the panel always showed.
  const { session, usage } = sessionWith((s, params) => {
    s.handleNotification("_kiro.dev/metadata", { sessionId: params.sessionId, contextUsagePercentage: 2.2402 });
    return null;
  }, undefined);
  session.usage = { contextPercent: 62 };
  session.sessionId = "leaving";
  await session.loadSession("opened");
  assert.equal(usage[usage.length - 1].contextPercent, 2.2402);
  assert.equal(session.showsSavedContext, false);
});

test("a late reading from the chat being left does not land on the opened one", async () => {
  const { session, usage } = sessionWith((s, params) => {
    s.handleNotification("_kiro.dev/metadata", { sessionId: "leaving", contextUsagePercentage: 62 });
    s.handleNotification("_kiro.dev/metadata", {
      sessionId: params.sessionId,
      contextUsagePercentage: 12,
    });
    return null;
  });
  session.sessionId = "leaving";

  await session.loadSession("opened");

  assert.equal(usage[usage.length - 1].contextPercent, 12);
  assert.ok(
    !usage.some((u) => u.contextPercent === 62),
    "the other session's figure is never shown, even briefly"
  );
});

/*
 * The screenshot case: a chat whose stored turns cost 0.39, reopened and
 * answered once more for 0.2. The strip said "0.2 cr" — the turn since
 * reopening, as though it were the whole conversation.
 */
test("a reopened chat carries its stored cost into the running total", async () => {
  const { creditsSpentIn } = require(path.join(root, "out", "history.js"));
  const stored = [
    { role: "user", text: "watsup" },
    { role: "agent", text: "Not much", credits: 0.39 },
  ];
  const { session, usage } = sessionWith(() => null);
  await session.loadSession("opened", creditsSpentIn(stored));
  assert.equal(usage[usage.length - 1].sessionCredits, 0.39, "shown as soon as it opens");

  session.handleNotification("_kiro.dev/metadata", {
    sessionId: "opened",
    meteringUsage: [{ value: 0.2, unit: "credit", unitPlural: "credits" }],
  });
  const total = usage[usage.length - 1].sessionCredits;
  assert.ok(Math.abs(total - 0.59) < 1e-9, `0.39 + 0.2, not ${total}`);
});

test("when the earlier cost is unknown, no total is shown even after a turn", async () => {
  const { session, usage } = sessionWith(() => null);
  await session.loadSession("opened", undefined);
  session.handleNotification("_kiro.dev/metadata", {
    sessionId: "opened",
    meteringUsage: [{ value: 0.2, unit: "credit", unitPlural: "credits" }],
  });
  assert.equal(
    usage[usage.length - 1].sessionCredits,
    undefined,
    "0.2 alone would claim to be the whole chat"
  );
});

/*
 * The two other ways the estimate reached the strip. A turn starting is what
 * ends the saved figure's reign; `/context` — opened with the details panel,
 * or typed — answers with the same estimate the load does, so it must not
 * replace the saved figure either.
 */
test("a turn ends the saved figure, and /context cannot overwrite it", () => {
  const fs = require("node:fs");
  const session = fs.readFileSync(path.join(root, "src", "kiroSession.ts"), "utf8");
  const send = session.slice(session.indexOf("async send("), session.indexOf("private emitTurnCredits"));
  assert.match(send, /this\.contextFromSave = false;/, "a real request makes the next reading real");

  const provider = fs.readFileSync(path.join(root, "src", "chatViewProvider.ts"), "utf8");
  const refresh = provider.slice(provider.indexOf("async refreshContext()"));
  assert.match(
    refresh.slice(0, refresh.indexOf("\n  }")),
    /breakdown\.percent !== undefined && !this\.session\.showsSavedContext/,
    "opening the details panel keeps the saved figure"
  );
  assert.match(provider, /name === "context" && this\.session\.showsSavedContext/, "and so does typing /context");
});

test("a load that fails does not leave the saved figure standing over live readings", async () => {
  const { session, usage } = sessionWith(() => {
    throw new Error("Internal error");
  }, 9.0638);
  session.sessionId = "leaving";
  await assert.rejects(session.loadSession("opened", 0.5));
  const last = usage[usage.length - 1];
  assert.equal(last.contextPercent, undefined, "no context figure for a session Kiro is not serving");
  assert.equal(last.sessionCredits, 0.5, "the chat on screen still cost what its turns say");
  assert.equal(session.showsSavedContext, false);
  session.handleNotification("_kiro.dev/metadata", { contextUsagePercentage: 3.1 });
  assert.equal(usage[usage.length - 1].contextPercent, 3.1, "the next session's reading is taken");
});
