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
const NO_WINDOW = { modelId: "auto" };

/** The real panel, both halves of it. */
function draw(usage, options = {}) {
  const sandbox = {
    usage,
    usageReport: options.report || null,
    usageLoading: false,
    document: { createElement: element },
    usagePanel: element(),
    vscode: { postMessage() {} },
    models: [options.model || MODEL],
    currentModelId: (options.model || MODEL).modelId,
    contextBreakdown: options.breakdown || null,
    contextLoading: false,
    contextError: "",
    currentAgent: options.agent || "kiro",
    agentName: options.agentName || "Kiro",
  };
  vm.createContext(sandbox);
  for (const name of [
    "credits",
    "contextState",
    "contextTokens",
    "categoryTokens",
    "breakdownTokens",
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

test("under Qoder the account offers a check, in the panel", () => {
  const all = flat(draw({}, { agent: "qoder", agentName: "Qoder" }));
  assert.match(all, /Not fetched yet/);
  assert.match(all, /Check Qoder usage/);
  assert.doesNotMatch(all, /terminal/i);
});

test("under Qoder the account shows the rows read off Qoder's usage screen", () => {
  const report = {
    ok: true,
    text: "",
    rows: [
      { label: "Plan", value: "Enterprise" },
      { label: "Plan Expires At", value: "Dec 1, 2026, 00:00:00 GMT+8" },
      { label: "Org Resource Package", value: "0/2000" },
    ],
  };
  const panel = draw({ planName: "Enterprise" }, { agent: "qoder", agentName: "Qoder", report });
  const account = sections(panel).find((section) => section.startsWith("Account"));
  assert.match(account, /Account Enterprise/);
  assert.match(account, /Plan Expires At Dec 1, 2026/);
  assert.match(account, /Org Resource Package 0\/2000/);
  // The plan is the heading's figure, not a row of its own as well.
  assert.equal(account.match(/Enterprise/g).length, 1);
  assert.match(flat(panel), /Refresh/);
});

test("under Qoder a failed check says why", () => {
  const report = { ok: false, text: "Qoder needs you to sign in before it can show usage." };
  assert.match(flat(draw({}, { agent: "qoder", agentName: "Qoder", report })), /needs you to sign in/);
});

/*
 * Measured on 3.1.0: `yourPrompts` arrives with `percent: 4.4` and
 * `tokens: 0`. Read through the real parser, from the captured payload.
 */
const { readSessionInfo, readContextCommand } = require("../out/usage.js");
const CAPTURED = readContextCommand(
  readSessionInfo(require("./fixtures/kiro-session-info.json").context).context
);
const contextOf = (panel) => sections(panel).find((s) => s.startsWith("Context"));

test("a share Kiro reported without a count is estimated, not dropped", () => {
  assert.equal(CAPTURED.categories.find((c) => c.key === "yourPrompts").tokens, 0, "the capture still says 0");
  const context = contextOf(draw({ contextPercent: 6.2765627 }, { breakdown: CAPTURED }));
  // 4913 counted, plus 4.4% of 256k estimated.
  assert.match(context, /6% · ~16\.2k of 256k/, "the header no longer undercounts");
  assert.match(context, /Your messages ~11\.3k/, "the largest category has its row");
  assert.match(context, /Tool definitions 4\.9k/, "a count Kiro gave is shown as given");
});

test("with no window to estimate from, the share is shown and the header names no count", () => {
  const context = contextOf(draw({ contextPercent: 6.2765627 }, { breakdown: CAPTURED, model: NO_WINDOW }));
  assert.match(context, /Context 6%/);
  assert.doesNotMatch(context, /4\.9k ·|6% · 4\.9k/, "a sum missing a category is not shown as the total");
  assert.match(context, /Your messages 4\.4%/);
});

test("counts Kiro gave are never replaced by an estimate", () => {
  const context = contextOf(draw({ contextPercent: 7 }, { breakdown: BREAKDOWN }));
  assert.match(context, /7% · 13\.8k of 256k/);
  assert.doesNotMatch(context, /~/);
});
