/*
 * The whole path, from what Kiro sends to what is under the bubble.
 *
 * Every piece of this had its own passing test while the feature showed
 * nothing at all, because the one thing none of them touched was the shape
 * Kiro actually sends: `meteringUsage` is an ARRAY, the parser looked for a
 * number or an object with one of five key names, and so every reading was
 * dropped at the door. Unit tests written from the same wrong assumption as
 * the code agree with it perfectly.
 *
 * So this one starts at a captured notification and finishes at the text in
 * the DOM, with the real parser and the real renderer in between. The only
 * thing standing in is the hop between them, which is two lines of `post`.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const js = fs.readFileSync(path.join(root, "media", "chat.js"), "utf8");
const { readMeter } = require("../out/usage");

const METERING = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "kiro-metering.json"), "utf8")
);

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
      this.parent.children = this.parent.children.filter((n) => n !== this);
      this.parent = undefined;
    }
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

/** The webview's half: `credits`, `turnCostLine`, `noteTurnCredits`. */
function loadPanel() {
  const creditsFrom = js.indexOf("  function credits(value) {");
  const creditsTo = js.indexOf("\n  function contextState()", creditsFrom);
  const costFrom = js.indexOf("  function turnCostLine(value, model) {");
  const costTo = js.indexOf("\n  // ---", costFrom);
  assert.ok(creditsFrom > -1 && creditsTo > creditsFrom, "credits should be findable");
  assert.ok(costFrom > -1 && costTo > costFrom, "the cost block should be findable");

  const dom = fakeDom();
  const history = [];
  const make = new Function(
    "document",
    "history",
    "saveState",
    "atBottom",
    "scroll",
    [
      "let current = null;",
      "let lastAgent = null;",
      js.slice(creditsFrom, creditsTo),
      js.slice(costFrom, costTo),
      "return { noteTurnCredits, setCurrent: (v) => { current = v; } };",
    ].join("\n")
  );
  const api = make(dom.document, history, () => {}, () => true, () => {});
  return { ...api, dom, history };
}

/**
 * The extension host's half, reduced to its accounting.
 *
 * `KiroSession` imports `vscode` and cannot be required here — the constraint
 * this whole repo's testing strategy is built around — so this mirrors the
 * three lines of `readUsage` and `emitTurnCredits` that decide the number,
 * over the *real* parser. It is not the real class, and `test/session.test.js`
 * is what holds the real one to this shape.
 */
function fakeSession(onTurnCredits) {
  let completed = 0;
  let currentTurn;
  let turnModel = "";
  return {
    /*
     * The model is captured here, at the start, exactly as `send` does —
     * nothing Kiro sends names the model that answered, so it can only be
     * the one selected when the turn began.
     */
    startTurn(model = "auto") {
      currentTurn = undefined;
      turnModel = model;
    },
    /** A `_kiro.dev/metadata` notification, exactly as captured. */
    notify(params) {
      const reading = readMeter(params);
      if (reading.turnCredits !== undefined) currentTurn = reading.turnCredits;
    },
    endTurn() {
      if (currentTurn === undefined) return;
      completed += currentTurn;
      onTurnCredits(currentTurn, turnModel);
      currentTurn = undefined;
    },
    get sessionCredits() {
      return completed + (currentTurn ?? 0);
    },
  };
}

function bubble(dom) {
  const node = new dom.Node("div");
  node.className = "msg agent";
  return { root: node };
}

const partOf = (node, cls) => {
  const found = node.root.querySelector(cls);
  return found ? found.textContent : undefined;
};
const costOf = (node) => partOf(node, ".turn-credits");
const modelOf = (node) => partOf(node, ".turn-model");

test("a real metering notification ends up as text under the bubble", () => {
  const panel = loadPanel();
  const session = fakeSession((spent, model) => panel.noteTurnCredits(spent, model));

  const live = bubble(panel.dom);
  panel.setCurrent(live);

  session.startTurn();
  // The turn's own notification, byte for byte as kiro-cli 2.20.2 sent it.
  session.notify(METERING.turns[0].params);
  session.endTurn();

  assert.equal(costOf(live), "0.06 credits");
  assert.equal(modelOf(live), "auto");
});

/*
 * The model is the one selected when the turn was sent, and it is stored
 * with the turn. Changing the picker afterwards must not relabel a reply
 * that has already run on something else — which is the whole reason it is
 * captured at `startTurn` rather than read when the line is drawn.
 */
test("each turn keeps the model it actually ran on", () => {
  const panel = loadPanel();
  const drawn = [];
  const session = fakeSession((spent, model) => {
    const live = bubble(panel.dom);
    panel.setCurrent(live);
    panel.noteTurnCredits(spent, model);
    drawn.push(`${modelOf(live)} ${costOf(live)}`);
  });

  for (const [index, model] of ["auto", "claude-sonnet-4.5", "gpt-5.6-luna"].entries()) {
    session.startTurn(model);
    session.notify(METERING.turns[index].params);
    session.endTurn();
  }

  assert.deepEqual(drawn, [
    "auto 0.06 credits",
    "claude-sonnet-4.5 0.05 credits",
    "gpt-5.6-luna 0.04 credits",
  ]);
});

/*
 * Kiro reports no model at all, so an unknown one leaves the figure alone
 * rather than printing an empty name or a guess. `auto` is not unknown — it
 * is what was selected, and Kiro never says which model it chose under it.
 */
test("a turn with no model still shows what it cost", () => {
  const panel = loadPanel();
  const live = bubble(panel.dom);
  panel.setCurrent(live);

  panel.noteTurnCredits(0.0614601119402985, "");

  assert.equal(costOf(live), "0.06 credits");
  assert.equal(modelOf(live), undefined, "no name is drawn when there is none");
});

/*
 * The strip has to count up while the per-turn figures fall. Reading the meter
 * as a running total would have shown 0.06, then 0.05, then 0.04 — a
 * conversation getting cheaper the longer it ran.
 */
test("three real turns each report their own cost, and the chat total climbs", () => {
  const panel = loadPanel();
  const shown = [];
  const session = fakeSession((spent, model) => {
    const live = bubble(panel.dom);
    panel.setCurrent(live);
    panel.noteTurnCredits(spent, model);
    shown.push(costOf(live));
  });

  const totals = [];
  for (const turn of METERING.turns) {
    session.startTurn();
    session.notify(turn.params);
    session.endTurn();
    totals.push(Number(session.sessionCredits.toFixed(4)));
  }

  assert.deepEqual(shown, ["0.06 credits", "0.05 credits", "0.04 credits"]);
  assert.deepEqual(totals, [0.0615, 0.1066, 0.1493]);
  assert.ok(totals[2] > totals[1] && totals[1] > totals[0], "the chat total only rises");
});

/*
 * The meter reaches `readUsage` by two routes — its own notification and one
 * bolted to a `session/update`. 2.20.2 uses the first. If a build ever used
 * both, adding each reading would bill the turn twice; replacing cannot.
 */
test("a turn metered twice is still counted once", () => {
  const spent = [];
  const session = fakeSession((value) => spent.push(value));

  session.startTurn();
  session.notify(METERING.turns[0].params);
  session.notify(METERING.turns[0].params);
  session.endTurn();

  assert.deepEqual(spent, [0.0614601119402985]);
  assert.equal(Number(session.sessionCredits.toFixed(4)), 0.0615);
});

/*
 * The notification that carries only a context reading must not be mistaken
 * for a free turn. It is the first thing Kiro sends after a prompt goes.
 */
test("a notification with no meter reports no cost", () => {
  const panel = loadPanel();
  const session = fakeSession((spent, model) => panel.noteTurnCredits(spent, model));
  const live = bubble(panel.dom);
  panel.setCurrent(live);

  session.startTurn();
  session.notify(METERING.contextOnly.params);
  session.endTurn();

  assert.equal(costOf(live), undefined, "nothing reported is not zero");
  assert.equal(session.sessionCredits, 0);
});
