// What Kiro says it can reach for.
//
// The payload in test/fixtures/kiro-progressive-context.json was captured by
// driving `kiro-cli acp --agent-engine v3` (3.1.0) in a throwaway workspace
// holding one `.kiro/skills/greet/SKILL.md`, not read from docs. Kiro sent it
// unprompted, before `session/new` had even answered — see CLAUDE.md on why
// nothing clears the list afterwards.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const {
  readProgressiveContext,
  fsPathFromFileUri,
} = require("../out/progressiveContext");

const captured = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "kiro-progressive-context.json"), "utf8")
);

test("the captured notification yields the skill Kiro found", () => {
  const skills = readProgressiveContext(captured);
  assert.deepStrictEqual(skills, [
    {
      name: "greet",
      description: "Use when the user asks to be greeted in the house style.",
      scope: "workspace",
      path: String.raw`C:\Users\USER\scratch\ws\.kiro\skills\greet\SKILL.md`,
    },
  ]);
});

/*
 * The difference the panel depends on: nothing to report is not the same
 * answer as a report that could not be read. One empties the menu, the other
 * leaves the last list that could be read in place.
 */
test("an unreadable report is undefined, and an empty one is empty", () => {
  assert.strictEqual(readProgressiveContext(undefined), undefined);
  assert.strictEqual(readProgressiveContext({}), undefined);
  assert.strictEqual(readProgressiveContext({ items: null }), undefined);
  assert.strictEqual(readProgressiveContext({ items: "greet" }), undefined);
  assert.deepStrictEqual(readProgressiveContext({ items: [] }), []);
});

/*
 * `items` is about progressive context, not skills alone, and `type` is how
 * each item says which kind it is. Anything else must not be drawn as a
 * skill: a row the panel has mislabelled is worse than a row that is absent.
 */
test("only the items that say they are skills are kept", () => {
  const skills = readProgressiveContext({
    items: [
      { name: "greet", type: "skill" },
      { name: "architecture-selection", type: "steering" },
      { name: "nameless-kind" },
      { name: "by-meta", _meta: { kiro: { resource: { resourceType: "skill" } } } },
    ],
  });
  assert.deepStrictEqual(
    skills.map((s) => s.name),
    ["greet", "by-meta"]
  );
});

test("an item with no usable name is dropped, not drawn blank", () => {
  const skills = readProgressiveContext({
    items: [
      { name: "   ", type: "skill" },
      { name: 7, type: "skill" },
      { type: "skill" },
      null,
      "greet",
      { name: " padded ", type: "skill" },
    ],
  });
  assert.deepStrictEqual(skills, [{ name: "padded" }]);
});

/*
 * Empty strings are left off rather than carried as empty fields, so the row
 * has one test for "is there a description" instead of two.
 */
test("the optional halves are omitted when there is nothing in them", () => {
  const [skill] = readProgressiveContext({
    items: [{ name: "greet", type: "skill", description: "  ", scope: "", uri: 12 }],
  });
  assert.deepStrictEqual(skill, { name: "greet" });
});

/*
 * A bundled item is announced with a `builtin:` URI — the steering documents
 * in the same handshake were — so there is not always a file to open, and the
 * row has to know that about itself rather than finding out on the click.
 */
test("only a file:// URI becomes a path", () => {
  assert.strictEqual(
    fsPathFromFileUri("file:///C:/p/.kiro/skills/a/SKILL.md"),
    String.raw`C:\p\.kiro\skills\a\SKILL.md`
  );
  assert.strictEqual(fsPathFromFileUri("builtin:architecture-selection"), undefined);
  assert.strictEqual(fsPathFromFileUri("https://example.com/SKILL.md"), undefined);
  assert.strictEqual(fsPathFromFileUri(""), undefined);
  assert.strictEqual(fsPathFromFileUri(undefined), undefined);
  assert.strictEqual(fsPathFromFileUri({ path: "C:/p" }), undefined);
});

test("an escaped path is unescaped, and an unparseable one is refused", () => {
  assert.strictEqual(
    fsPathFromFileUri("file:///C:/my%20project/.kiro/skills/a/SKILL.md"),
    String.raw`C:\my project\.kiro\skills\a\SKILL.md`
  );
  // A stray percent is not an escape, and half-decoding it would hand the
  // menu a path that opens nothing with nothing saying why.
  assert.strictEqual(fsPathFromFileUri("file:///C:/100%/SKILL.md"), undefined);
});
