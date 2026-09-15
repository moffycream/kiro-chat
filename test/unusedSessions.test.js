/*
 * `session/new` writes a conversation to disk the moment it is called, so the
 * panel left an empty one behind every time it connected. Most of that is
 * fixed by not creating them; these are the rules for handing back the ones
 * that are made anyway.
 *
 * The delete is Kiro's own `chat --delete-session`, so the only thing that can
 * go badly wrong here is deleting a conversation somebody wanted. Every test
 * below is ultimately about that.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  deleteSessionArgs,
  forgetUnused,
  isEmptySession,
  isSessionId,
  MAX_UNUSED,
  readDeleteOutcome,
  rememberUnused,
  sessionLogPath,
  UNUSED_SESSIONS_KEY,
} = require("../out/unusedSessions.js");

const ID = "36b32e21-18ef-4308-aeba-5b81d6a4d0c7";
const OTHER = "16d9aac6-9072-4f10-b349-ec4e37c63ea0";

test("only Kiro's own ids are accepted", () => {
  assert.equal(isSessionId(ID), true);
  for (const bad of [
    "",
    "not-a-session",
    ID + " && del /q *",
    `${ID};rm -rf /`,
    undefined,
    null,
    42,
    {},
  ]) {
    assert.equal(isSessionId(bad), false, `${String(bad)} must not reach a command line`);
  }
});

test("the list keeps one entry per id, newest last", () => {
  let list = rememberUnused([], ID);
  list = rememberUnused(list, OTHER);
  list = rememberUnused(list, ID);
  assert.deepEqual(list, [OTHER, ID]);
  assert.deepEqual(forgetUnused(list, OTHER), [ID]);
  assert.deepEqual(forgetUnused(list, "nonsense"), [OTHER, ID]);
});

/** Whatever is in storage came from another window, and may be anything. */
test("junk in storage is dropped rather than carried into a delete", () => {
  const list = rememberUnused([null, 7, "sudo rm", { id: ID }], ID);
  assert.deepEqual(list, [ID]);
  assert.deepEqual(forgetUnused([null, 7, OTHER], ID), [OTHER]);
});

test("the list is capped so old ids are forgotten, not asked about forever", () => {
  let list = [];
  for (let i = 0; i < MAX_UNUSED + 10; i++) {
    list = rememberUnused(list, `36b32e21-18ef-4308-aeba-${String(i).padStart(12, "0")}`);
  }
  assert.equal(list.length, MAX_UNUSED);
  assert.match(list[list.length - 1], /000000000059$/, "the newest must survive");
});

/*
 * The gate on every delete. The stored list is a hint — two windows share one
 * globalState and either can lose the other's removal — so what is actually
 * checked is the conversation log Kiro appends a line to per turn.
 */
test("only a session whose log is empty counts as empty", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kiro-unused-"));
  const dir = path.join(home, ".kiro", "sessions", "cli");
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(sessionLogPath(ID, home), "");
  assert.equal(isEmptySession(ID, home), true, "a zero-byte log is an empty session");

  fs.writeFileSync(sessionLogPath(OTHER, home), '{"kind":"Prompt"}\n');
  assert.equal(isEmptySession(OTHER, home), false, "a conversation must never be deleted");

  const missing = "00000000-0000-4000-8000-000000000000";
  assert.equal(isEmptySession(missing, home), false, "no log is not proof of emptiness");
  assert.equal(isSessionId("../../etc/passwd"), false);
  assert.equal(isEmptySession("../../etc/passwd", home), false);
});

/*
 * `--session-source v2` names the store ACP writes. Measured against
 * kiro-cli 2.21: without it the same delete also searches the older sqlite
 * store and takes 20-30 seconds instead of 2.
 */
test("the delete names the store ACP actually writes", () => {
  assert.deepEqual(deleteSessionArgs([], ID), [
    "chat",
    "--delete-session",
    ID,
    "--session-source",
    "v2",
  ]);
  // WSL reaches the binary through a launch argument, which has to stay in
  // front of the subcommand or nothing runs.
  assert.deepEqual(deleteSessionArgs(["kiro-cli"], ID)[0], "kiro-cli");
});

/*
 * Kiro refuses to delete a session a live process holds — which is what
 * another window's open panel looks like. That is not a failure, and the id
 * has to survive to be tried again; anything else is dropped, or an old Kiro
 * without the flag would be asked once per start forever.
 */
test("a refusal over a live process is kept, other failures are not", () => {
  assert.equal(readDeleteOutcome(0, "✔ Deleted chat session " + ID), "deleted");
  assert.equal(
    readDeleteOutcome(1, `Error: Failed to delete chat session ${ID}: Session is active in another process (PID 17476)`),
    "busy"
  );
  assert.equal(readDeleteOutcome(2, "error: unexpected argument '--delete-session'"), "failed");
  assert.equal(readDeleteOutcome(null, ""), "failed");
});

test("the storage key is stable", () => {
  assert.equal(UNUSED_SESSIONS_KEY, "kiroChat.unusedSessions");
});
