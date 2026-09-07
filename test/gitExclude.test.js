// Keeping a private memory file out of commits.
//
// The file has to live in .kiro/steering for Kiro to read it, so in a shared
// repository it is one `git add .` away from being everybody's. These pin the
// three ways that goes wrong quietly: the wrong git directory in a worktree,
// a pattern spelled in a way git does not match, and a duplicated entry.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { addExcludeEntry, excludeEntryFor, excludeFileIn } = require("../out/gitExclude");

/*
 * Measured in a scratch repository: from inside a worktree, `.git` is a *file*
 * holding a pointer and has no info/ directory, and git honours the *common*
 * directory's info/exclude. So the caller passes --git-common-dir and this
 * only joins. A naive `<root>/.git/info/exclude` works on the machine it was
 * written on and silently leaves the file committable for anyone on a
 * worktree — which is the worst way for this to fail.
 */
test("the exclude file is inside whatever git directory was reported", () => {
  assert.equal(
    excludeFileIn("C:\\repo\\.git"),
    path.join("C:\\repo\\.git", "info", "exclude")
  );
  // A worktree's common dir is elsewhere entirely; it must be used as given.
  assert.equal(
    excludeFileIn("C:\\main\\.git"),
    path.join("C:\\main\\.git", "info", "exclude")
  );
});

/*
 * git patterns are relative and forward-slashed on every platform. An absolute
 * Windows path with backslashes matches nothing, and it fails *silently* — the
 * file stays visible while the panel says it is not committed.
 */
test("the entry is relative to the repo and forward-slashed", () => {
  const entry = excludeEntryFor(
    "C:\\repo",
    path.join("C:\\repo", ".kiro", "steering", "memory.local.md")
  );
  assert.equal(entry, ".kiro/steering/memory.local.md");
});

test("a file outside the repository yields no entry", () => {
  assert.equal(excludeEntryFor("C:\\repo", "C:\\elsewhere\\memory.local.md"), "");
});

test("the repository root itself yields no entry", () => {
  assert.equal(excludeEntryFor("C:\\repo", "C:\\repo"), "");
});

test("an empty entry is never written", () => {
  const before = "# existing\n";
  assert.deepEqual(addExcludeEntry(before, ""), { contents: before, changed: false });
});

/** Clicking twice, or reopening the project, must not grow the file. */
test("an entry already present is not added again", () => {
  const existing = "# git ls-files -o\n.kiro/steering/memory.local.md\n";
  const result = addExcludeEntry(existing, ".kiro/steering/memory.local.md");
  assert.equal(result.changed, false);
  assert.equal(result.contents, existing);
});

test("an entry is found despite surrounding blank lines and comments", () => {
  const existing = "#comment\n\n  .kiro/steering/memory.local.md  \n\n";
  assert.equal(addExcludeEntry(existing, ".kiro/steering/memory.local.md").changed, false);
});

/** The commented note must not stop the entry being found next time. */
test("adding twice in a row is idempotent", () => {
  const first = addExcludeEntry("", ".kiro/steering/memory.local.md");
  assert.equal(first.changed, true);
  const second = addExcludeEntry(first.contents, ".kiro/steering/memory.local.md");
  assert.equal(second.changed, false, "the note above the entry must not hide it");
  assert.equal(second.contents, first.contents);
});

test("a new entry lands on its own line even when the file lacks one", () => {
  const result = addExcludeEntry("no-trailing-newline", ".kiro/steering/memory.local.md");
  assert.equal(result.changed, true);
  const lines = result.contents.split("\n");
  assert.equal(lines[0], "no-trailing-newline", "existing content is kept intact");
  assert.ok(
    lines.includes(".kiro/steering/memory.local.md"),
    "and the entry is a line of its own, not glued to the last one"
  );
});

test("the entry is written with a note saying where it came from", () => {
  const result = addExcludeEntry("", ".kiro/steering/memory.local.md");
  assert.match(result.contents, /^# Kiro Chat:/m, "an unexplained path is a mystery to leave");
});

/*
 * A near-match is not a match: a comment mentioning the path, or a longer
 * pattern containing it, must not be read as the entry already being there.
 */
test("a line merely containing the path is not the entry", () => {
  const existing = "# see .kiro/steering/memory.local.md for notes\n";
  assert.equal(addExcludeEntry(existing, ".kiro/steering/memory.local.md").changed, true);
});
