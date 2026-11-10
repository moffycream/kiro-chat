// `_kiro/customAgent/config_error`, in the shape kiro-cli 3.1.0 sent it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  readAgentConfigError,
  agentWarningKey,
  rememberAgentWarning,
} = require("../out/agentConfig");

const CAPTURED = {
  sessionId: "sess_a",
  path: "C:\\Users\\someone\\.kiro\\agents\\kirocrew.json",
  reasonCode: "invalid_config",
  error: "PromptFileError: Absolute file:// URIs are not allowed in agent prompts: file://C:\\x\\prompt.md",
};

test("the agent is named from its file, and the reason is Kiro's", () => {
  const problem = readAgentConfigError(CAPTURED);
  assert.equal(problem.name, "kirocrew");
  assert.equal(problem.path, CAPTURED.path);
  assert.match(problem.reason, /^PromptFileError/);
});

test("a report with no file is not a warning, and a missing reason says so", () => {
  for (const params of [undefined, null, {}, { path: "" }, { path: 7 }]) {
    assert.equal(readAgentConfigError(params), undefined);
  }
  assert.equal(readAgentConfigError({ path: "a.json" }).reason, "Kiro did not say why.");
  assert.equal(readAgentConfigError({ path: "a.json", reasonCode: "bad" }).reason, "bad");
});

test("each file and reason warns once, and a new reason warns again", () => {
  const problem = readAgentConfigError(CAPTURED);
  const first = rememberAgentWarning(undefined, agentWarningKey(problem));
  assert.equal(first.fresh, true);
  assert.equal(rememberAgentWarning(first.seen, agentWarningKey(problem)).fresh, false);
  const changed = agentWarningKey({ ...problem, reason: "Something else" });
  assert.equal(rememberAgentWarning(first.seen, changed).fresh, true);
});

test("what is remembered cannot grow without limit or be poisoned", () => {
  let seen = ["junk", 7, null];
  for (let i = 0; i < 80; i++) seen = rememberAgentWarning(seen, `key${i}`).seen;
  assert.ok(seen.length <= 50);
  assert.ok(seen.every((key) => typeof key === "string"));
});

test("the session reports it, through the prefix-safe comparison", () => {
  const session = fs.readFileSync(path.join(__dirname, "..", "src", "kiroSession.ts"), "utf8");
  assert.match(session, /bareMethod\(method\) === "customAgent\/config_error"/);
});
