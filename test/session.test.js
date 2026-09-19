// Guards on KiroSession that cannot be unit tested, because the module imports
// vscode. Static, like the webview guards, and for the same reason: these are
// failures that only show up as "the UI lost something".
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const session = fs.readFileSync(
  path.join(__dirname, "..", "src", "kiroSession.ts"),
  "utf8"
);

/**
 * Neither session/new nor session/load carries a credit rate — verified
 * against kiro-cli 2.20.2, where the model list is id/name/description only.
 * The rates come from the separate `model` command, so any code path that
 * rebuilds the model list has to ask for them again or the rate badges
 * silently vanish for the rest of the session.
 */
test("every path that rebuilds the model list also fetches the credit rates", () => {
  const rebuilds = [...session.matchAll(/this\.readModels\(/g)];
  assert.ok(rebuilds.length >= 2, "expected session/new and session/load to both read models");

  for (const match of rebuilds) {
    // The enrichModels call should follow within the same method.
    const after = session.slice(match.index, match.index + 700);
    assert.match(
      after,
      /enrichModels\(\)/,
      `readModels at index ${match.index} rebuilds the list without refetching credit rates`
    );
  }
});

/*
 * Nothing Kiro sends names the model that answered a turn.
 *
 * Measured against kiro-cli 2.20.2: `_kiro.dev/metadata` carries the session
 * id, the context reading, `meteringUsage` and `turnDurationMs` — and nothing
 * else, with an explicit model set as well as under `auto`. So the model on
 * the line is the one that was *selected*, captured when the turn starts.
 * Reading it when the line is drawn would relabel finished turns the moment
 * the picker changed.
 */
test("the model is captured when the turn starts, not when it is drawn", () => {
  const send = session.slice(session.indexOf("async send("));
  const body = send.slice(0, send.indexOf("private emitTurnCredits"));
  assert.match(
    body,
    /this\.currentTurnModel = /,
    "the turn has to take the model it began with"
  );
  const emit = session.slice(session.indexOf("private emitTurnCredits("));
  assert.match(
    emit.slice(0, emit.indexOf("private modelLabel")),
    /model: this\.currentTurnModel/,
    "and report that one, not whatever is selected now"
  );
});

/*
 * Kiro meters per turn, so the conversation's total is ours to keep.
 *
 * Measured over three turns of one session: 0.0615, 0.0451, 0.0427, each
 * beside a `turnDurationMs` for that turn alone. Nothing sends a running
 * total, so `completedCredits` accumulates one — and a turn is banked only
 * when it ends, so a turn metered twice (the meter has two delivery routes)
 * is still counted once.
 */
test("the conversation total is accumulated, and a turn is banked once", () => {
  assert.match(session, /private completedCredits = 0/, "a total has to be kept");
  const read = session.slice(session.indexOf("private readUsage("));
  const body = read.slice(0, read.indexOf("private async handleRequest"));
  assert.match(
    body,
    /this\.currentTurnCredits = reading\.turnCredits/,
    "a reading replaces the turn's figure rather than adding to it"
  );
  assert.match(
    body,
    /completedCredits \+ reading\.turnCredits/,
    "and the strip shows the finished turns plus the one in flight"
  );
  const emit = session.slice(session.indexOf("private emitTurnCredits("));
  assert.match(
    emit.slice(0, emit.indexOf("private retryTurnCredits")),
    /completedCredits \+= spent/,
    "the turn is banked as it ends, not as it is read"
  );
});

/*
 * The reading lands about two milliseconds before `session/prompt` answers
 * — comfortably before the turn ends, but not by much. The wait is what
 * stops that margin being a silent failure if it ever goes the other way.
 */
test("a reading that arrives after its turn still lands on that turn", () => {
  const read = session.slice(session.indexOf("private readUsage("));
  assert.match(
    read.slice(0, read.indexOf("private async handleRequest")),
    /retryTurnCredits/,
    "a later meter has to try again"
  );
});

/*
 * And the wait has to close, twice over. A new turn takes the slot for
 * itself, so a late reading is never credited to the wrong turn; a new or
 * reopened conversation drops the total, because it describes a chat nobody
 * is looking at any more.
 */
test("an open wait for a cost is closed by anything that moves on", () => {
  const send = session.slice(session.indexOf("async send("));
  const body = send.slice(0, send.indexOf("private emitTurnCredits"));
  assert.match(
    body,
    /this\.awaitingTurnCredits = false/,
    "a new turn must not inherit the last one's wait"
  );
  const clears = [...session.matchAll(/clearSessionUsage\(this\.usage\)/g)];
  assert.ok(clears.length >= 2, "a new session and a loaded one both clear");
  for (const match of clears) {
    const before = session.slice(Math.max(0, match.index - 260), match.index);
    // A loaded chat carries on from what its stored turns cost rather than
    // from zero; either way the previous conversation's total is replaced.
    assert.match(
      before,
      /completedCredits = (0|priorCredits \?\? 0);/,
      "each of them has to drop the conversation total too"
    );
    assert.match(before, /awaitingTurnCredits = false/, "and close an open wait");
  }
});

// ---------------------------------------------------------------------------
// One conversation, one turn at a time.
//
// `send` is reachable without going through the webview's disabled Send
// button — kiroChat.explainSelection calls it through the provider — so
// without this guard a right-click mid-turn put a second session/prompt on one
// session.
// ---------------------------------------------------------------------------
const Module = require("node:module");

/** Just enough of the vscode API for KiroSession to be constructed. */
function fakeVscode(config = {}) {
  class EventEmitter {
    constructor() {
      this.listeners = new Set();
      this.event = (listener) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
      };
    }
    fire(value) {
      for (const listener of this.listeners) listener(value);
    }
    dispose() {
      this.listeners.clear();
    }
  }
  return {
    EventEmitter,
    ThemeColor: class {},
    OverviewRulerLane: { Right: 4 },
    Uri: { file: (p) => ({ fsPath: p, scheme: "file", toString: () => `file://${p}` }) },
    window: {
      createTextEditorDecorationType: () => ({ dispose() {} }),
      visibleTextEditors: [],
      activeTextEditor: undefined,
      showErrorMessage: () => Promise.resolve(undefined),
    },
    workspace: {
      workspaceFolders: undefined,
      getConfiguration: () => ({
        get: (key, fallback) => (key in config ? config[key] : fallback),
      }),
    },
    commands: { executeCommand: () => Promise.resolve(undefined) },
    languages: {},
  };
}

function loadKiroSession(config) {
  const api = fakeVscode(config);
  const original = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "vscode") return api;
    return original.call(this, request, ...rest);
  };
  try {
    for (const key of Object.keys(require.cache)) {
      if (key.includes(`${path.sep}out${path.sep}`)) delete require.cache[key];
    }
    return require(path.join(__dirname, "..", "out", "kiroSession.js")).KiroSession;
  } finally {
    Module._load = original;
  }
}

function noopEvents(overrides = {}) {
  return {
    onStatus() {},
    onText() {},
    onThought() {},
    onTool() {},
    onTurnEnd() {},
    onError() {},
    onNeedsSetup() {},
    onModels() {},
    onUsage() {},
    onCapabilities() {},
    ...overrides,
  };
}

const newSession = (overrides, config) =>
  new (loadKiroSession(config))({ appendLine() {} }, noopEvents(overrides));

/**
 * A refused turn has to reject, and reject *promptly*.
 *
 * Without the guard, `send` falls through to ensureReady(), which goes looking
 * for kiro-cli — and on a machine that has it, actually starts one. A
 * regression here would hang the run and leak an agent process rather than
 * failing, so the race is against a clock. Same shape as the stall guard in
 * directWriteReview.test.js.
 */
async function refused(run, ms = 2000) {
  const stalled = Symbol("stalled");
  const outcome = await Promise.race([
    run().then(
      () => "resolved",
      (err) => err
    ),
    new Promise((resolve) => setTimeout(() => resolve(stalled), ms).unref()),
  ]);
  assert.notEqual(outcome, stalled, "the turn was not refused — it started running");
  assert.ok(outcome instanceof Error, "the turn should have been refused");
  return outcome;
}

test("send refuses while Kiro is still working", async () => {
  const session = newSession();
  session.status = "busy";

  const err = await refused(() => session.send([{ type: "text", text: "and this" }]));
  assert.match(
    err.message,
    /still working on the last message/,
    "a command that bypasses the webview's disabled Send button must still be refused"
  );
});

/**
 * The check reads through the `currentStatus` getter rather than the field.
 * Testing `this.status` directly narrows its type for the rest of the method,
 * and the `finally` at the end legitimately expects it to be "busy" by then —
 * which TypeScript then rejects as an impossible comparison.
 */
test("the busy guard reads the status through the getter", () => {
  const send = session.slice(session.indexOf("async send(blocks"));
  assert.match(send.slice(0, 600), /this\.currentStatus === "busy"/);
});

test("turn_end reaches the panel", () => {
  const ended = [];
  const session = newSession({ onTurnEnd: (reason) => ended.push(reason) });

  session.handleNotification("session/update", {
    update: { sessionUpdate: "turn_end", stopReason: "end_turn" },
  });

  assert.deepEqual(ended, ["end_turn"]);
});

// ---------------------------------------------------------------------------
// How wide a permission to grant.
//
// ACP offers allow_once and allow_always side by side. The picker took
// whichever came first in the list, so auto-approval could hand out a standing
// permission when a single-use one was on the table — a broader grant than the
// setting's own description ("approve every tool Kiro asks to run") implies,
// and one the user never sees to correct.
// ---------------------------------------------------------------------------

/** The shape Kiro sends, with the broad option first — which is the trap. */
const permissionOptions = () => [
  { optionId: "a", name: "Always allow", kind: "allow_always" },
  { optionId: "b", name: "Allow once", kind: "allow_once" },
  { optionId: "c", name: "Reject", kind: "reject_once" },
];

test("auto-approval takes the narrowest grant on offer", async () => {
  const session = newSession(undefined, { autoApproveTools: true });

  const answer = await session.askPermission({
    toolCall: { title: "run a tool", kind: "other" },
    options: permissionOptions(),
  });

  assert.equal(answer.outcome.outcome, "selected");
  assert.equal(
    answer.outcome.optionId,
    "b",
    "allow_once was available; a standing permission must not be granted instead"
  );
});

/** Kiro's spelling of the kind varies; the preference must survive it. */
test("the narrowest grant is recognised however the kind is spelled", async () => {
  const session = newSession(undefined, { autoApproveTools: true });

  const answer = await session.askPermission({
    toolCall: { title: "run a tool", kind: "other" },
    options: [
      { optionId: "a", name: "Always", kind: "allow-always" },
      { optionId: "b", name: "Once", kind: "Allow-Once" },
    ],
  });
  assert.equal(answer.outcome.optionId, "b");
});

/** With only a broad option offered, that is still the one to take. */
test("a single standing option is still accepted when it is all there is", async () => {
  const session = newSession(undefined, { autoApproveTools: true });

  const answer = await session.askPermission({
    toolCall: { title: "run a tool", kind: "other" },
    options: [
      { optionId: "a", name: "Always allow", kind: "allow_always" },
      { optionId: "c", name: "Reject", kind: "reject_once" },
    ],
  });
  assert.equal(answer.outcome.optionId, "a");
});

/** Nothing to choose from is a cancellation, not a guess. */
test("no options at all cancels rather than inventing an answer", async () => {
  const session = newSession(undefined, { autoApproveTools: true });
  const answer = await session.askPermission({ toolCall: {}, options: [] });
  assert.equal(answer.outcome.outcome, "cancelled");
});

/**
 * The body of one method, cut at the next thing declared beside it. Slicing a
 * fixed number of characters instead breaks the day a comment is added above
 * the line the test cares about.
 */
function sliceFrom(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `expected to find ${marker}`);
  const rest = source.slice(start + marker.length);
  const next = rest.search(/\n {2}(?:private|public|async|get |\/\*\*)/);
  return next === -1 ? rest : rest.slice(0, next);
}

/*
 * `session/new` writes a conversation to disk the moment it is called —
 * measured against kiro-cli 2.21 — so the panel used to leave an empty one
 * behind every time it connected: on opening, on `+`, and before every load.
 * Loading needs no conversation of its own (a load in a freshly started
 * process answers with the same model block and the same commands), and `+`
 * on a session nothing was said into is already a new chat.
 */
test("connecting and starting a conversation are separate", () => {
  const connect = sliceFrom(session, "private async connect()");
  assert.doesNotMatch(connect, /session\/new/, "connecting must not start a conversation");

  const load = sliceFrom(session, "async loadSession(sessionId: string, priorCredits?: number)");
  assert.match(load, /await this\.connect\(\)/, "a load connects");
  assert.doesNotMatch(load, /ensureReady\(\)/, "and must not go the route that creates one");

  const ready = sliceFrom(session, "async ensureReady()");
  assert.match(ready, /createSession\(\)/, "sending still needs a conversation to send into");
});

/*
 * The title bar's restart says the agent was restarted, so it has to have
 * been. Reuse would answer it with the same process.
 */
test("a new chat reuses an untouched session, but a restart never does", () => {
  const fresh = sliceFrom(session, "async newSession(");
  assert.match(fresh, /!options\.restart/, "restart must opt out of reuse");
  assert.match(fresh, /this\.unspoken\.has\(this\.sessionId\)/, "reuse needs an unused session");
  assert.match(
    fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8"),
    /newSession\(\{ restart: true \}\)/,
    "the restart command must ask for a real restart"
  );
});

/*
 * Deleting a conversation somebody wanted is the only serious failure here, so
 * the stored list is never the authority: the log on disk is checked every
 * time, and a prompt or a stored chat record takes a session off the list for
 * good.
 */
test("a session is only tidied away while nothing has claimed it", () => {
  const tidy = sliceFrom(session, "private async tidyUnusedSessions()");
  assert.match(tidy, /isEmptySession\(id\)/, "emptiness is proved, not remembered");
  assert.match(tidy, /=== "busy"/, "a session another window holds is kept for later");

  const send = sliceFrom(session, "async send(");
  assert.match(send, /this\.retainSession\(this\.sessionId\)/, "a prompt claims the session");

  const provider = fs.readFileSync(
    path.join(__dirname, "..", "src", "chatViewProvider.ts"),
    "utf8"
  );
  assert.match(
    provider,
    /this\.session\.retainSession\(record\.sessionId\)/,
    "and so does writing a chat record against it"
  );
});

// ---------------------------------------------------------------------------
// A new chat keeps the agent that is running.
//
// `newSession` used to kill kiro-cli and start it again for every "+", so the
// panel went through "Starting Kiro…" — composer locked, spinner under the
// placeholder — for a conversation that had not begun. `session/new` on the
// live process is all a new conversation needs.
// ---------------------------------------------------------------------------

/** A client that is up, and remembers what was asked of it. */
function fakeClient(answers = {}) {
  const client = {
    isRunning: true,
    stopped: false,
    requests: [],
    stop() {
      this.stopped = true;
      this.isRunning = false;
    },
    notify() {},
    async request(method, params) {
      this.requests.push(method);
      if (method in answers) return answers[method];
      return {};
    },
  };
  return client;
}

/** Wire a running client into a session that believes it connected it. */
function connected(session, client, sessionId = "spoken-into") {
  session.client = client;
  session.connected = client;
  session.sessionId = sessionId;
  session.status = "ready";
  // As `startInternal` records it, so the reuse check has a launch to compare.
  session.launchInputs = session.currentLaunchInputs();
}

test("a new chat on a running agent asks for a session instead of restarting", async () => {
  const statuses = [];
  const session = newSession({ onStatus: (status) => statuses.push(status) });
  const client = fakeClient({ "session/new": { sessionId: "fresh" } });
  connected(session, client);

  await session.newSession();

  assert.equal(client.stopped, false, "the process must not be killed for a new chat");
  assert.ok(client.requests.includes("session/new"), "a new conversation is asked for");
  assert.equal(session.sessionId, "fresh", "and the panel moves onto it");
  assert.ok(
    !statuses.includes("starting") && !statuses.includes("stopped"),
    `nothing was restarted, so nothing should say so: ${statuses.join(", ")}`
  );
  assert.equal(statuses[statuses.length - 1], "ready");
});

/*
 * The reading Kiro sends right after `session/new` names the empty session
 * (about 6% for the system prompt, measured against kiro-cli 2.21.4). "+" on a
 * session nothing was said into hands that same session back, so the reading
 * still describes the conversation on screen — clearing it left the chip on a
 * dash until the first turn, and Restart followed by "+" hit it every time.
 */
test("reusing an empty session keeps its context reading", async () => {
  const posted = [];
  const session = newSession({ onUsage: (usage) => posted.push(usage) });
  const client = fakeClient({ "session/new": { sessionId: "fresh" } });
  connected(session, client, "empty");
  session.unspoken.add("empty");
  session.usage = { contextPercent: 6.5, planName: "Pro" };

  await session.newSession();

  assert.equal(session.sessionId, "empty", "the empty session is handed back");
  assert.ok(!client.requests.includes("session/new"), "and no second one is made");
  assert.ok(posted.length > 0, "the reading is posted: the panel emptied its chip on cleared");
  const last = posted[posted.length - 1];
  assert.equal(last.contextPercent, 6.5, "its reading is Kiro's figure for this very session");
  assert.equal(last.planName, "Pro", "and the account figures survive");
});

test("a new session after a spoken-into one starts with no reading", async () => {
  const posted = [];
  const session = newSession({ onUsage: (usage) => posted.push(usage) });
  const client = fakeClient({ "session/new": { sessionId: "fresh" } });
  connected(session, client, "spoken-into");
  session.usage = { contextPercent: 40, sessionCredits: 1.2, planName: "Pro" };

  await session.newSession();

  const last = posted[posted.length - 1];
  assert.equal(last.contextPercent, undefined, "the old chat's context is not this one's");
  assert.equal(last.sessionCredits, undefined, "nor its spend");
  assert.equal(last.planName, "Pro", "the account figures survive");
});

test("the Restart command still gets a fresh process", async () => {
  const session = newSession();
  const client = fakeClient();
  connected(session, client);
  // Never let the test reach findKiro: on a machine that has kiro-cli, that
  // starts one.
  session.ensureReady = async () => {};

  await session.newSession({ restart: true });

  assert.equal(client.stopped, true, "restart means restart");
  assert.equal(session.sessionId, undefined);
});

test("a new chat during a reply restarts, so the reply cannot land in it", async () => {
  const session = newSession();
  const client = fakeClient();
  connected(session, client);
  session.status = "busy";
  session.ensureReady = async () => {};

  await session.newSession();

  assert.equal(
    client.stopped,
    true,
    "notifications are not filtered by session id; a running turn goes with its process"
  );
});

test("a new chat restarts Kiro when its launch settings changed since it started", async () => {
  const session = newSession();
  const client = fakeClient({ "session/new": { sessionId: "fresh" } });
  connected(session, client);
  // What the process was started with no longer matches what is configured.
  session.launchInputs = { ...session.launchInputs, settings: "{\"env\":{\"OLD\":\"1\"}}" };
  session.ensureReady = async () => {};

  await session.newSession();

  assert.equal(client.stopped, true, "a reused process would keep running the old setup");
});

test("a session never launched through startInternal is not reused", async () => {
  const session = newSession();
  const client = fakeClient();
  connected(session, client);
  session.launchInputs = undefined;
  session.ensureReady = async () => {};

  await session.newSession();

  assert.equal(client.stopped, true, "with nothing to compare, restarting is the safe answer");
});

/*
 * Issue #2: a scratch file Kiro made and removed is not reviewed.
 *
 * `settlePath` compares the pre-turn snapshot to what is on disk now. When a
 * file did not exist before the turn and does not exist after, the turn's net
 * effect on it is nothing, so it must be dropped rather than offered as a diff
 * of a file that is already gone — and any live review that opened while it
 * briefly existed has to be retired through the reviewer.
 */
test("a file created and removed in one turn is skipped, not reviewed", () => {
  const settle = session.slice(session.indexOf("private async settlePath("));
  const body = settle.slice(0, settle.indexOf("private async rememberReviewBaseline"));
  assert.match(
    body,
    /if \(!tracked\.before\.exists && !current\.exists\)/,
    "the created-then-removed case is detected"
  );
  assert.match(body, /this\.directFileChanges\.delete\(key\)/, "its write tracking is dropped");
  assert.match(
    body,
    /this\.changeReviewer\.abandonReview\(tracked\.before\.full\)/,
    "and any open review is retired"
  );
});

/*
 * Issue #3: rejecting a whole file mid-turn interrupts the turn.
 *
 * The reviewer fires `onWholeFileRejected` for a deliberate whole-file reject
 * (chat undo or editor "Reject all"), and the session cancels the turn when
 * one arrives while it is still running — so Kiro does not lint or build on an
 * edit that was just thrown away.
 */
test("a whole-file rejection cancels a running turn", () => {
  const wire = session.slice(session.indexOf("this.changeReviewer.onWholeFileRejected"));
  const body = wire.slice(0, wire.indexOf("\n    };") + 6);
  assert.match(body, /this\.status === "busy"/, "only while a turn is running");
  assert.match(body, /this\.cancel\(\)/, "and it interrupts the turn");
});
