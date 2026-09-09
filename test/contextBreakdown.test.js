/*
 * What Kiro says is in its context.
 *
 * `test/fixtures/kiro-context.json` is the real answer to
 * `_kiro.dev/commands/execute` with `{ command: "context", args: {} }`,
 * captured by driving `kiro-cli acp` against this repo — the same way every
 * other protocol fact here was established. Hand-writing the shape would go
 * stale silently, and the panel would show nothing with nothing failing.
 *
 * `{ value: "show" }` was tried too and returns the same numbers, flipping
 * only `initialExpanded`, so the plain call is the one the provider makes.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { readContextCommand } = require(path.join(__dirname, "..", "out", "usage.js"));
const captured = require("./fixtures/kiro-context.json");

test("the captured breakdown is read into categories", () => {
  const breakdown = readContextCommand(captured.data);
  assert.ok(breakdown, "the real payload must parse");

  const labels = breakdown.categories.map((c) => c.label);
  assert.deepEqual(labels, [
    "Context files",
    "Files in this chat",
    "Your messages",
    "Kiro's replies",
    "Tool definitions",
  ], "in the order they are worth reading, not the order Kiro sent them");

  const files = breakdown.categories.find((c) => c.key === "contextFiles");
  assert.equal(files.tokens, 5401);
  assert.ok(
    files.items.some((item) => item.name === "README.md" && item.tokens === 5401),
    "the file Kiro is actually holding is named"
  );
  assert.ok(
    files.items.some((item) => item.name === "AGENTS.md" && item.matched === false),
    "and so is one it looked for and did not find"
  );
});

/*
 * Tools arrive nested a level deeper than everything else — grouped by where
 * they came from — and reading only `items` found none of them.
 */
test("tool groups are flattened into the same shape as everything else", () => {
  const breakdown = readContextCommand(captured.data);
  const tools = breakdown.categories.find((c) => c.key === "tools");
  assert.ok(tools.tokens > 0);
  assert.ok(tools.items.length > 5, "the built-in tools are found through their group");
  assert.ok(tools.items.every((item) => item.name && typeof item.tokens === "number"));
});

test("the total is what the categories add up to", () => {
  const breakdown = readContextCommand(captured.data);
  const sum = breakdown.categories.reduce((total, c) => total + c.tokens, 0);
  assert.equal(breakdown.totalTokens, sum);
  assert.ok(sum > 0);
});

/* The meter reader is strict about percentages, and so is this. */
test("only a percentage that could be one is taken", () => {
  assert.equal(readContextCommand({ ...captured.data, contextUsagePercentage: 6.5 }).percent, 6.5);
  for (const bad of [-1, 101, "lots", null, undefined, NaN]) {
    const breakdown = readContextCommand({ ...captured.data, contextUsagePercentage: bad });
    assert.equal(breakdown.percent, undefined, `${String(bad)} is not a percentage`);
  }
});

test("an answer with no breakdown is not half-read", () => {
  for (const data of [undefined, null, {}, { breakdown: null }, { breakdown: {} }, "text"]) {
    assert.equal(readContextCommand(data), undefined, `${JSON.stringify(data)} yields nothing`);
  }
});

/* A category Kiro stops sending simply is not there, rather than being zero. */
test("only the categories that were sent are reported", () => {
  const breakdown = readContextCommand({
    breakdown: { contextFiles: { tokens: 10, percent: 1, items: [] } },
  });
  assert.deepEqual(breakdown.categories.map((c) => c.key), ["contextFiles"]);
  assert.equal(breakdown.totalTokens, 10);
});

test("an item with no name is dropped rather than drawn blank", () => {
  const breakdown = readContextCommand({
    breakdown: {
      contextFiles: {
        tokens: 5,
        percent: 1,
        items: [{ name: "", tokens: 3 }, { name: "  ", tokens: 1 }, { name: "kept.md", tokens: 1 }],
      },
    },
  });
  assert.deepEqual(
    breakdown.categories[0].items.map((item) => item.name),
    ["kept.md"]
  );
});
