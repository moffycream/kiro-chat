/*
 * The panel's slash commands.
 *
 * The v3 engine has no command endpoint, so the list is the panel's own and
 * each entry is answered by something v3 does have. `test/v3Session.test.js`
 * drives those answers.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  describeCommandResult,
  isRunnable,
  NOT_IN_PANEL,
  offerable,
  PANEL_COMMANDS,
  reasonNotOffered,
  turnsKeptByRewind,
} = require("../out/slashCommands");

test("everything the panel can answer is on the list", () => {
  const offered = offerable(PANEL_COMMANDS).map((c) => c.name);
  for (const name of ["help", "model", "effort", "compact", "context", "usage", "rewind", "clear"]) {
    assert.ok(offered.includes(name), `${name} must be offered`);
  }
});

/** A name is spelled one way between the menu, the parser and `runCommand`. */
test("names carry no slash and are unique", () => {
  const names = PANEL_COMMANDS.map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) assert.ok(!name.startsWith("/"), `${name} kept its slash`);
});

/**
 * `quit` would kill the process the panel is talking to, `paste` reads a
 * clipboard the CLI does not have behind a webview, `voice` a microphone,
 * `reply` opens $EDITOR, and `chat` is a second conversation store competing
 * with the panel's own history.
 */
test("commands that cannot work from a webview are not offered", () => {
  const offered = offerable(PANEL_COMMANDS).map((c) => c.name);
  for (const name of NOT_IN_PANEL) {
    assert.ok(!offered.includes(name), `${name} must not be offered`);
  }
});

/**
 * Recognised but refused. Unrecognised, `/tools` would go to the model as a
 * message nobody wrote, and be charged for: measured against kiro-cli 3.1.0.
 */
test("a command only Kiro's terminal has is known, refused, and explained", () => {
  for (const name of ["tools", "mcp", "agent", "quit"]) {
    const command = PANEL_COMMANDS.find((c) => c.name === name);
    assert.ok(command, `${name} must be recognised`);
    assert.equal(isRunnable(command), false);
    assert.match(reasonNotOffered(name), /\.$/, "and the reason is a sentence");
  }
});

test("a command that answers only with data still says something", () => {
  assert.equal(
    describeCommandResult("compact", { ok: false, text: "Kiro could not compact this conversation." }),
    "Kiro could not compact this conversation."
  );
  assert.equal(
    describeCommandResult("x", { ok: true, text: "", data: { message: "Nothing here" } }),
    "Nothing here"
  );
  assert.equal(describeCommandResult("x", { ok: true, text: "", data: { entries: [1, 2, 3] } }), "3 entries.");
  assert.equal(describeCommandResult("x", { ok: true, text: "", data: { entries: [] } }), "No entries.");
  assert.equal(describeCommandResult("goal", { ok: true, text: "" }), "/goal finished.");
  assert.equal(describeCommandResult("goal", { ok: false, text: "" }), "/goal did not run.");
});

/**
 * Measured against kiro-cli 3.1.0: `session/fork` at the first of two messages
 * gave a session holding that message and its reply. So the chosen turn is
 * kept and only what came after is dropped.
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
