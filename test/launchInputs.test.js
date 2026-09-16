// What a running kiro-cli started from, compared when "+" reuses it.
//
// Driven against real folders in a temp directory, because the whole job is
// noticing what changed on disk.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { snapshotLaunchInputs, launchInputsChanged } = require("../out/launchInputs");

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kiro-launch-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(path.join(home, ".kiro", "settings"), { recursive: true });
  fs.mkdirSync(path.join(workspace, ".kiro", "steering"), { recursive: true });
  fs.writeFileSync(path.join(home, ".kiro", "settings", "mcp.json"), "{}");
  fs.writeFileSync(path.join(workspace, ".kiro", "steering", "style.md"), "tabs");
  const binary = path.join(root, "kiro-cli.exe");
  fs.writeFileSync(binary, "v1");
  const sources = (overrides = {}) => ({
    settings: { command: "", env: {}, args: [], allowFileWrites: true },
    roots: [workspace],
    command: binary,
    home,
    ...overrides,
  });
  return { root, home, workspace, binary, sources };
}

/** Push a file's mtime forward, so a same-size rewrite is not hidden by timer resolution. */
function touchLater(file, content) {
  fs.writeFileSync(file, content);
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
}

test("nothing changed means the running agent is current", (t) => {
  const box = sandbox();
  t.after(() => fs.rmSync(box.root, { recursive: true, force: true }));
  const before = snapshotLaunchInputs(box.sources());
  assert.deepEqual(launchInputsChanged(before, snapshotLaunchInputs(box.sources())), []);
});

test("an edited, added or removed config file is noticed", (t) => {
  const box = sandbox();
  t.after(() => fs.rmSync(box.root, { recursive: true, force: true }));
  const before = snapshotLaunchInputs(box.sources());

  touchLater(path.join(box.home, ".kiro", "settings", "mcp.json"), "{\"a\":1}");
  fs.mkdirSync(path.join(box.workspace, ".kiro", "agents"));
  fs.writeFileSync(path.join(box.workspace, ".kiro", "agents", "reviewer.json"), "{}");
  fs.rmSync(path.join(box.workspace, ".kiro", "steering", "style.md"));

  const reasons = launchInputsChanged(before, snapshotLaunchInputs(box.sources()));
  assert.ok(reasons.some((r) => /mcp\.json was changed/.test(r)), reasons.join("\n"));
  assert.ok(reasons.some((r) => /reviewer\.json was added/.test(r)), reasons.join("\n"));
  assert.ok(reasons.some((r) => /style\.md was removed/.test(r)), reasons.join("\n"));
});

test("only Kiro's config folders are watched, not the rest of .kiro", (t) => {
  const box = sandbox();
  t.after(() => fs.rmSync(box.root, { recursive: true, force: true }));
  const before = snapshotLaunchInputs(box.sources());
  // Kiro writes conversations here on every turn; watching it would make
  // every "+" after a message restart, which is the bug being fixed.
  fs.mkdirSync(path.join(box.home, ".kiro", "sessions", "cli"), { recursive: true });
  fs.writeFileSync(path.join(box.home, ".kiro", "sessions", "cli", "abc.jsonl"), "turn");
  assert.deepEqual(launchInputsChanged(before, snapshotLaunchInputs(box.sources())), []);
});

test("a changed launch setting, workspace or binary is noticed", (t) => {
  const box = sandbox();
  t.after(() => fs.rmSync(box.root, { recursive: true, force: true }));
  const before = snapshotLaunchInputs(box.sources());

  const env = launchInputsChanged(
    before,
    snapshotLaunchInputs(box.sources({ settings: { command: "", env: { A: "1" }, args: [], allowFileWrites: true } }))
  );
  assert.deepEqual(env, ["Kiro Chat's launch settings changed"]);

  const roots = launchInputsChanged(before, snapshotLaunchInputs(box.sources({ roots: [box.home] })));
  assert.ok(roots.includes("the workspace folders changed"), roots.join("\n"));

  touchLater(box.binary, "v2-longer");
  const binary = launchInputsChanged(before, snapshotLaunchInputs(box.sources()));
  assert.deepEqual(binary, ["kiro-cli itself was updated"]);
});

test("a command found on PATH is not stamped, and does not read as a change", () => {
  const sources = { settings: {}, roots: [], command: "kiro-cli", home: os.tmpdir() };
  const snap = snapshotLaunchInputs(sources);
  assert.equal(snap.binary, undefined);
});
