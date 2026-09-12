/*
 * Which section a figure belongs in, run rather than read.
 *
 * `usage.ts` names the two scopes apart and says which survives a chat
 * ending: `sessionCredits` describes the conversation, `planName` and the
 * `account*` fields describe the account. The panel was the one place they
 * were drawn together, with "This chat" as the third row under the "Account"
 * heading.
 *
 * That was invisible for as long as it was unreachable — the credit meter was
 * never parsed, so `sessionCredits` was never a number and the row never
 * rendered. 0.37.0 fixed the parser and the row appeared, bringing with it a
 * flag it had no business setting.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const js = fs.readFileSync(path.join(root, "media", "chat.js"), "utf8");

/** The same slice-to-the-next-function rule the other webview tests use. */
function sliceFrom(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start > -1, `${marker} should be findable`);
  const indent = " ".repeat(source.slice(0, start).match(/[ \t]*$/)[0].length);
  const rest = source.slice(start + marker.length);
  const next = "function |const |let |case |// ---|/\\*";
  const end = rest.search(new RegExp(`\\n${indent}(${next})`));
  return marker + (end === -1 ? rest : rest.slice(0, end));
}

function element() {
  const node = {
    children: [],
    style: {},
    attributes: {},
    textContent: "",
    className: "",
    innerHTML: "",
    classList: {
      add(name) {
        node.className += ` ${name}`;
      },
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    append(...children) {
      this.children.push(...children);
    },
    setAttribute(key, value) {
      this.attributes[key] = value;
    },
    addEventListener() {},
  };
  return node;
}

const MODEL = { modelId: "test", contextWindowTokens: 256000 };

/** The real panel, both halves of it. */
function draw(usage, options = {}) {
  const sandbox = {
    usage,
    usageReport: options.report || null,
    usageLoading: false,
    document: { createElement: element },
    usagePanel: element(),
    vscode: { postMessage() {} },
    models: [MODEL],
    currentModelId: MODEL.modelId,
    contextBreakdown: options.breakdown || null,
    contextLoading: false,
    contextError: "",
  };
  vm.createContext(sandbox);
  for (const name of [
    "credits",
    "contextState",
    "contextTokens",
    "renderContextPanel",
    "renderContextBreakdown",
    "renderUsagePanel",
  ]) {
    vm.runInContext(sliceFrom(js, `function ${name}(`), sandbox);
  }
  vm.runInContext("renderUsagePanel()", sandbox);
  return sandbox.usagePanel;
}

const text = (node) => [node.textContent, ...node.children.map(text)].join(" ");
const flat = (node) => text(node).replace(/\s+/g, " ").trim();

/** Each `.context-details` section, flattened to its text. */
const sections = (panel) =>
  panel.children.filter((c) => /context-details/.test(c.className)).map(flat);

const ACCOUNT = {
  planName: "Pro",
  accountCreditsUsed: 12.5,
  accountCreditsLimit: 500,
  accountResetsOn: "1 October 2026",
};

const BREAKDOWN = {
  totalTokens: 13800,
  categories: [
    {
      key: "yourPrompts",
      label: "Your messages",
      tokens: 13800,
      percent: 7,
      items: [],
    },
  ],
};

/*
 * Both figures answer "how is this chat doing", so they share the heading's
 * line. The account keeps a section of its own because it is the other scope.
 */
test("the chat's spend sits beside the context reading, not under Account", () => {
  const panel = draw(
    { ...ACCOUNT, contextPercent: 7, sessionCredits: 0.02 },
    { breakdown: BREAKDOWN }
  );
  const found = sections(panel);

  const context = found.find((s) => s.includes("Context"));
  const account = found.find((s) => s.includes("Account"));
  assert.ok(context && account, "both sections have to be there");
  assert.notEqual(context, account, "and they have to be different sections");

  assert.match(
    context,
    /7% · 13\.8k of 256k · 0\.02 credits/,
    "the chat's two figures share one line"
  );
  assert.doesNotMatch(account, /credits this chat|This chat/, "the account is the account");
  assert.doesNotMatch(
    account,
    /0\.02/,
    "and the chat's spend is not repeated under it"
  );
});

/* A reading with no breakdown yet still carries the spend. */
test("the spend shows before Kiro has reported a breakdown", () => {
  const panel = draw({ contextPercent: 7, sessionCredits: 0.02 });
  assert.match(sections(panel).find((s) => s.includes("Context")), /7% · 0\.02 credits/);
});

/* And a chat metered before any context reading arrives still says so. */
test("the spend shows before a context reading arrives", () => {
  const panel = draw({ sessionCredits: 0.02 });
  assert.match(
    sections(panel).find((s) => s.includes("Context")),
    /not reported · 0\.02 credits/
  );
});

/*
 * The flag decides two things — whether Kiro's raw printout stands in for
 * figures, and whether the button offers a first fetch or a refresh — and
 * both readers mean "an account report was read". A chat-scoped row setting
 * it made the panel claim an account had been fetched on the first turn of
 * every conversation.
 */
test("a chat with credits does not claim the account has been checked", () => {
  const drawn = flat(draw({ contextPercent: 7, sessionCredits: 0.02 }));
  assert.match(drawn, /0\.02 credits/, "the spend still shows");
  assert.match(drawn, /Not fetched yet\./, "and the account says it has not been read");
  assert.match(drawn, /Check account usage/, "so the button offers the first fetch");
  assert.doesNotMatch(drawn, /Refresh/, "never a refresh of something never fetched");
});

test("once the account has been read, the button refreshes it", () => {
  const drawn = flat(
    draw({ ...ACCOUNT, sessionCredits: 0.02 }, { report: { ok: true, text: "raw" } })
  );
  assert.match(drawn, /Refresh/);
  assert.doesNotMatch(drawn, /Not fetched yet\./);
  assert.doesNotMatch(drawn, /raw/, "the printout is only shown when nothing parsed");
});

/*
 * No reading is not a reading of nothing — the rule this feature follows from
 * the parser outwards. A chat Kiro has not metered says nothing about credits
 * rather than showing a confident zero.
 */
test("a chat with no reported credits shows no figure for it", () => {
  const panel = draw({ ...ACCOUNT, contextPercent: 7 }, { breakdown: BREAKDOWN });
  const context = sections(panel).find((s) => s.includes("Context"));
  assert.match(context, /7% · 13\.8k of 256k/, "the context reading is unaffected");
  assert.doesNotMatch(context, /credits/, "nothing reported means nothing drawn");
  assert.match(flat(panel), /Credits used/, "and the account half is unaffected");
});
