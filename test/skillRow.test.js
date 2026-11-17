/*
 * A skill row, run rather than read.
 *
 * Two shapes, and which one you get is decided by whether there is a file.
 * One with a file opens it and offers a × that removes it; a bundled skill
 * is announced with a `builtin:` URI, so there is nothing to open and
 * nothing to remove, and a row that looked clickable and did nothing would
 * be the `.help-line` mistake again.
 *
 * `test/webview.test.js` asserts the shape of this code; these assert what
 * it does, against a DOM small enough to hold in your head.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const js = fs.readFileSync(path.join(root, "media", "chat.js"), "utf8");

/** Only what `skillRow` actually touches. */
function fakeDom() {
  class Node {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.dataset = {};
      this.textContent = "";
      this.className = "";
      this.attributes = {};
    }
    appendChild(child) {
      this.children.push(child);
      return child;
    }
    append(...nodes) {
      for (const node of nodes) this.children.push(node);
    }
    setAttribute(name, value) {
      this.attributes[name] = value;
    }
    /** Class selectors only — that is all this code uses. */
    querySelector(selector) {
      const wanted = selector.replace(/^\./, "");
      for (const child of this.children) {
        if (String(child.className).split(/\s+/).includes(wanted)) return child;
        const deeper = child.querySelector(selector);
        if (deeper) return deeper;
      }
      return undefined;
    }
  }
  return { Node, document: { createElement: (tag) => new Node(tag) } };
}

/**
 * `skillRow` and the parts helper it shares, lifted out and run.
 *
 * Found by name and ended by matching braces, never by slicing a fixed
 * number of characters: nine tests in this repo once did that and every one
 * failed the day a comment was added above the line it wanted.
 */
function loadSkillRow() {
  const source = ["  function skillRow(skill) {", "  function skillRowParts(skill) {"]
    .map((marker) => {
      const from = js.indexOf(marker);
      assert.ok(from > -1, `${marker.trim()} should be findable`);
      let depth = 0;
      for (let i = js.indexOf("{", from); i < js.length; i++) {
        if (js[i] === "{") depth++;
        else if (js[i] === "}") {
          depth--;
          if (depth === 0) return js.slice(from, i + 1);
        }
      }
      throw new Error(`${marker.trim()} should end`);
    })
    .join("\n");
  const dom = fakeDom();
  const make = new Function("document", `${source}\nreturn skillRow;`);
  return { skillRow: make(dom.document), dom };
}

const PATH = String.raw`C:\p\.kiro\skills\greet\SKILL.md`;

test("a skill with a file opens it and offers a way out", () => {
  const { skillRow } = loadSkillRow();
  const row = skillRow({
    name: "greet",
    description: "Use when the user asks to be greeted in the house style.",
    scope: "workspace",
    path: PATH,
  });

  // Two buttons, so the row itself is a div — a button cannot nest inside
  // one. Built like a memory file's row, which solved this already.
  assert.equal(row.tag, "div");
  assert.equal(row.className, "memory-row");

  const open = row.querySelector(".memory-open");
  assert.equal(open.tag, "button");
  assert.equal(open.type, "button");
  assert.equal(open.dataset.openPath, PATH, "the click handler opens what this says");
  assert.equal(open.title, PATH, "and the path is on hover");
  assert.equal(open.querySelector(".mode-name").textContent, "greet");
  assert.equal(
    open.querySelector(".mode-desc").textContent,
    "Use when the user asks to be greeted in the house style.",
    "what it is for is the line under the name, not a tooltip"
  );
  assert.equal(
    open.querySelector(".mode-tag"),
    undefined,
    "a skill from this project needs no label saying so"
  );

  const remove = row.querySelector(".memory-delete");
  assert.equal(remove.tag, "button");
  assert.equal(remove.dataset.removeSkill, PATH, "the extension is told which skill");
  assert.equal(remove.textContent, "×");
  assert.match(remove.attributes["aria-label"], /Remove the greet skill/);
});

/*
 * The whole reason the row is built by hand rather than with `menuRow`: that
 * returns a button, and a button that opens nothing must not be one.
 */
test("a skill with no file is a plain div with no hover tint", () => {
  const { skillRow } = loadSkillRow();
  const row = skillRow({ name: "bundled", description: "Ships with Kiro." });

  assert.equal(row.tag, "div");
  assert.equal(String(row.className), "skill-line", "no .skill-row, so no hover");
  assert.equal(row.querySelector(".memory-delete"), undefined, "and nothing to remove");
  assert.equal(row.querySelector(".mode-name").textContent, "bundled");
});

test("a skill from outside this project says so", () => {
  const { skillRow } = loadSkillRow();
  const row = skillRow({ name: "global-one", scope: "global", path: PATH });
  assert.equal(row.querySelector(".mode-tag").textContent, "all projects");
});

test("a skill with no description is a row, not a row with a blank line", () => {
  const { skillRow } = loadSkillRow();
  const row = skillRow({ name: "terse", path: PATH });
  assert.equal(row.querySelector(".mode-desc"), undefined);
  assert.equal(row.querySelector(".memory-open").children.length, 1);
});
