/**
 * The streaming repaint draws settled blocks once and redraws only the tail.
 *
 * That is only allowed if it cannot change what is shown. These tests run the
 * real `renderMarkdown` and `settledBoundary` out of `media/chat.js` and check,
 * for every prefix of a range of replies, that the settled part plus the tail
 * renders to the same HTML as rendering the whole prefix at once — which is
 * what the panel did before, and what `finishAgentBubble` still does at the end.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const js = fs.readFileSync(path.join(__dirname, "..", "media", "chat.js"), "utf8").replace(/\r\n/g, "\n");

function load() {
  const from = js.indexOf("function escapeHtml");
  const to = js.indexOf("async function copyText");
  const renderMarkdown = new Function(js.slice(from, to) + "\nreturn renderMarkdown;")();
  const start = js.indexOf("  function settledBoundary(");
  const end = js.indexOf("\n  }\n", start) + 4;
  const settledBoundary = new Function(js.slice(start, end) + "\nreturn settledBoundary;")();
  return { renderMarkdown, settledBoundary };
}

const { renderMarkdown, settledBoundary } = load();

/** What `paintStreaming` puts in the bubble, as one HTML string. */
function streamed(chunks) {
  let settled = "";
  let settledText = "";
  let tail = "";
  let text = "";
  for (const chunk of chunks) {
    text += chunk;
    const from = settledText.length;
    const cut = settledBoundary(text, from);
    if (cut > from) {
      settled += renderMarkdown(text.slice(from, cut));
      settledText = text.slice(0, cut);
    }
    tail = renderMarkdown(text.slice(settledText.length));
  }
  return { html: settled + tail, text, settledText };
}

// Whitespace between tags is not something a reader sees.
const norm = (html) => html.replace(/>\s+</g, "><").trim();

const REPLIES = {
  paragraphs:
    "First paragraph with **bold** and `code`.\n\nSecond one, with [a link](https://example.com).\n\n" +
    "## A heading\n\nAnd a closing line.\n",
  code:
    "Here is the change:\n\n```ts\nconst a = 1;\n\nconst b = 2; // blank line inside\n```\n\n" +
    "And another:\n\n~~~\nplain\n~~~\n\nDone.\n",
  looseList:
    "Steps:\n\n1. First\n\n2. Second, after a blank line\n\n   still the second item\n\n3. Third\n\nAfter the list.\n",
  nestedList:
    "- one\n  - nested\n\n  - nested after a blank\n- two\n\nText.\n\n* star list\n* again\n",
  table:
    "Mapping:\n\n| File | Lines |\n|---|---|\n| a.ts | 12 |\n| b.ts | 40 |\n\nFile | Lines\n---|---\nc | 3\n\nEnd.\n",
  quote: "> quoted\n>\n> more quote\n\nNot quoted.\n",
  crlf: "Windows\r\n\r\nline endings\r\n\r\n```js\r\nx()\r\n```\r\n\r\nend\r\n",
  codeInList: "1. Run this:\n\n   ```bash\n   npm test\n   ```\n\n2. Then this.\n\nAfter.\n",
  unclosedFence: "Start\n\n```py\nprint(1)\n\nprint(2)\n",
  listInterrupted: "1. one\n2. two\n\nA paragraph between.\n\n3. three\n4. four\n\nEnd.\n",
  listThenHeading: "- a\n- b\n\n## Next\n\n- c\n\n```\ncode\n```\n\n| t |\n|---|\n| 1 |\n\nAfter table.\n",
  quoteThenText: "> one\n\nplain\n\n> two\n> more\n\nlast\n",
  wrappedLines: "A reply wrapped\nat eighty columns\nby the model.\n\nThen a second\nparagraph.\n",
  newerMarkdown:
    "> **Note** with https://example.com/a_b.\n> > nested\n\n- [ ] todo\n- [x] done\n\n" +
    "~~old~~ and _new_ and __strong__\n\n***\n\n<https://x.dev>\n\nEnd.\n",
  mixed:
    "Intro.\n\n### Plan\n\n- a\n- b\n\n```diff\n- old\n+ new\n```\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n" +
    "> note\n\n---\n\nThe end.\n",
};

for (const [name, reply] of Object.entries(REPLIES)) {
  test(`streaming "${name}" a character at a time matches a full render at every step`, () => {
    const normalised = reply.replace(/\r\n?/g, "\n");
    const chunks = [];
    for (let i = 0; i < normalised.length; i++) {
      chunks.push(normalised[i]);
      const { html, text } = streamed(chunks);
      assert.equal(norm(html), norm(renderMarkdown(text)), `${name}, after ${i + 1} characters`);
    }
  });
}

test("a long reply really does settle, so the tail stays small", () => {
  const reply = Object.values(REPLIES).join("\n\n").replace(/\r\n?/g, "\n").repeat(20);
  const chunks = reply.match(/[\s\S]{1,40}/g);
  const { text, settledText } = streamed(chunks);
  assert.ok(settledText.length > text.length * 0.9, `settled ${settledText.length} of ${text.length}`);
  assert.equal(norm(streamed(chunks).html), norm(renderMarkdown(text)));
});

test("no cut is made inside an open code block", () => {
  const text = "Before.\n\n```\ncode\n\nmore code\n\nstill code\n";
  const cut = settledBoundary(text, 0);
  assert.ok(cut <= text.indexOf("```"), `cut at ${cut}`);
});

test("no cut is made beside a list, which carries on across blank lines", () => {
  const text = "1. one\n\n2. two\n\n3. three\n";
  assert.equal(settledBoundary(text, 0), 0);
});

test("the bubble is finished by one whole render, whatever was streamed", () => {
  const finish = js.slice(js.indexOf("function finishAgentBubble()"), js.indexOf("recordAgent(", js.indexOf("function finishAgentBubble()")));
  assert.match(finish, /current\.body\.innerHTML = renderMarkdown\(buffer\)/);
  const repaint = js.slice(js.indexOf("function scheduleRepaint("), js.indexOf("A streaming reply is drawn"));
  assert.match(repaint, /paintStreaming\(current, buffer\)/);
  assert.doesNotMatch(repaint, /innerHTML = renderMarkdown\(buffer\)/);
});
