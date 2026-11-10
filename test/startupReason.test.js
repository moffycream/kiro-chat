// A Kiro that dies while starting reports why on stderr, and the only thing
// the request waiting on it is told is that the process stopped. The lines
// below are what a user's panel logged for a failed start, and what a healthy
// kiro-cli 3.1.0 writes on the way up.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  AGENT_STOPPED,
  describeStartupFailure,
  startupReason,
} = require("../out/startupError");

const DENIED = ["[kiro stderr] error:", "[kiro stderr] Access is denied. (os error 5)", "Kiro exited (code 1, signal none)."];

const HEALTHY = [
  '[kiro stderr] [INFO] kas.server.starting {"product":"KAS"}\n[INFO] Auth: --auth=acp-callback',
  "[kiro stderr] [INFO] [KiroAgent] MCP subsystem initialized",
  "[kiro stderr] [ERROR] (node:632) ExperimentalWarning: SQLite is an experimental feature\n(Use `node --trace-warnings ...` to show where the warning was created)",
];

test("the reason on the line after error: is what Kiro said", () => {
  assert.equal(startupReason(DENIED), "Access is denied. (os error 5)");
});

test("the same output in one chunk reads the same", () => {
  assert.equal(
    startupReason(["[kiro stderr] error:\nAccess is denied. (os error 5)"]),
    "Access is denied. (os error 5)"
  );
});

test("a reason on the error line itself is taken from there", () => {
  assert.equal(startupReason(["[kiro stderr] error: home directory not found"]), "home directory not found");
});

test("a healthy start's log has no reason in it", () => {
  assert.equal(startupReason(HEALTHY), undefined);
});

test("ordinary log lines around the failure do not replace it", () => {
  assert.equal(startupReason([...HEALTHY, ...DENIED]), "Access is denied. (os error 5)");
});

test("colour codes are not shown", () => {
  assert.equal(startupReason(["[kiro stderr] \u001b[31merror:\u001b[0m disk full"]), "disk full");
});

test("only stderr counts, and a bare error: is not a reason", () => {
  assert.equal(startupReason(["Starting: kiro-cli.exe acp", "Kiro exited (code 1, signal none)."]), undefined);
  assert.equal(startupReason(["[kiro stderr] error:"]), undefined);
  assert.equal(startupReason([]), undefined);
});

test("the bare stopped message is replaced when there is something better", () => {
  assert.equal(describeStartupFailure(AGENT_STOPPED, DENIED), "Access is denied. (os error 5)");
  assert.equal(describeStartupFailure(AGENT_STOPPED, HEALTHY), AGENT_STOPPED);
});

test("a message that already says what went wrong is left alone", () => {
  const timeout = 'Kiro did not answer "initialize" in time.';
  assert.equal(describeStartupFailure(timeout, DENIED), timeout);
});
