// Standing instructions: how you always want Kiro to work.
//
// Unlike a memory file, which Kiro opens when it wants it, this text rides in
// every message — so its length is paid for on every turn. That is what the
// cap and the summary line are for, and what most of these check.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_INSTRUCTIONS_CHARS,
  applyInstructions,
  clipInstructions,
  instructionsRow,
  normaliseInstructions,
} = require("../out/instructions");

test("the words are left exactly as written", () => {
  const text = "Always reply in Bahasa Malaysia.\nUse tabs, never spaces.";
  assert.equal(normaliseInstructions(text), text);
});

/*
 * Trailing spaces and runs of blank lines are noise that costs tokens on every
 * turn. They are the only thing removed.
 */
test("trailing whitespace and blank runs are trimmed away", () => {
  assert.equal(normaliseInstructions("one   \n\n\n\ntwo  "), "one\n\ntwo");
  assert.equal(normaliseInstructions("\n\n  padded  \n\n"), "padded");
});

test("line endings are normalised, because \\r is not free either", () => {
  assert.equal(normaliseInstructions("one\r\ntwo\rthree"), "one\ntwo\nthree");
});

test("nothing at all is nothing, not the string 'undefined'", () => {
  assert.equal(normaliseInstructions(undefined), "");
  assert.equal(normaliseInstructions(null), "");
});

/*
 * An empty instruction must add no block. A block saying nothing is a line of
 * prompt charged for on every turn for the rest of the conversation.
 */
test("empty instructions add no block", () => {
  const blocks = [{ type: "text", text: "hello" }];
  assert.equal(applyInstructions(blocks, "").length, 1);
  assert.equal(applyInstructions(blocks, "   \n\n  ").length, 1);
  assert.equal(applyInstructions(blocks, undefined).length, 1);
  assert.deepEqual(applyInstructions(blocks, ""), blocks);
});

test("instructions go in front, carrying what the user wrote", () => {
  const blocks = [{ type: "text", text: "fix the bug" }];
  const out = applyInstructions(blocks, "Use tabs.");
  assert.equal(out.length, 2);
  assert.match(out[0].text, /Use tabs\./);
  assert.equal(out[1].text, "fix the bug", "the message itself is untouched");
});

/*
 * Outside the workflow block, not between it and the request. That block ends
 * "The user's request follows", and anything slipped in after it makes the
 * sentence untrue.
 */
test("instructions sit outside the workflow block, never between it and the request", () => {
  const withMode = [
    { type: "text", text: "[Kiro Chat mode: Spec]\n...\n\nThe user's request follows." },
    { type: "text", text: "build the thing" },
  ];
  const out = applyInstructions(withMode, "Use tabs.");
  assert.equal(out.length, 3);
  assert.match(out[0].text, /standing instructions/);
  assert.match(out[1].text, /The user's request follows\.$/);
  assert.equal(out[2].text, "build the thing");
});

/*
 * The cap exists because this text is paid for on every turn, unlike a memory
 * file that Kiro reads when it wants it.
 */
test("over-long instructions are cut, and report that they were", () => {
  const long = "x".repeat(MAX_INSTRUCTIONS_CHARS + 500);
  const clipped = clipInstructions(long);
  assert.equal(clipped.truncated, true);
  assert.ok(clipped.text.length <= MAX_INSTRUCTIONS_CHARS);
});

test("instructions within the cap are not reported as cut", () => {
  const clipped = clipInstructions("short and sweet");
  assert.equal(clipped.truncated, false);
  assert.equal(clipped.text, "short and sweet");
});

test("the block never exceeds the cap either", () => {
  const out = applyInstructions([], "y".repeat(MAX_INSTRUCTIONS_CHARS * 2));
  assert.ok(out[0].text.length < MAX_INSTRUCTIONS_CHARS + 300, "wrapper aside, it is clipped");
});

/*
 * The row shows the instructions, not a label repeating the heading above it.
 * "Your instructions" under a group already called Instructions costs the
 * row's most readable line to say nothing.
 */
test("the first instruction is the row's label", () => {
  const row = instructionsRow("Use tabs.\nReply in Malay.");
  assert.equal(row.label, "Use tabs.");
  assert.equal(row.detail, "Reply in Malay.");
});

test("a single instruction leaves the second line empty", () => {
  const row = instructionsRow("Use tabs.");
  assert.equal(row.label, "Use tabs.");
  assert.equal(row.detail, "");
});

/*
 * With nothing set the row is an invitation rather than a statement — the way
 * the "Add project memory" rows are. A row reading "None yet" is a fact where
 * a control belongs.
 */
test("an empty setting makes the row an invitation", () => {
  assert.equal(instructionsRow("").label, "Add instructions");
  assert.equal(instructionsRow(undefined).label, "Add instructions");
  assert.equal(instructionsRow("   \n\n ").label, "Add instructions");
  assert.equal(instructionsRow("").detail, "");
});

test("the rest are joined so several still look like several", () => {
  const row = instructionsRow("One.\nTwo.\nThree.");
  assert.equal(row.label, "One.");
  assert.equal(row.detail, "Two. · Three.");
});

/*
 * Clipped between instructions where one fits: a preview that stops
 * mid-sentence is a preview of something the user did not write.
 */
test("the second line breaks between instructions, not inside one", () => {
  const row = instructionsRow("One.\nTwo.\nA much longer third instruction here.", 12);
  assert.equal(row.detail, "Two. …", "the third is dropped whole, and the cut is marked");
});

test("a single instruction longer than the row still shows something", () => {
  const row = instructionsRow("x".repeat(200), 20);
  assert.ok(row.label.length <= 20, "it has to fit");
  assert.match(row.label, /…$/, "and say it was cut");
});

test("a row that fits is not marked as cut", () => {
  const row = instructionsRow("Short one.\nAnd two.");
  assert.doesNotMatch(row.label, /…/);
  assert.doesNotMatch(row.detail, /…/);
});

test("blank lines are not shown as instructions", () => {
  const row = instructionsRow("one\n\n\ntwo");
  assert.equal(row.label, "one");
  assert.equal(row.detail, "two");
});
