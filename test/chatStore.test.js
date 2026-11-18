const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ChatStore, CHAT_INDEX_KEY, LEGACY_HISTORY_KEY } = require("../out/chatStore");

/** A Memento that keeps what it is given and counts how big each write was. */
function memento(initial = {}) {
  const data = { ...initial };
  const writes = [];
  return {
    data,
    writes,
    get: (key, fallback) => (key in data ? data[key] : fallback),
    update: async (key, value) => {
      writes.push({ key, bytes: JSON.stringify(value ?? null).length });
      if (value === undefined) delete data[key];
      else data[key] = value;
    },
  };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "chatstore-"));
}

const chat = (id, updatedAt, cwd = "C:\\work", text = "hello") => ({
  id,
  sessionId: `s-${id}`,
  cwd,
  title: `Chat ${id}`,
  updatedAt,
  messageCount: 2,
  history: [
    { role: "user", text },
    { role: "agent", text: "x".repeat(5000) },
  ],
});

test("a save writes that chat's file and a small index, not every transcript", async () => {
  const dir = tempDir();
  const m = memento();
  const store = new ChatStore(dir, m);
  for (let i = 0; i < 30; i++) await store.save(chat(`c${i}`, 1000 + i), 100);
  const last = m.writes.at(-1);
  assert.equal(last.key, CHAT_INDEX_KEY);
  // 30 chats with 5 KB transcripts each would be 150 KB in one entry.
  assert.ok(last.bytes < 15000, `index write was ${last.bytes} bytes`);
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith(".json")).length, 30);
  assert.ok(!store.index()[0].history, "the index carries no transcript");
});

test("a chat loads back whole, and the list has its preview without reading files", async () => {
  const store = new ChatStore(tempDir(), memento());
  await store.save(chat("a", 1, "C:\\work", "first"), 100);
  const loaded = store.load("a");
  assert.equal(loaded.history.length, 2);
  assert.equal(loaded.sessionId, "s-a");
  assert.equal(store.find("a").preview.startsWith("xxxx"), true);
});

test("saving again replaces the chat and moves it to the top", async () => {
  const store = new ChatStore(tempDir(), memento());
  await store.save(chat("a", 1), 100);
  await store.save(chat("b", 2), 100);
  await store.save({ ...chat("a", 3), title: "Renamed" }, 100);
  assert.deepEqual(store.index().map((e) => e.id), ["a", "b"]);
  assert.equal(store.find("a").title, "Renamed");
});

test("the per-folder cap drops the oldest chats and their files", async () => {
  const dir = tempDir();
  const store = new ChatStore(dir, memento());
  for (let i = 0; i < 5; i++) await store.save(chat(`c${i}`, i), 3);
  assert.deepEqual(store.index().map((e) => e.id), ["c4", "c3", "c2"]);
  assert.ok(!fs.existsSync(path.join(dir, "c0.json")));
  assert.ok(fs.existsSync(path.join(dir, "c4.json")));
});

test("removing a chat removes its file and its row", async () => {
  const dir = tempDir();
  const store = new ChatStore(dir, memento());
  await store.save(chat("a", 1), 100);
  await store.remove("a");
  assert.equal(store.index().length, 0);
  assert.ok(!fs.existsSync(path.join(dir, "a.json")));
});

test("a listed chat whose file is gone still opens, empty, rather than vanishing", async () => {
  const dir = tempDir();
  const store = new ChatStore(dir, memento());
  await store.save(chat("a", 1), 100);
  fs.unlinkSync(path.join(dir, "a.json"));
  assert.deepEqual(store.load("a").history, []);
});

test("an id that is not a chat id is never used as a path", async () => {
  const store = new ChatStore(tempDir(), memento());
  assert.throws(() => store.save(chat("../evil", 1), 100), /Not a chat id/);
  assert.equal(store.load("../evil"), undefined);
});

test("old history moves into files once, and the old entry is cleared", async () => {
  const dir = tempDir();
  const legacy = [chat("a", 2), chat("b", 1)];
  const m = memento({ [LEGACY_HISTORY_KEY]: legacy });
  const store = new ChatStore(dir, m);
  assert.equal(await store.migrate(), 2);
  assert.equal(m.data[LEGACY_HISTORY_KEY], undefined);
  assert.deepEqual(store.index().map((e) => e.id), ["a", "b"]);
  assert.equal(store.load("b").history.length, 2);
  // Nothing left to move the second time.
  assert.equal(await store.migrate(), 0);
});

test("a chat already saved in the new form wins over its old copy", async () => {
  const m = memento({ [LEGACY_HISTORY_KEY]: [{ ...chat("a", 1), title: "Old" }] });
  const store = new ChatStore(tempDir(), m);
  await store.save({ ...chat("a", 5), title: "New" }, 100);
  await store.migrate();
  assert.equal(store.index().length, 1);
  assert.equal(store.find("a").title, "New");
});

test("if the move fails, the old entry is left alone to try again", async () => {
  const dir = tempDir();
  // A file where the folder should be: every write fails.
  const blocked = path.join(dir, "blocked");
  fs.writeFileSync(blocked, "");
  const m = memento({ [LEGACY_HISTORY_KEY]: [chat("a", 1)] });
  const store = new ChatStore(blocked, m);
  await assert.rejects(store.migrate());
  assert.equal(m.data[LEGACY_HISTORY_KEY].length, 1);
  assert.equal(m.data[CHAT_INDEX_KEY], undefined);
});

test("only old unlisted files are swept; another window's fresh file survives", async () => {
  const dir = tempDir();
  const store = new ChatStore(dir, memento());
  await store.save(chat("kept", 1), 100);
  fs.writeFileSync(path.join(dir, "orphan.json"), "{}");
  fs.writeFileSync(path.join(dir, "fresh.json"), "{}");
  const old = Date.now() - 2 * 24 * 60 * 60 * 1000;
  fs.utimesSync(path.join(dir, "orphan.json"), old / 1000, old / 1000);
  assert.equal(store.sweep(Date.now()), 1);
  assert.ok(!fs.existsSync(path.join(dir, "orphan.json")));
  assert.ok(fs.existsSync(path.join(dir, "fresh.json")));
  assert.ok(fs.existsSync(path.join(dir, "kept.json")));
});
