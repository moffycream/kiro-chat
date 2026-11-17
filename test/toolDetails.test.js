// What a step was given and what it gave back.
//
// test/fixtures/kiro-tool-call.json is a real step captured by driving
// `kiro-cli acp --agent-engine v3` (3.1.0) through a turn that read a file —
// all three notifications about the one step, in order. The shape it proves:
// the input is on every one of them, `rawOutput` only on the terminal one.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { MAX_DETAIL_CHARS, formatToolValue } = require("../out/toolDetails");

const captured = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "kiro-tool-call.json"), "utf8")
);

test("the captured step carries its input from the first notification", () => {
  const [first] = captured;
  assert.equal(first.sessionUpdate, "tool_call");
  const input = formatToolValue(first.rawInput);
  // The empty arguments are pruned: two thirds of what a read sends is the
  // options it did not use, and a block of nulls is noise in a sidebar.
  assert.equal(input.text, '{\n  "path": "hello.txt"\n}');
  assert.equal(input.clipped, undefined);
  assert.equal(formatToolValue(first.rawOutput), undefined, "no output yet");
});

test("the output arrives only on the terminal notification", () => {
  const withOutput = captured.filter((u) => u.rawOutput !== undefined);
  assert.equal(withOutput.length, 1, "exactly one of the three");
  assert.equal(withOutput[0].sessionUpdate, "tool_call_update");
  const output = formatToolValue(withOutput[0].rawOutput);
  assert.match(output.text, /interrupted before it reported a result/);
});

/*
 * Nothing worth a block is nothing, not an empty one. A disclosure that
 * opens onto `{}` is worse than a row with no disclosure at all.
 */
test("an empty value earns no block", () => {
  for (const value of [undefined, null, "", "   ", {}, { a: null }, "{}"]) {
    assert.equal(formatToolValue(value), undefined, JSON.stringify(value));
  }
});

test("a string is shown as itself and an object as JSON", () => {
  assert.equal(formatToolValue("alpha beta\n").text, "alpha beta");
  assert.equal(formatToolValue({ b: 2, a: 1 }).text, '{\n  "b": 2,\n  "a": 1\n}');
  assert.equal(formatToolValue(7).text, "7");
  assert.equal(formatToolValue(false).text, "false");
  // An array is the tool's own structure and is not pruned.
  assert.equal(formatToolValue(["a", null]).text, '[\n  "a",\n  null\n]');
});

/*
 * Kiro's note on *why* it is running a step already has its own line on the
 * row, so repeating it inside the input block says it twice.
 */
test("the purpose note is not shown twice", () => {
  const value = formatToolValue({ path: "a.txt", __tool_use_purpose: "Check the header" });
  assert.equal(value.text, '{\n  "path": "a.txt"\n}');
  // And a payload that was nothing but the note earns no block.
  assert.equal(formatToolValue({ __tool_use_purpose: "Check the header" }), undefined);
});

/*
 * A step can read a whole file, and the cap is applied before the value is
 * posted to the webview, because the cost is the copy.
 */
test("a huge value is clipped, and says so", () => {
  const big = "x".repeat(MAX_DETAIL_CHARS + 500);
  const value = formatToolValue(big);
  assert.equal(value.text.length, MAX_DETAIL_CHARS);
  assert.equal(value.clipped, true);
  // The cap is adjustable, which is what lets a test say this in one line.
  assert.deepEqual(formatToolValue("abcdef", 3), { text: "abc", clipped: true });
});

test("an unprintable payload is nothing, not a thrown handler", () => {
  const loop = { name: "loop" };
  loop.self = loop;
  assert.equal(formatToolValue(loop), undefined);
});

test("windows line endings are normalised, so the block has no blank lines", () => {
  assert.equal(formatToolValue("a\r\nb\r\n").text, "a\nb");
});
