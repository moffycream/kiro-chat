/*
 * What a turn cost, run rather than read.
 *
 * Kiro reports the figure; the risk is entirely in which turn it lands on.
 * It can arrive either side of the bubble being finished and stored, and the
 * wrong branch puts this turn's cost onto the previous one — visible only as
 * a figure that is slightly wrong, in a panel with nothing to check it
 * against.
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

/** Only what `turnCostLine` and `noteTurnCredits` actually touch. */
function fakeDom() {
  class Node {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.parent = undefined;
      this._text = "";
      this.attrs = {};
      this.title = "";
      // A node still in the page. `remove()` takes it away, and the real
      // property is what `noteTurnCredits` refuses a stale bubble on.
      this.isConnected = true;
      this._class = "";
      this.classList = {
        contains: (name) => this._class.split(/\s+/).includes(name),
      };
    }
    /*
     * A real node reports its descendants' text, and the cost line is a
     * model span, a separator and a figure span. Storing it as a plain
     * field made every assertion on the line read empty.
     */
    get textContent() {
      if (this.children.length === 0) return this._text;
      return this.children.map((child) => child.textContent).join("");
    }
    set textContent(value) {
      this._text = String(value);
    }
    setAttribute(name, value) {
      this.attrs[name] = String(value);
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
    remove() {
      this.isConnected = false;
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
 * `credits`, `turnCostLine` and `noteTurnCredits`, lifted out of chat.js.
 *
 * The real formatter goes in rather than a stub, because "0.42 credits" and
 * "1 credit" are part of what is under test. `current` and `lastAgent` are
 * declared in the wrapper and reached through setters, since the functions
 * read them as the module-level bindings they are.
 *
 * Sliced to the next function rather than by a character count: nine tests in
 * this repo once sliced fixed lengths, and every one of them failed the day a
 * comment was added above the line it wanted.
 */
function loadCost() {
  const creditsFrom = js.indexOf("  function credits(value) {");
  assert.ok(creditsFrom > -1, "credits should be findable");
  const creditsTo = js.indexOf("\n  function contextState()", creditsFrom);
  assert.ok(creditsTo > creditsFrom, "and it should end");

  const costFrom = js.indexOf("  function turnCostLine(value, model) {");
  assert.ok(costFrom > -1, "turnCostLine should be findable");
  const costTo = js.indexOf("\n  // ---", costFrom);
  assert.ok(costTo > costFrom, "and the block it lives in should end");

  const source = js.slice(creditsFrom, creditsTo) + js.slice(costFrom, costTo);
  const dom = fakeDom();
  const history = [];
  let saves = 0;
  const body = [
    "let current = null;",
    "let lastAgent = null;",
    source,
    "return {",
    "  turnCostLine,",
    "  noteTurnCredits,",
    "  setCurrent: (value) => { current = value; },",
    "  setLast: (value) => { lastAgent = value; },",
    "};",
  ].join("\n");
  const make = new Function(
    "document",
    "history",
    "saveState",
    "atBottom",
    "scroll",
    body
  );
  const api = make(
    dom.document,
    history,
    () => {
      saves += 1;
    },
    () => true,
    () => {}
  );
  return { ...api, dom, history, saves: () => saves };
}

/** A bubble, as `ensureAgentBubble` builds one, with only what is read. */
function bubble(dom) {
  const node = new dom.Node("div");
  node.className = "msg agent";
  return { root: node };
}

function costOf(node) {
  const line = node.querySelector(".turn-cost");
  return line ? line.textContent : undefined;
}

test("the cost is written under the reply, formatted as the strip formats it", () => {
  const { turnCostLine } = loadCost();
  assert.equal(turnCostLine(0.4242).textContent, "0.42 credits");
  assert.equal(turnCostLine(3).textContent, "3 credits");
  // The one case where the plural is wrong, and the only one worth spelling.
  assert.equal(turnCostLine(1).textContent, "1 credit");
  assert.match(turnCostLine(2).title, /this turn cost/);
});

/*
 * A real turn costs around 0.04, so the two decimals the strip rounds to
 * are close enough to the floor that a cheap one would render "0 credits" —
 * the dishonest zero this feature refuses everywhere else, arriving through
 * the formatter rather than the parser.
 */
test("a turn too cheap to round to two decimals is not shown as free", () => {
  const { turnCostLine } = loadCost();
  assert.equal(turnCostLine(0.004).textContent, "<0.01 credits");
  assert.equal(turnCostLine(0.0001).textContent, "<0.01 credits");
  assert.equal(turnCostLine(0.01).textContent, "0.01 credits", "the floor is exclusive");
});

/*
 * The ordinary order: the cost is posted just before `turnEnd`, so the bubble
 * is still live and has not been written to the record yet. It rides along on
 * the `recordAgent` that is about to happen.
 */
test("a cost arriving before the turn is stored rides along with it", () => {
  const cost = loadCost();
  const live = bubble(cost.dom);
  cost.setCurrent(live);

  cost.noteTurnCredits(1.5);

  assert.equal(costOf(live.root), "1.5 credits");
  assert.equal(live.credits, 1.5, "the bubble carries it to recordAgent");
  assert.equal(cost.history.length, 0, "and nothing is written twice");
});

/*
 * The other order, which a `turn_end` notification can produce: the bubble is
 * finished and already in the record. Writing the turn again would store it
 * twice, so the entry that is there is patched instead.
 */
test("a cost arriving after the turn is stitched into the stored one", () => {
  const cost = loadCost();
  const done = bubble(cost.dom);
  done.recorded = true;
  cost.setCurrent(null);
  cost.setLast(done);
  cost.history.push({ role: "user", text: "hello" });
  cost.history.push({ role: "agent", text: "hi" });

  cost.noteTurnCredits(2.25);

  assert.equal(costOf(done.root), "2.25 credits");
  assert.equal(cost.history.length, 2, "the turn is not stored a second time");
  assert.equal(cost.history[1].credits, 2.25);
  assert.equal(cost.history[0].credits, undefined, "and the turn before is untouched");
  assert.equal(cost.saves(), 1, "a patched record still has to be saved");
});

/*
 * `isConnected` is the entire guard on a stale bubble. Eight places empty the
 * transcript — a new chat, opening an old one, the setup screen — and none of
 * them clears `lastAgent`, because a removed node already answers this.
 */
test("a bubble the transcript no longer holds takes no cost", () => {
  const cost = loadCost();
  const gone = bubble(cost.dom);
  gone.recorded = true;
  gone.root.isConnected = false;
  cost.setLast(gone);
  cost.history.push({ role: "agent", text: "from the chat before" });

  cost.noteTurnCredits(9);

  assert.equal(costOf(gone.root), undefined, "nothing is drawn into it");
  assert.equal(
    cost.history[0].credits,
    undefined,
    "and another chat's turn is not given this one's cost"
  );
});

/* A second reading replaces the first rather than stacking under it. */
test("a cost reported twice shows once", () => {
  const cost = loadCost();
  const live = bubble(cost.dom);
  cost.setCurrent(live);

  cost.noteTurnCredits(1);
  cost.noteTurnCredits(4);

  assert.equal(live.root.children.length, 1);
  assert.equal(costOf(live.root), "4 credits");
});

/*
 * `creditsSpent` refuses anything it cannot stand behind and the session only
 * emits what survives that, so this end never sees a bad number. It refuses one
 * anyway: a figure nobody can check is the one thing worse than no figure, and
 * being sure of it here costs two lines.
 */
test("a figure that is not one is never drawn", () => {
  for (const value of [undefined, null, NaN, Infinity, "2", {}]) {
    const cost = loadCost();
    const live = bubble(cost.dom);
    cost.setCurrent(live);
    cost.noteTurnCredits(value);
    assert.equal(costOf(live.root), undefined, `${String(value)} should draw nothing`);
  }
});
