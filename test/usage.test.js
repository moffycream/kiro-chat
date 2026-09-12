// Run with: npm test  (compiles first, then runs against out/usage.js)
//
// The payloads below are the real answers from kiro-cli 2.20.2 over ACP, with
// the account figures replaced. If Kiro changes shape, these are what tell us.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  clearSessionUsage,
  creditRateOf,
  readTurnCredits,
  describeContextWindow,
  formatCredits,
  formatUsageReport,
  parseAccountUsage,
  readMeter,
  readModelDetails,
  readUsageCommand,
  SESSION_USAGE_KEYS,
} = require("../out/usage");

/** The real `_kiro.dev/metadata` payloads, captured from kiro-cli 2.20.2. */
const METERING = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "kiro-metering.json"), "utf8")
);

const USAGE_DATA = {
  planName: "KIRO PRO+",
  billingCycleReset: "2026-10-01",
  overagesEnabled: false,
  isEnterprise: true,
  usageBreakdowns: [
    {
      resourceType: "CREDIT",
      displayName: "Credits",
      used: 12.5,
      limit: 2000,
      percentage: 1,
      currentOverages: 0,
      overageRate: 0.04,
      overageCharges: 0,
      currency: "USD",
      hasLimit: true,
    },
  ],
  bonusCredits: [],
  addOnCredits: [],
  overageCapable: true,
};

const MODEL_DATA = {
  models: [
    {
      id: "auto",
      displayName: "auto",
      contextWindow: 1000000,
      description: "Models chosen by task for optimal usage and consistent quality",
      rateMultiplier: 1,
    },
    {
      id: "claude-opus-5",
      displayName: "claude-opus-5",
      contextWindow: 1000000,
      description: "Claude Opus 5 model with 1M context window",
      rateMultiplier: 2.2,
    },
    {
      id: "gpt-5.6-luna",
      displayName: "gpt-5.6-luna",
      contextWindow: 272000,
      description: "Experimental preview of OpenAI GPT 5.6 Luna with 272k context window",
      rateMultiplier: 0.1,
    },
  ],
};

test("the usage command's plan figures are read", () => {
  assert.deepEqual(readUsageCommand(USAGE_DATA), {
    planName: "KIRO PRO+",
    accountResetsOn: "2026-10-01",
    accountCreditsUsed: 12.5,
    accountCreditsLimit: 2000,
  });
});

test("an unlimited resource reports no limit rather than a wrong one", () => {
  const data = {
    usageBreakdowns: [{ displayName: "Credits", used: 4, limit: 0, hasLimit: false }],
  };
  const out = readUsageCommand(data);
  assert.equal(out.accountCreditsUsed, 4);
  assert.equal(out.accountCreditsLimit, undefined);
});

test("the usage command is summarised for the transcript", () => {
  assert.equal(
    formatUsageReport(USAGE_DATA),
    [
      "Plan: KIRO PRO+",
      "Credits: 12.5 of 2000 used (1%)",
      "Renews: 2026-10-01",
      "Overages are switched off, so work stops at the limit.",
    ].join("\n")
  );
});

test("an unrecognised usage payload falls back to what Kiro printed", () => {
  assert.equal(formatUsageReport(undefined, "Not signed in."), "Not signed in.");
  assert.equal(formatUsageReport({}, ""), "");
});

test("model credit rates and context windows are read from the model command", () => {
  const details = readModelDetails(MODEL_DATA);
  assert.equal(details.get("claude-opus-5").creditRate, "2.2x");
  assert.equal(details.get("gpt-5.6-luna").creditRate, "0.1x");
  assert.equal(details.get("auto").creditRate, "1x");
  assert.equal(details.get("gpt-5.6-luna").contextWindow, 272000);
  assert.equal(readModelDetails(undefined).size, 0);
});

test("context windows are described in round numbers", () => {
  assert.equal(describeContextWindow(1000000), "1M context");
  assert.equal(describeContextWindow(272000), "272k context");
  assert.equal(describeContextWindow(undefined), undefined);
  assert.equal(describeContextWindow(0), undefined);
});

test("credit rate is read from every spelling Kiro has used", () => {
  assert.equal(creditRateOf({ rateMultiplier: 2.2 }), "2.2x");
  assert.equal(creditRateOf({ creditRate: "1.5x" }), "1.5x");
  assert.equal(creditRateOf({ credit_rate: 2 }), "2x");
  assert.equal(creditRateOf({ pricing: { multiplier: 3 } }), "3x");
  assert.equal(
    creditRateOf({ name: "Sonnet", description: "Fast. 1.00x credits." }),
    "1.00x"
  );
});

test("credit rate is never invented from an unrelated multiplier", () => {
  assert.equal(creditRateOf({ name: "Turbo", description: "200x faster" }), undefined);
  // This is the shape session/new actually sends: no rate anywhere in it.
  assert.equal(
    creditRateOf({
      modelId: "claude-opus-5",
      name: "claude-opus-5",
      description: "Claude Opus 5 model with 1M context window",
    }),
    undefined
  );
});

/*
 * The meter, against what Kiro actually sends.
 *
 * `meteringUsage` is an ARRAY — `[{ value, unit: "credit", unitPlural }]` — and
 * for the life of this feature it was read as a bare number or an object with
 * the figure under one of five key names. An array is `typeof "object"` and
 * carries none of those names, so every reading fell through and
 * `sessionCredits` was never once set. The strip said Kiro had reported no
 * credits, and it was right about the reading and wrong about Kiro. The
 * fixture is the real capture.
 */
test("the meter reads the array shape kiro-cli actually sends", () => {
  const first = METERING.turns[0].params;
  assert.deepEqual(readMeter(first), {
    contextPercent: 2.424499988555908,
    turnCredits: 0.0614601119402985,
  });
  // Every captured turn has to read, not just the one that was looked at.
  for (const turn of METERING.turns) {
    const out = readMeter(turn.params);
    assert.equal(typeof out.turnCredits, "number", "each turn reports a cost");
    assert.ok(out.turnCredits > 0);
  }
  // A notification carrying only the context reading is the other real shape.
  assert.deepEqual(readMeter(METERING.contextOnly.params), {
    contextPercent: 6.253500461578369,
  });
});

/*
 * Those three readings fall — 0.0615, 0.0451, 0.0427 — and each sits beside a
 * `turnDurationMs` for its own turn. It is the cost of one turn, not a running
 * total. Reading it as a total would make the strip count *down* as a
 * conversation went on, which is the bug this pins shut.
 */
test("the readings are per turn and do not accumulate", () => {
  const values = METERING.turns.map((turn) => readMeter(turn.params).turnCredits);
  assert.deepEqual(
    values.map((v) => Number(v.toFixed(4))),
    [0.0615, 0.0451, 0.0427]
  );
  assert.ok(values[1] < values[0], "a total could not fall");
  assert.ok(values[2] < values[1]);
});

/* The older shapes still read, because dropping one goes silent exactly as this did. */
test("a bare number and a single object are still understood", () => {
  assert.deepEqual(readMeter({ meteringUsage: 4.25 }), { turnCredits: 4.25 });
  assert.deepEqual(readMeter({ meteringUsage: { creditsUsed: 7 } }), { turnCredits: 7 });
  assert.deepEqual(readMeter({ meteringUsage: { value: 2 } }), { turnCredits: 2 });
  assert.deepEqual(readMeter({ contextUsagePercentage: 42 }), { contextPercent: 42 });
  assert.deepEqual(readMeter({}), {});
});

/*
 * A unit is checked when there is one, in the spirit of the rest of this file:
 * a number is only a credit figure when something says it is. An entry with no
 * unit is taken at face value, because the older shapes carry none.
 */
test("only credits are added up", () => {
  assert.equal(
    readTurnCredits([
      { value: 1.5, unit: "credit", unitPlural: "credits" },
      { value: 900, unit: "token", unitPlural: "tokens" },
    ]),
    1.5
  );
  assert.equal(readTurnCredits([{ value: 2 }, { value: 3 }]), 5, "two credit entries add");
  assert.equal(readTurnCredits([{ value: 10, unit: "tokens" }]), undefined);
  assert.equal(readTurnCredits([]), undefined, "an empty array reports nothing");
  assert.equal(readTurnCredits([{}]), undefined, "and so does an entry with no figure");
});

/* A reading that is not one is never invented into a number. */
test("a meter that says nothing reports nothing", () => {
  for (const value of [undefined, null, "", NaN, Infinity, {}, "0.5"]) {
    assert.equal(
      readMeter({ meteringUsage: value }).turnCredits,
      undefined,
      `${String(value)} should report no cost`
    );
  }
});

test("missing and invalid context readings are not reported as empty sessions", () => {
  for (const value of [null, "", " ", false, -1, 101, Infinity, "unknown"]) {
    assert.deepEqual(readMeter({ contextUsagePercentage: value }), {});
  }
  assert.deepEqual(readMeter({ contextUsagePercentage: "0" }), { contextPercent: 0 });
  assert.deepEqual(readMeter({ contextUsagePercentage: 100 }), { contextPercent: 100 });
});

// The prose fallback, for builds whose usage command has no structured data.

test("plan credits read as a used/total pair", () => {
  const out = parseAccountUsage("Credits: 123.5 / 500\nResets on 1 October 2026");
  assert.equal(out.accountCreditsUsed, 123.5);
  assert.equal(out.accountCreditsLimit, 500);
  assert.equal(out.accountResetsOn, "1 October 2026");
});

test("windows line endings and thousands separators are handled", () => {
  const out = parseAccountUsage("You have used 1,240 credits\r\nRenews in 3 days\r\n");
  assert.equal(out.accountCreditsUsed, 1240);
  assert.equal(out.accountResetsOn, "3 days");
});

test("numbers away from the word credit are never treated as a balance", () => {
  assert.deepEqual(parseAccountUsage("Session id 4821 / 9000\nModel: sonnet"), {});
  assert.deepEqual(parseAccountUsage("Not signed in."), {});
});

// ---- the two scopes ---------------------------------------------------

/*
 * `contextPercent` and `sessionCredits` describe the conversation in front of
 * you; the other four describe the account and are true however many chats
 * you start. They live in one flat object because that is what the panel
 * draws from, and a reset that could not tell them apart cost twice: a new
 * chat wiped the plan figures you had just fetched, and opening a past chat
 * reset nothing, so one conversation's credits were shown against another.
 */
const BOTH_SCOPES = {
  contextPercent: 42,
  sessionCredits: 2.47,
  planName: "KIRO PRO+",
  accountCreditsUsed: 1234,
  accountCreditsLimit: 5000,
  accountResetsOn: "2026-10-01",
};

test("ending a conversation drops its numbers and keeps the account's", () => {
  assert.deepEqual(clearSessionUsage(BOTH_SCOPES), {
    planName: "KIRO PRO+",
    accountCreditsUsed: 1234,
    accountCreditsLimit: 5000,
    accountResetsOn: "2026-10-01",
  });
});

test("the session-scoped keys are named, not guessed at", () => {
  assert.deepEqual([...SESSION_USAGE_KEYS], ["contextPercent", "sessionCredits"]);
});

test("clearing does not mutate what it was given", () => {
  const before = { ...BOTH_SCOPES };
  clearSessionUsage(BOTH_SCOPES);
  assert.deepEqual(BOTH_SCOPES, before, "the caller's object is left alone");
});

test("clearing an empty or account-only picture is a no-op", () => {
  assert.deepEqual(clearSessionUsage({}), {});
  const account = { planName: "Free", accountCreditsUsed: 3 };
  assert.deepEqual(clearSessionUsage(account), account);
});

// ---- how a credit figure reads ---------------------------------------

/*
 * Session credits were fixed at two decimals and account credits were not
 * formatted at all, so a plan total arrived as "1234.5678901234 credits on
 * Pro" on a strip sized for a sidebar.
 */
test("a credit figure is at most two decimals, with no trailing zeros", () => {
  assert.equal(formatCredits(1234.5678901234), "1234.57");
  assert.equal(formatCredits(1234), "1234", "a whole number stays whole");
  assert.equal(formatCredits(2.4), "2.4", "and 2.40 is not more precise than 2.4");
  assert.equal(formatCredits(2.469), "2.47");
  assert.equal(formatCredits(0), "0", "zero is a figure, not a missing one");
});

test("a figure that is not one is not invented", () => {
  assert.equal(formatCredits(undefined), "");
  assert.equal(formatCredits(NaN), "");
  assert.equal(formatCredits(Infinity), "");
});
