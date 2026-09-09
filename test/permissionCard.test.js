/*
 * The collapse, run rather than read.
 *
 * An answered permission card used to keep every option on screen as a
 * disabled button with the choice named underneath — three or four rows to
 * record one word, in a panel three inches wide, and a single turn can ask
 * several times. Nothing there is clickable once the request is answered, so
 * nothing there earns the space.
 *
 * `test/webview.test.js` asserts the shape of this code; these assert what it
 * does, against a DOM small enough to hold in your head. Prefer this whenever
 * the thing under test is a behaviour.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const js = fs.readFileSync(path.join(root, "media", "chat.js"), "utf8");

/** Only what `settlePermissionCard` and `optionsOf` actually touch. */
function fakeDom() {
  class Node {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.parent = undefined;
      this.dataset = {};
      this.textContent = "";
      this._class = "";
      this.classList = {
        add: (name) => {
          if (!this._class.split(/\s+/).includes(name)) {
            this._class = `${this._class} ${name}`.trim();
          }
        },
        contains: (name) => this._class.split(/\s+/).includes(name),
      };
    }
    get className() {
      return this._class;
    }
    set className(value) {
      this._class = String(value);
    }
    appendChild(child) {
      child.parent = this;
      this.children.push(child);
      return child;
    }
    prepend(child) {
      child.parent = this;
      this.children.unshift(child);
      return child;
    }
    remove() {
      if (!this.parent) return;
      this.parent.children = this.parent.children.filter((node) => node !== this);
      this.parent = undefined;
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
 * `optionsOf` and `settlePermissionCard`, lifted out of chat.js and run.
 *
 * Sliced to the next function rather than by a character count: nine tests in
 * this repo once sliced fixed lengths and every one of them failed the day a
 * comment was added above the line it wanted.
 */
function loadCollapse() {
  const from = js.indexOf("  /** The options a permission card was drawn from");
  assert.ok(from > -1, "optionsOf should be findable");
  const to = js.indexOf("\n  // ---", from);
  assert.ok(to > from, "and the block it lives in should end");
  const settleFrom = js.indexOf("  function settlePermissionCard(card, outcome) {");
  assert.ok(settleFrom > -1, "settlePermissionCard should be findable");
  const settleTo = js.indexOf("\n  /** A card by request id", settleFrom);
  assert.ok(settleTo > settleFrom, "and it should end");

  const source = js.slice(from, to) + js.slice(settleFrom, settleTo);
  const dom = fakeDom();
  const make = new Function(
    "document",
    `${source}\nreturn { optionsOf, settlePermissionCard };`
  );
  return { ...make(dom.document), dom };
}

const OPTIONS = [
  { id: "allow-once", label: "Allow", kind: "allow_once" },
  { id: "allow-always", label: "Always", kind: "allow_always" },
  { id: "reject", label: "No", kind: "reject_once" },
];

/** A live card, as `addPermissionCard` builds one. */
function liveCard(dom) {
  const card = new dom.Node("section");
  card.className = "permission-card";
  card.dataset.title = "read greet.js";
  card.dataset.options = JSON.stringify(OPTIONS);

  const title = card.appendChild(new dom.Node("div"));
  title.className = "permission-title";
  title.textContent = "Kiro wants to read greet.js.";

  const waiting = card.appendChild(new dom.Node("div"));
  waiting.className = "permission-waiting";
  waiting.textContent = "1 more question after this one.";

  const actions = card.appendChild(new dom.Node("div"));
  actions.className = "permission-actions";
  for (const option of OPTIONS) {
    const button = actions.appendChild(new dom.Node("button"));
    button.className = "permission-option";
    button.dataset.optionId = option.id;
  }

  const status = card.appendChild(new dom.Node("div"));
  status.className = "permission-status";
  status.textContent = "Sending…";
  return card;
}

test("answering leaves the question and the choice, and nothing else", () => {
  const { settlePermissionCard, dom } = loadCollapse();
  const card = liveCard(dom);

  settlePermissionCard(card, { ok: true, optionId: "allow-always" });

  assert.equal(card.querySelector(".permission-actions"), undefined, "the buttons are gone");
  assert.equal(card.querySelector(".permission-waiting"), undefined, "so is the queue note");
  assert.equal(card.querySelector(".permission-status"), undefined, "and the status line");
  assert.ok(card.classList.contains("permission-done"));

  const outcome = card.querySelector(".permission-outcome");
  assert.equal(outcome.textContent, "Always", "the choice is what is left");
  assert.equal(outcome.dataset.kind, "allow_always", "styled by what kind of answer it was");
  assert.equal(card.children[0], outcome, "and it leads the line");
  assert.equal(
    card.querySelector(".permission-title").textContent,
    "Kiro wanted to read greet.js.",
    "past tense, because it is"
  );
  assert.equal(card.dataset.chosenId, "allow-always", "the record has something to keep");
});

test("a refusal is marked as one, so it can be spotted in the transcript", () => {
  const { settlePermissionCard, dom } = loadCollapse();
  const card = liveCard(dom);
  settlePermissionCard(card, { ok: true, optionId: "reject" });
  assert.equal(card.querySelector(".permission-outcome").dataset.kind, "reject_once");
  assert.equal(card.querySelector(".permission-outcome").textContent, "No");
});

/*
 * The request had already gone — the turn ended, was stopped, or errored — so
 * the click reached nobody. This is the one thing an answered card still has
 * to say out loud, and it keeps the status line to say it in.
 */
test("a request that reached nobody says so instead of naming a choice", () => {
  const { settlePermissionCard, dom } = loadCollapse();
  const card = liveCard(dom);

  settlePermissionCard(card, { ok: false, optionId: "allow-once" });

  assert.equal(card.querySelector(".permission-outcome"), undefined, "no choice is claimed");
  assert.ok(card.classList.contains("permission-stale"));
  assert.match(card.querySelector(".permission-status").textContent, /no longer waiting/);
  assert.equal(card.dataset.chosenId, undefined, "and nothing is written to the record");
});

/*
 * An answer nobody can name is still an answer. Falling through to the stale
 * branch would report the opposite of what happened.
 */
test("an answer with an option id nobody recognises is still an answer", () => {
  const { settlePermissionCard, dom } = loadCollapse();
  const card = liveCard(dom);
  settlePermissionCard(card, { ok: true, optionId: "something-else" });
  assert.equal(card.querySelector(".permission-outcome").textContent, "Answered");
  assert.equal(card.classList.contains("permission-stale"), false);
});

/*
 * The restore path: `addPermissionCard` settles the card before it has built
 * any buttons or a status line, so everything this touches may be absent.
 */
test("a card restored from history collapses with nothing to remove", () => {
  const { settlePermissionCard, dom } = loadCollapse();
  const card = new dom.Node("section");
  card.className = "permission-card";
  card.dataset.title = "read greet.js";
  card.dataset.options = JSON.stringify(OPTIONS);
  const title = card.appendChild(new dom.Node("div"));
  title.className = "permission-title";

  settlePermissionCard(card, { ok: true, optionId: "allow-once" });
  assert.equal(card.querySelector(".permission-outcome").textContent, "Allow");

  const stale = new dom.Node("section");
  stale.dataset.title = "read greet.js";
  stale.dataset.options = JSON.stringify(OPTIONS);
  settlePermissionCard(stale, { ok: false });
  assert.match(stale.querySelector(".permission-status").textContent, /no longer waiting/);
});

test("a card with no options recorded does not throw", () => {
  const { optionsOf, settlePermissionCard, dom } = loadCollapse();
  const card = new dom.Node("section");
  card.dataset.title = "run a tool";
  assert.deepEqual(optionsOf(card), [], "a missing list is an empty one");
  card.dataset.options = "not json";
  assert.deepEqual(optionsOf(card), [], "and so is a broken one");
  settlePermissionCard(card, { ok: true, optionId: "allow-once" });
  assert.equal(card.querySelector(".permission-outcome").textContent, "Answered");
});
