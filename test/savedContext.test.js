// The context figure Kiro saved after a conversation's last real request.
// Kiro's internal file, not a protocol — so anything unexpected is "unknown".
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { savedContextPercent, savedContextPercentFrom, sessionFilePath } = require("../out/savedContext");

// The shape of ~/.kiro/sessions/cli/<id>.json in kiro-cli 2.21.4, trimmed.
const saved = (lastContextUsage) =>
  JSON.stringify({
    session_id: "dc5a0df8-3cd1-4d03-ab5b-569862153253",
    session_state: {
      version: "v1",
      conversation_metadata: { user_turn_metadatas: [], last_context_usage: lastContextUsage },
    },
  });

test("the saved percentage is read from where Kiro keeps it", () => {
  assert.equal(savedContextPercentFrom(saved({ percentage: 9.0638, model_id: "claude-opus-5" })), 9.0638);
});

test("anything that is not a sane saved percentage is unknown, never zero", () => {
  assert.equal(savedContextPercentFrom(saved(null)), undefined, "a chat that never made a request");
  assert.equal(savedContextPercentFrom(saved({ percentage: "9" })), undefined);
  assert.equal(savedContextPercentFrom(saved({ percentage: -1 })), undefined);
  assert.equal(savedContextPercentFrom(saved({ percentage: 140 })), undefined);
  assert.equal(savedContextPercentFrom("{not json"), undefined);
  assert.equal(savedContextPercentFrom(JSON.stringify({ moved: true })), undefined, "a format that has moved");
});

test("the file is found by session id, and only a real id is looked up", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kiro-saved-"));
  try {
    const id = "dc5a0df8-3cd1-4d03-ab5b-569862153253";
    fs.mkdirSync(path.join(home, ".kiro", "sessions", "cli"), { recursive: true });
    fs.writeFileSync(path.join(home, ".kiro", "sessions", "cli", `${id}.json`), saved({ percentage: 2.7821 }));
    assert.equal(savedContextPercent(id, home), 2.7821);
    assert.equal(savedContextPercent("00000000-0000-0000-0000-000000000000", home), undefined, "missing file");
    assert.equal(sessionFilePath("../../secrets", home), undefined, "a stored id cannot walk the filesystem");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
