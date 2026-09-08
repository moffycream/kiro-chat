/*
 * Kiro's own slash commands.
 *
 * The fixture is not invented: `test/fixtures/kiro-commands.json` is the
 * `_kiro.dev/commands/available` payload as kiro-cli 2.20.2 actually sent it,
 * captured by driving `kiro-cli acp` directly. A test written against a made-up
 * shape proves only that the parser agrees with the person who wrote it.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  describeCommandResult,
  isRunnable,
  NOT_IN_PANEL,
  offerable,
  parseAvailableCommands,
  parseRewindTurns,
  turnsKeptByRewind,
} = require("../out/slashCommands");

const payload = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "kiro-commands.json"), "utf8")
);
const commands = parseAvailableCommands(payload);

test("the whole list Kiro announces is read", () => {
  assert.equal(commands.length, 25, "kiro-cli 2.20.2 offers 25 commands");
  const names = commands.map((c) => c.name);
  for (const expected of ["compact", "rewind", "context", "usage", "clear"]) {
    assert.ok(names.includes(expected), `${expected} must survive parsing`);
  }
});

/**
 * Kiro writes the name with its slash and we never do, so that a name is
 * spelled one way between the menu, the parser and `runCommand`. The slash was
 * what `_kiro.dev/commands/execute` rejected outright when the usage panel
 * first sent one.
 */
test("names are stored without the slash Kiro sends", () => {
  for (const command of commands) {
    assert.ok(!command.name.startsWith("/"), `${command.name} kept its slash`);
  }
});

test("metadata Kiro attaches is carried through", () => {
  const context = commands.find((c) => c.name === "context");
  assert.equal(context.hint, "add <path>, remove <path>, clear");
  assert.deepEqual(context.subcommands, ["show", "add", "remove", "clear"]);

  const chat = commands.find((c) => c.name === "chat");
  assert.equal(chat.local, true, "chat is handled by the CLI itself");

  const stats = commands.find((c) => c.name === "stats");
  assert.equal(stats.hidden, true, "Kiro marks stats hidden");
});

test("a payload that is not a list is not a crash", () => {
  assert.deepEqual(parseAvailableCommands(undefined), []);
  assert.deepEqual(parseAvailableCommands({ commands: "nope" }), []);
  assert.deepEqual(parseAvailableCommands({ commands: [{}] }), []);
});

/**
 * `quit` would kill the process the panel is talking to, `paste` reads a
 * clipboard the CLI does not have behind a webview, `voice` a microphone,
 * `reply` opens $EDITOR, and `chat` is a second conversation store competing
 * with the panel's own history. None of them can work from here, and a menu
 * row that hangs is worse than one that is absent.
 */
test("commands that cannot work from a webview are not offered", () => {
  const offered = offerable(commands).map((c) => c.name);
  for (const name of NOT_IN_PANEL) {
    assert.ok(!offered.includes(name), `${name} must not be offered`);
  }
  assert.ok(offered.includes("compact"), "compact is the point of the exercise");
  assert.ok(offered.includes("rewind"));
  assert.ok(offered.includes("usage"));
});

/** Hidden means "do not advertise", not "do not run". */
test("a hidden command stays runnable but is left out of the menu", () => {
  const stats = commands.find((c) => c.name === "stats");
  assert.equal(isRunnable(stats), true, "stats can still be typed in full");
  assert.ok(
    !offerable(commands).some((c) => c.name === "stats"),
    "but the menu does not put it in front of anyone"
  );
});

/**
 * Measured, not assumed: `/rewind`, `/knowledge`, `/goal` and `/code` all
 * answered with an empty `message` and everything in `data`. Falling straight
 * through to the message would show a blank card for a command that worked.
 */
test("a command that answers only with data still says something", () => {
  assert.equal(
    describeCommandResult("compact", { ok: false, text: "Conversation too short to compact." }),
    "Conversation too short to compact."
  );
  assert.equal(
    describeCommandResult("mcp", { ok: true, text: "", data: { message: "No MCP servers configured" } }),
    "No MCP servers configured"
  );
  assert.equal(
    describeCommandResult("knowledge", { ok: true, text: "", data: { entries: [1, 2, 3] } }),
    "3 entries."
  );
  assert.equal(
    describeCommandResult("knowledge", { ok: true, text: "", data: { entries: [] } }),
    "No entries."
  );
  assert.equal(describeCommandResult("goal", { ok: true, text: "" }), "/goal finished.");
  assert.equal(describeCommandResult("goal", { ok: false, text: "" }), "/goal did not run.");
});

test("rewind turns are read as Kiro reports them", () => {
  const turns = parseRewindTurns({
    turns: [
      { logIndex: 4, label: "Reply with only: CHARLIE", group: "2%", responseSnippet: "CHARLIE" },
      { logIndex: 2, label: "Reply with only: BRAVO", group: "2%", responseSnippet: "BRAVO" },
      { logIndex: 0, label: "Reply with only: ALPHA", group: "2%", responseSnippet: "ALPHA" },
    ],
  });
  assert.equal(turns.length, 3);
  assert.equal(turns[0].logIndex, 4, "newest first, as sent");
  assert.equal(turns[2].label, "Reply with only: ALPHA");
  assert.deepEqual(parseRewindTurns(undefined), []);
  assert.deepEqual(parseRewindTurns({ turns: [{ label: "no index" }] }), []);
});

/**
 * Measured against kiro-cli 2.20.2: with ALPHA, BRAVO and CHARLIE in the log,
 * rewinding to BRAVO forked a session that still held ALPHA *and* BRAVO. So
 * the chosen turn is kept and only what came after it is dropped. Getting this
 * backwards would trim one turn too many off the transcript every time.
 */
test("rewinding to a turn keeps that turn", () => {
  assert.equal(turnsKeptByRewind(3, 0), 3, "the newest turn keeps everything");
  assert.equal(turnsKeptByRewind(3, 1), 2, "the middle turn keeps itself and the first");
  assert.equal(turnsKeptByRewind(3, 2), 1, "the oldest keeps only itself");
});

test("a nonsense position keeps the whole conversation", () => {
  // Trimming on a number we do not understand would throw away messages.
  assert.equal(turnsKeptByRewind(3, -1), 3);
  assert.equal(turnsKeptByRewind(3, 9), 3);
  assert.equal(turnsKeptByRewind(0, 0), 0);
  assert.equal(turnsKeptByRewind(NaN, 0), 0);
});
