/*
 * One question at a time.
 *
 * `AcpClient.handleIncomingRequest` answers every incoming request on its own
 * promise without waiting for the last, which is right for reads and wrong for
 * questions: Kiro writes several notifications in one stdio write, so two
 * `session/request_permission` calls dispatched out of the same chunk both
 * reached the panel and stacked two cards in the pinned bar. Nobody can answer
 * two questions at once, and the digit shortcuts answer the newest card rather
 * than the one being read.
 *
 * These drive `askPermission` directly, the way `directWriteReview.test.js`
 * drives the review flow, with `vscode` stubbed out of the module loader.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const root = path.join(__dirname, "..");

/** Just enough `vscode` for `askPermission` to read its settings. */
function fakeVscode(settings = {}) {
  return {
    workspace: {
      getConfiguration: () => ({
        get: (key, fallback) => (key in settings ? settings[key] : fallback),
      }),
    },
    window: {
      showInformationMessage: async () => undefined,
    },
    EventEmitter: class {
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
    },
    Uri: { file: (p) => ({ fsPath: p }), parse: () => ({ scheme: "file", fsPath: "" }) },
    ThemeColor: class {},
    OverviewRulerLane: { Right: 1 },
    commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} },
    languages: { registerCodeLensProvider: () => ({ dispose() {} }) },
  };
}

function loadSession(vscode) {
  const original = Module._load;
  Module._load = function (request, ...args) {
    if (request === "vscode") return vscode;
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

function events() {
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
  };
}

const READ = (id) => ({
  toolCall: { title: `read ${id}`, kind: "read", toolCallId: id },
  options: [
    { optionId: "allow-once", name: "Allow", kind: "allow_once" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ],
});

/** A session whose permission questions are held open for the test to answer. */
function held(settings = {}) {
  const vscode = fakeVscode(settings);
  const KiroSession = loadSession(vscode);
  const handlers = events();
  const shown = [];
  handlers.onPermission = (request) =>
    new Promise((resolve) => {
      shown.push({ request, answer: resolve });
    });
  const logged = [];
  const session = new KiroSession({ appendLine: (line) => logged.push(line) }, handlers);
  return { session, shown, logged };
}

/** Let every already-resolved promise settle before looking at the world. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("two questions arriving together are asked one at a time", async () => {
  const { session, shown } = held();

  const first = session.askPermission(READ("a"));
  const second = session.askPermission(READ("b"));
  await settle();

  assert.equal(shown.length, 1, "the second question waits rather than stacking a card");
  assert.equal(shown[0].request.title, "read a");

  shown[0].answer("allow-once");
  assert.deepEqual(await first, { outcome: { outcome: "selected", optionId: "allow-once" } });
  await settle();

  assert.equal(shown.length, 2, "and is asked once the first has been answered");
  assert.equal(shown[1].request.title, "read b", "in the order they arrived");

  shown[1].answer("reject");
  assert.deepEqual(await second, { outcome: { outcome: "selected", optionId: "reject" } });
});

test("a card says how many questions are behind it", async () => {
  const { session, shown } = held();

  const first = session.askPermission(READ("a"));
  const second = session.askPermission(READ("b"));
  const third = session.askPermission(READ("c"));
  await settle();

  assert.equal(shown[0].request.waiting, 2, "two more are queued behind the first");

  shown[0].answer("allow-once");
  await first;
  await settle();
  assert.equal(shown[1].request.waiting, 1);

  shown[1].answer("allow-once");
  await second;
  await settle();
  assert.equal(shown[2].request.waiting, 0, "nothing is behind the last one");

  shown[2].answer("allow-once");
  await third;
});

/*
 * A question queued behind another may be overtaken by Stop. Asking it then is
 * asking about a turn that no longer exists — and the card that appeared would
 * have no request left to answer, which is the state `permissionSettled` was
 * added to stop the panel reporting.
 */
test("stopping the turn drops a question that was never shown", async () => {
  const { session, shown, logged } = held();

  const first = session.askPermission(READ("a"));
  const second = session.askPermission(READ("b"));
  await settle();
  assert.equal(shown.length, 1);

  session.cancel();
  shown[0].answer("allow-once");
  await first;
  await settle();

  assert.equal(shown.length, 1, "the queued question is never put on screen");
  assert.deepEqual(await second, { outcome: { outcome: "cancelled" } });
  assert.ok(
    logged.some((line) => /Dropped a queued question/.test(line)),
    "and it is said out loud, because no card said it"
  );
});

/*
 * Tearing the panel down for real is the other case. `newSession` bumps the
 * same counter and is not driven here, because it reconnects: it would spawn
 * the real CLI looking for a session this stub cannot give it.
 */
test("disposing drops queued questions too", async () => {
  const { session, shown } = held();

  const first = session.askPermission(READ("a"));
  const second = session.askPermission(READ("b"));
  await settle();

  session.dispose();
  shown[0].answer("allow-once");
  await first;
  await settle();

  assert.equal(shown.length, 1);
  assert.deepEqual(await second, { outcome: { outcome: "cancelled" } });
});

/** Every route that abandons the conversation bumps the generation. */
test("every teardown drops queued questions", () => {
  const fs = require("node:fs");
  const source = fs.readFileSync(path.join(root, "src", "kiroSession.ts"), "utf8");
  for (const name of ["cancel", "newSession", "dispose"]) {
    const from = source.indexOf(`  ${name === "newSession" ? "async " : ""}${name}(`);
    assert.ok(from > -1, `${name} exists`);
    const body = source.slice(from, source.indexOf("\n  }", from));
    assert.match(body, /cancelQueuedPermissions/, `${name} drops queued questions`);
  }
});

/*
 * Only the part that asks a human is queued.
 *
 * An auto-approval waiting behind a card nobody has looked at would stall the
 * turn on a question the user was never going to be asked.
 */
test("an auto-approved permission does not wait behind a card", async () => {
  const { session, shown } = held({ autoApproveTools: true });

  const blocking = session.askPermission({
    toolCall: { title: "run something", kind: "execute" },
    options: [{ optionId: "yes", name: "Yes", kind: "allow_once" }],
  });
  assert.deepEqual(await blocking, {
    outcome: { outcome: "selected", optionId: "yes" },
  });
  assert.equal(shown.length, 0, "nothing was asked");
});

test("the one-gate edit skip does not wait behind a card either", async () => {
  const { session, shown } = held();

  const first = session.askPermission(READ("a"));
  await settle();
  assert.equal(shown.length, 1, "the read is on screen and unanswered");

  // A write-like tool, with the review diff about to open: no prompt of its
  // own, and no waiting for the read to be answered first.
  const edit = await session.askPermission({
    toolCall: { title: "Editing example.js", kind: "edit" },
    options: [
      { optionId: "allow-once", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
  });
  assert.deepEqual(edit, { outcome: { outcome: "selected", optionId: "allow-once" } });
  assert.equal(shown.length, 1, "the edit asked nothing");

  shown[0].answer("allow-once");
  await first;
});
