/*
 * The one-line summary of Kiro's reasoning, run rather than read.
 *
 * A minute of thinking arrives as one unbroken block, and in a panel three
 * inches wide it buried the tool rows under it and pushed the answer itself
 * off the screen. One line and a button is the answer; what makes it fiddly
 * is that the block lives inside a folded list, so the question "is this
 * longer than the line?" has to be re-asked rather than answered once.
 *
 * `test/webview.test.js` asserts the shape of this code; these assert what it
 * does, against a DOM small enough to hold in your head — the pattern
 * `test/permissionCard.test.js` set.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const js = fs.readFileSync(path.join(root, "media", "chat.js"), "utf8");

/** Only what `thoughtBlock` and `syncThought` actually touch. */
function fakeDom() {
  class Node {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.parent = undefined;
      this.dataset = {};
      this.attrs = {};
      this.textContent = "";
      this.hidden = false;
      this.listeners = {};
      // A real box reports both; the tests set them to describe a case.
      this.scrollWidth = 0;
      this.clientWidth = 0;
      this._class = "";
      this.classList = {
        add: (name) => {
          if (!this._class.split(/\s+/).includes(name)) {
            this._class = `${this._class} ${name}`.trim();
          }
        },
        remove: (name) => {
          this._class = this._class
            .split(/\s+/)
            .filter((each) => each && each !== name)
            .join(" ");
        },
        contains: (name) => this._class.split(/\s+/).includes(name),
        toggle: (name) => {
          if (this.classList.contains(name)) {
            this.classList.remove(name);
            return false;
          }
          this.classList.add(name);
          return true;
        },
      };
    }
    get className() {
      return this._class;
    }
    set className(value) {
      this._class = String(value);
    }
    append(...nodes) {
      for (const node of nodes) {
        node.parent = this;
        this.children.push(node);
      }
    }
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    }
    getAttribute(name) {
      return this.attrs[name];
    }
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    }
    click() {
      for (const fn of this.listeners.click || []) fn();
    }
    /** Class selectors only — that is all this code uses. */
    querySelector(selector) {
      const wanted = selector.replace(/^\./, "");
      for (const child of this.children) {
        if (child.classList.contains(wanted)) return child;
        const deeper = child.querySelector(selector);
        if (deeper) return deeper;
      }
      return undefined;
    }
  }
  return { Node, document: { createElement: (tag) => new Node(tag) } };
}

/**
 * `thoughtBlock` and `syncThought`, lifted out of chat.js and run.
 *
 * Sliced to the next declaration rather than by a character count: nine tests
 * in this repo once sliced fixed lengths and every one of them failed the day
 * a comment was added above the line it wanted.
 */
function loadThought() {
  const blockFrom = js.indexOf("  function thoughtBlock() {");
  assert.ok(blockFrom > -1, "thoughtBlock should be findable");
  const blockTo = js.indexOf("\n  function syncThought(block) {", blockFrom);
  assert.ok(blockTo > blockFrom, "and it should end before syncThought");
  const syncFrom = js.indexOf("  function syncThought(block) {", blockTo);
  const syncTo = js.indexOf("\n  const thoughtSizes", syncFrom);
  assert.ok(syncTo > syncFrom, "syncThought should end before the observer");

  const source = js.slice(blockFrom, blockTo) + js.slice(syncFrom, syncTo);
  const dom = fakeDom();
  const make = new Function(
    "document",
    "thoughtSizes",
    `${source}\nreturn { thoughtBlock, syncThought };`
  );
  // No observer: the tests drive syncThought directly, which is what the
  // observer does when the panel resizes or the list is unfolded.
  return { ...make(dom.document, null), dom };
}

/**
 * A block whose single line is `text` wide inside a box `box` wide.
 *
 * Width, not height: collapsed, the line does not wrap, so what says there is
 * more of it is how far it runs past the side of its own box.
 */
function measured(built, text, box = 240) {
  built.text.clientWidth = box;
  built.text.scrollWidth = text;
  return built.block;
}

test("reasoning that fits on the line is not offered a button", () => {
  const { thoughtBlock, syncThought } = loadThought();
  const built = thoughtBlock();
  built.text.textContent = "Reading the file first.";

  syncThought(measured(built, 180));

  const toggle = built.block.querySelector(".thought-toggle");
  assert.equal(toggle.hidden, true, "a control that does nothing looks the same as one that does");
});

test("reasoning that runs off the line is offered one", () => {
  const { thoughtBlock, syncThought } = loadThought();
  const built = thoughtBlock();

  syncThought(measured(built, 1900));

  const toggle = built.block.querySelector(".thought-toggle");
  assert.equal(toggle.hidden, false);
  assert.equal(toggle.textContent, "Show more");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
});

test("the button opens the block, and closes it again", () => {
  const { thoughtBlock, syncThought } = loadThought();
  const built = thoughtBlock();
  syncThought(measured(built, 1900));
  const toggle = built.block.querySelector(".thought-toggle");

  toggle.click();
  assert.ok(built.block.classList.contains("thought-open"), "the class is what lets the text wrap");
  assert.equal(toggle.textContent, "Show less");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");

  toggle.click();
  assert.equal(built.block.classList.contains("thought-open"), false);
  assert.equal(toggle.textContent, "Show more");
});

/*
 * An open block wraps and is as wide as its box, so the overflow test answers
 * "it fits" — and hiding the button on that answer would take away the only
 * way to close it again.
 */
test("an open thought keeps its button", () => {
  const { thoughtBlock, syncThought } = loadThought();
  const built = thoughtBlock();
  syncThought(measured(built, 1900));
  built.block.querySelector(".thought-toggle").click();

  syncThought(measured(built, 240));

  assert.equal(built.block.querySelector(".thought-toggle").hidden, false);
});

/*
 * Nothing inside a folded list has a size, so the block measures zero and
 * reports that it fits. Unfolding the list, or the panel changing width, is
 * when the question can actually be answered — hence the re-ask, and hence
 * this: a zero measurement must not be mistaken for a short thought that has
 * settled.
 */
test("a thought measured while folded away claims nothing", () => {
  const { thoughtBlock, syncThought } = loadThought();
  const built = thoughtBlock();
  syncThought(measured(built, 1900));
  assert.equal(built.block.querySelector(".thought-toggle").hidden, false);

  syncThought(measured(built, 0, 0));
  assert.equal(built.block.querySelector(".thought-toggle").hidden, true, "nothing can be said");

  syncThought(measured(built, 1900));
  assert.equal(
    built.block.querySelector(".thought-toggle").hidden,
    false,
    "and the answer comes back the moment there is a box to measure"
  );
});
