// Where Kiro's own memory lives, and what the panel says about it.
//
// The extension does not implement memory — Kiro CLI already reads these
// files into every turn. These check the parts that decide *which* files the
// panel claims are being read, because claiming the wrong one is the only way
// this feature can lie.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  MEMORY_FILENAME,
  MEMORY_TARGETS,
  PRIVATE_MEMORY_FILENAME,
  globalSteeringDir,
  isListedMemory,
  isPrivateMemory,
  localLabel,
  memoryDir,
  memoryTarget,
  memoryFilePath,
  memoryFilesIn,
  memoryTemplate,
  scopeLabel,
  steeringDir,
  targetPath,
  targetScope,
} = require("../out/memory");

test("memory lives in Kiro's own steering folder, not the repo root", () => {
  assert.equal(steeringDir("C:\\work\\app"), path.join("C:\\work\\app", ".kiro", "steering"));
  assert.equal(memoryFilePath("project", "C:\\work\\app"), path.join("C:\\work\\app", ".kiro", "steering", MEMORY_FILENAME));
});

test("the global folder is under the home directory, not the workspace", () => {
  assert.equal(globalSteeringDir("C:\\Users\\sam"), path.join("C:\\Users\\sam", ".kiro", "steering"));
  // The project root is irrelevant to the global scope, so passing one must
  // not sneak into the path.
  assert.equal(
    memoryDir("global", "C:\\work\\app", "C:\\Users\\sam"),
    path.join("C:\\Users\\sam", ".kiro", "steering")
  );
});

/*
 * The panel reports what Kiro reads. Kiro reads markdown out of that folder,
 * so anything else in there — an editor swap file, a stray .DS_Store — must
 * not be counted, or the menu tells the user a file is steering Kiro when it
 * is doing nothing at all.
 */
test("only markdown counts, and dotfiles never do", () => {
  const files = memoryFilesIn("/dir", ["notes.md", "swap.md.swp", ".hidden.md", "README.txt"], "project");
  assert.deepEqual(files.map((f) => f.label), ["notes.md"]);
  assert.equal(files[0].scope, "project");
  assert.equal(files[0].path, path.join("/dir", "notes.md"));
});

test("the listing is sorted, so the menu does not reshuffle between openings", () => {
  const files = memoryFilesIn("/dir", ["zeta.md", "alpha.md", "mid.md"], "global");
  assert.deepEqual(files.map((f) => f.label), ["alpha.md", "mid.md", "zeta.md"]);
});

/*
 * Both scopes can hold a file called memory.md, and one of the things a row
 * offers is deleting it. Without this the menu shows two identical rows with
 * a delete button each and the user picks by guess.
 */
test("a row says which chats its file steers", () => {
  assert.match(scopeLabel("project"), /Project memory/);
  assert.match(scopeLabel("global"), /Global memory/);
  assert.notEqual(scopeLabel("project"), scopeLabel("global"));
});

/*
 * The add rows mark the local file "(not committed)", which would otherwise
 * imply the other two are committed. Project memory is. Global memory is not —
 * it lives in the home directory, outside any repository — so its row says so
 * rather than letting the qualifier on the local row mislead about it.
 */
test("global memory does not read as something that gets committed", () => {
  assert.match(scopeLabel("global"), /this machine only/);
});

/*
 * The local row is the only one making a promise about git, so it is the only
 * one that asks. A file committed before it was excluded is still tracked, and
 * no ignore rule touches a tracked file — the one case where the reassuring
 * half would be false.
 */
test("the local row reports what git actually does", () => {
  assert.match(localLabel(true), /not committed/);
  assert.match(localLabel(false), /git can see this/);
  assert.notEqual(localLabel(true), localLabel(false));
});

/** All three read differently at a glance, which is the whole point of them. */
test("the three kinds are told apart without reading carefully", () => {
  const shown = [scopeLabel("project"), localLabel(true), scopeLabel("global")];
  assert.equal(new Set(shown).size, 3, "no two rows may say the same thing");
});

/*
 * The guard on removal. A path arriving in a webview message is not a licence
 * to delete anything on disk — the rule `setSetting` already applies to an
 * untrusted settings key, applied to something rather more permanent.
 */
test("a path that is not a listed memory file cannot be removed", () => {
  const files = memoryFilesIn("C:\\p\\.kiro\\steering", ["memory.md"], "project");
  assert.equal(isListedMemory("C:\\p\\.kiro\\steering\\memory.md", files), true);
  assert.equal(isListedMemory("C:\\p\\src\\index.ts", files), false);
  assert.equal(isListedMemory("C:\\Windows\\System32\\drivers\\etc\\hosts", files), false);
});

test("an empty path removes nothing", () => {
  const files = memoryFilesIn("/d", ["memory.md"], "project");
  assert.equal(isListedMemory("", files), false);
  assert.equal(isListedMemory(undefined, files), false);
});

test("nothing can be removed when nothing is listed", () => {
  assert.equal(isListedMemory("C:\\p\\.kiro\\steering\\memory.md", []), false);
});

/*
 * Windows spells one file several ways, and the panel and the folder listing
 * need not agree on the spelling. A guard that misses one refuses a real
 * click, which reads as a dead button.
 */
test("the guard matches a file however its path is spelled", () => {
  const files = memoryFilesIn("C:\\Proj\\.kiro\\steering", ["memory.md"], "project");
  assert.equal(isListedMemory("c:/proj/.kiro/steering/memory.md", files), true);
});

/** Whole-path equality, so a sibling with a longer name is not a match. */
test("a near-miss path is not a match", () => {
  const files = memoryFilesIn("C:\\p\\.kiro\\steering", ["memory.md"], "project");
  assert.equal(isListedMemory("C:\\p\\.kiro\\steering\\memory.md.bak", files), false);
});

/*
 * Private memory is project memory with a different name and a git rule. It
 * has to share the folder, because .kiro/steering is the only place Kiro
 * reads — which is exactly why it needs the rule.
 */
test("private memory lives beside project memory, under its own name", () => {
  const root = "C:\\repo";
  assert.equal(targetPath("private", root), path.join(steeringDir(root), PRIVATE_MEMORY_FILENAME));
  assert.equal(path.dirname(targetPath("private", root)), path.dirname(targetPath("project", root)));
  assert.notEqual(targetPath("private", root), targetPath("project", root));
});

/*
 * This shipped broken, and this is the test that would have caught it.
 *
 * The message handler read `scope === "global" ? "global" : "project"` — right
 * for two targets, silently wrong for three. Clicking "Add private project
 * memory" made an ordinary `memory.md` with no git rule: a file the user had
 * just been told would never be committed. A default that swallows an
 * unrecognised value cannot report that anything went wrong, which is why
 * nothing failed.
 */
test("every target survives the trip from the panel", () => {
  for (const target of MEMORY_TARGETS) {
    assert.equal(memoryTarget(target), target, `${target} must not be rounded to another`);
  }
  assert.equal(MEMORY_TARGETS.length, 3, "project, private and global");
});

test("private is not quietly turned into project", () => {
  assert.equal(memoryTarget("private"), "private");
  assert.notEqual(memoryTarget("private"), "project");
});

/** An unknown target is refused, never substituted. See gatesForMode. */
test("an unknown target is refused rather than defaulted", () => {
  assert.equal(memoryTarget("nonsense"), undefined);
  assert.equal(memoryTarget(""), undefined);
  assert.equal(memoryTarget(undefined), undefined);
  assert.equal(memoryTarget(null), undefined);
  assert.equal(memoryTarget({}), undefined);
});

test("private memory is scoped to the project, never to every project", () => {
  assert.equal(targetScope("private"), "project");
  assert.equal(targetScope("project"), "project");
  assert.equal(targetScope("global"), "global");
});

test("the two project files are told apart by name alone", () => {
  assert.equal(isPrivateMemory("C:\\r\\.kiro\\steering\\memory.local.md"), true);
  assert.equal(isPrivateMemory("C:\\r\\.kiro\\steering\\memory.md"), false);
  assert.equal(isPrivateMemory("C:\\r\\AGENTS.md"), false);
  assert.equal(isPrivateMemory(""), false);
});

/** A file named on disk in another case is still the private one. */
test("the private name is matched case-insensitively", () => {
  assert.equal(isPrivateMemory("C:\\r\\.kiro\\steering\\Memory.Local.MD"), true);
});

/*
 * Only the private template explains the git rule. Putting that paragraph on
 * the shared file would tell the team their committed notes are not committed.
 */
test("only the private template mentions the git exclude", () => {
  assert.match(memoryTemplate("private"), /\.git\/info\/exclude/);
  assert.doesNotMatch(memoryTemplate("project"), /exclude/);
  assert.doesNotMatch(memoryTemplate("global"), /exclude/);
});

/*
 * The frontmatter is not needed — a bare .md in the steering folder is loaded,
 * which was measured against kiro-cli acp 2.20.2 rather than assumed. It is
 * written anyway because it is the only place the user learns the knob exists.
 */
test("the template makes the inclusion default visible and adjustable", () => {
  const body = memoryTemplate("project");
  assert.match(body, /^---\r?\ninclusion: always\r?\n---/, "the default has to be on the page");
  assert.match(body, /fileMatch/, "and so do the alternatives");
  assert.match(body, /manual/);
});

test("the template says which chats the file applies to", () => {
  assert.match(memoryTemplate("project"), /this project/);
  assert.match(memoryTemplate("global"), /every project/);
});

