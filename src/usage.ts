/**
 * Reading credits, rates and context out of what Kiro tells us.
 *
 * Kept free of any `vscode` import so it can be exercised on its own — see
 * `test/usage.test.js`. The shapes here were read off kiro-cli 2.20.2 over ACP;
 * everything is defensive, because older and newer builds differ and a wrong
 * guess would show the user a made-up number.
 */

export interface UsageInfo {
  contextPercent?: number;
  sessionCredits?: number;
  /** Plan figures, from Kiro's own `usage` command. */
  planName?: string;
  accountCreditsUsed?: number;
  accountCreditsLimit?: number;
  accountResetsOn?: string;
}

/**
 * Two scopes in one object, and which is which has to be written down.
 *
 * `contextPercent` and `sessionCredits` describe the conversation in front of
 * you. The other four describe your account and are true no matter how many
 * chats you start. Kept in one flat object because that is what the panel
 * draws from, but a reset has to be able to tell them apart — and could not,
 * which cost twice:
 *
 * - Starting a new chat did `usage = {}`, so the plan figures you had just
 *   fetched vanished from the strip along with the session's own numbers.
 * - Opening a past chat reset nothing at all, so "2.47 credits this chat"
 *   stayed on screen while you read a different conversation — a specific
 *   claim about the chat in front of you, made about another one.
 */
export const SESSION_USAGE_KEYS = ["contextPercent", "sessionCredits"] as const;

/**
 * Everything a conversation ending does not invalidate. There is no attempt
 * to restore a past chat's own credits: they are not stored anywhere, and no
 * number is honest where a wrong one is not.
 */
export function clearSessionUsage(usage: UsageInfo): UsageInfo {
  const out: UsageInfo = { ...usage };
  for (const key of SESSION_USAGE_KEYS) delete out[key];
  return out;
}

/**
 * A credit figure as it should be read.
 *
 * Session credits were fixed at two decimals and account credits were not
 * formatted at all, so a plan total came out as `1234.5678901234 credits on
 * Pro` on a strip sized for a sidebar. Two decimals is as fine as a credit
 * gets; trailing zeros on a whole number are noise.
 */
export function formatCredits(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return String(Number(value.toFixed(2)));
}

export function numberFrom(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const match = value.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    if (match) return Number(match[0]);
  }
  return undefined;
}

/**
 * Kiro shows credit rates like "1.00x credits" in its own interface. When that
 * appears in a model's name or description we surface it. We never guess one.
 */
export function findCreditRate(...fields: (string | undefined)[]): string | undefined {
  for (const field of fields) {
    // Only trust a multiplier that sits next to the word "credit". Without
    // that guard a phrase like "200x faster" would be shown as a price.
    if (!field || !/credit/i.test(field)) continue;
    const forward = field.match(/(\d+(?:\.\d+)?)\s*(?:x|×)\s*credits?/i);
    if (forward) return `${forward[1]}x`;
    const reversed = field.match(
      /credits?\s*[:=]?\s*(?:x|×)?\s*(\d+(?:\.\d+)?)\s*(?:x|×)?/i
    );
    if (reversed) return `${reversed[1]}x`;
  }
  return undefined;
}

/**
 * Kiro is inconsistent about where a model's credit rate lives, and the model
 * list that comes back with a new session carries no rate at all — that arrives
 * only from the `model` command, as `rateMultiplier`. Check every spelling.
 */
export function creditRateOf(model: any): string | undefined {
  const fields = [
    model?.rateMultiplier,
    model?.rate_multiplier,
    model?.creditRate,
    model?.credit_rate,
    model?.creditMultiplier,
    model?.credit_multiplier,
    model?.credits,
    model?.costMultiplier,
    model?.cost_multiplier,
    model?.rate,
    model?.meta?.creditRate,
    model?.metadata?.creditRate,
    model?._meta?.creditRate,
    model?.pricing?.creditRate,
    model?.pricing?.multiplier,
  ];
  for (const field of fields) {
    const value = numberFrom(field);
    if (value !== undefined) return `${value}x`;
  }
  return findCreditRate(
    model?.name,
    model?.displayName,
    model?.description,
    model?.summary
  );
}

/**
 * The `model` command answers with the rate and context window that the plain
 * session model list leaves out. Returns modelId -> extra detail.
 */
export function readModelDetails(
  data: any
): Map<string, { creditRate?: string; contextWindow?: number }> {
  const out = new Map<string, { creditRate?: string; contextWindow?: number }>();
  const list = data?.models ?? data?.availableModels ?? data;
  if (!Array.isArray(list)) return out;

  for (const model of list) {
    const id = String(model?.id ?? model?.modelId ?? "");
    if (!id) continue;
    out.set(id, {
      creditRate: creditRateOf(model),
      contextWindow: numberFrom(model?.contextWindow ?? model?.context_window),
    });
  }
  return out;
}

/** "1M context" / "272k context" — the number is only useful rounded. */
export function describeContextWindow(tokens: number | undefined): string | undefined {
  if (!tokens || !Number.isFinite(tokens)) return undefined;
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number(millions.toFixed(1))}M context`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k context`;
  return `${tokens} context`;
}

/**
 * One reading off a `_kiro.dev/metadata` notification.
 *
 * `turnCredits` is the cost of the turn that just finished and **not** a
 * running total — measured by driving `kiro-cli acp` over three turns in one
 * session, which reported 0.0615, 0.0451 and 0.0427, each with a
 * `turnDurationMs` matching that turn alone. `test/fixtures/kiro-metering.json`
 * is that capture. The conversation's total is this accumulated, which
 * `KiroSession` does, because only it knows where one turn ends.
 */
export interface MeterReading {
  contextPercent?: number;
  turnCredits?: number;
}

/**
 * What a `meteringUsage` says a turn cost.
 *
 * **It is an array**, and that was the whole bug: kiro-cli 2.20.2 sends
 * `[{ value, unit: "credit", unitPlural: "credits" }]`, which is `typeof
 * "object"` and carries none of the key names this used to look for, so every
 * reading was dropped and `sessionCredits` was never once set. The strip said
 * "Kiro has not reported any credit use for this chat yet" for the life of
 * every conversation, and it was right about the reading and wrong about Kiro.
 *
 * A unit is checked when there is one, in the spirit of the rest of this file:
 * a figure is only a credit figure when something says it is. An entry with no
 * unit at all is taken at face value, because the older shapes had none — but
 * one that names some other unit is left alone rather than added to credits it
 * is not.
 */
export function readTurnCredits(metering: unknown): number | undefined {
  if (typeof metering === "number") {
    return Number.isFinite(metering) ? metering : undefined;
  }

  if (Array.isArray(metering)) {
    let total = 0;
    let found = false;
    for (const entry of metering) {
      const value = numberFrom((entry as any)?.value ?? (entry as any)?.amount);
      if (value === undefined) continue;
      const unit = `${(entry as any)?.unit ?? ""} ${(entry as any)?.unitPlural ?? ""}`.trim();
      if (unit && !/credit/i.test(unit)) continue;
      total += value;
      found = true;
    }
    return found ? total : undefined;
  }

  if (metering && typeof metering === "object") {
    const source = metering as any;
    const candidate = [
      source.credits,
      source.total,
      source.amount,
      source.creditsUsed,
      source.used,
      source.value,
    ].find((v) => typeof v === "number" && Number.isFinite(v));
    return candidate === undefined ? undefined : Number(candidate);
  }

  return undefined;
}

/**
 * Read the meter Kiro attaches to its notifications.
 *
 * The array is the shape 2.20.2 actually sends; the bare number and the
 * single object are kept because they cost two lines and a build that sends
 * one of them would otherwise go silent in exactly the way this did.
 */
export function readMeter(params: any): MeterReading {
  const out: MeterReading = {};

  const raw = params?.contextUsagePercentage;
  const percent =
    typeof raw === "number" || (typeof raw === "string" && raw.trim()) ? Number(raw) : NaN;
  if (Number.isFinite(percent) && percent >= 0 && percent <= 100) out.contextPercent = percent;

  const spent = readTurnCredits(params?.meteringUsage);
  if (spent !== undefined) out.turnCredits = spent;

  return out;
}

interface Breakdown {
  label: string;
  used?: number;
  limit?: number;
  percentage?: number;
  overageCharges?: number;
  currency?: string;
}

function breakdownsOf(data: any): Breakdown[] {
  const groups = [
    data?.usageBreakdowns,
    data?.bonusCredits,
    data?.addOnCredits,
  ].filter(Array.isArray);

  const out: Breakdown[] = [];
  for (const group of groups) {
    for (const entry of group) {
      const label = String(
        entry?.displayName ?? entry?.resourceType ?? entry?.name ?? "Credits"
      );
      out.push({
        label,
        used: numberFrom(entry?.used),
        limit: entry?.hasLimit === false ? undefined : numberFrom(entry?.limit),
        percentage: numberFrom(entry?.percentage),
        overageCharges: numberFrom(entry?.overageCharges),
        currency: entry?.currency ? String(entry.currency) : undefined,
      });
    }
  }
  return out;
}

/**
 * Pull the plan figures out of the `usage` command's structured answer. The
 * credit line is the one the strip shows; the rest goes in the report card.
 */
export function readUsageCommand(data: any): Partial<UsageInfo> {
  const out: Partial<UsageInfo> = {};
  if (!data || typeof data !== "object") return out;

  if (data.planName) out.planName = String(data.planName);
  if (data.billingCycleReset) out.accountResetsOn = String(data.billingCycleReset);

  const breakdowns = breakdownsOf(data);
  const credits =
    breakdowns.find((b) => /credit/i.test(b.label)) ?? breakdowns[0];
  if (credits?.used !== undefined) out.accountCreditsUsed = credits.used;
  if (credits?.limit !== undefined) out.accountCreditsLimit = credits.limit;

  return out;
}

const money = (amount: number, currency?: string) =>
  currency === "USD" ? `$${amount.toFixed(2)}` : `${amount.toFixed(2)} ${currency ?? ""}`.trim();

/** Turn the `usage` answer into the card shown in the transcript. */
export function formatUsageReport(data: any, fallback = ""): string {
  const breakdowns = breakdownsOf(data);
  if (breakdowns.length === 0 && !data?.planName) return fallback;

  const lines: string[] = [];
  if (data?.planName) lines.push(`Plan: ${String(data.planName)}`);

  for (const entry of breakdowns) {
    if (entry.used === undefined) continue;
    const total = entry.limit !== undefined ? ` of ${entry.limit}` : "";
    const percent =
      entry.percentage !== undefined && entry.limit !== undefined
        ? ` (${entry.percentage}%)`
        : "";
    lines.push(`${entry.label}: ${entry.used}${total} used${percent}`);
    if (entry.overageCharges) {
      lines.push(`  Overage so far: ${money(entry.overageCharges, entry.currency)}`);
    }
  }

  if (data?.billingCycleReset) lines.push(`Renews: ${String(data.billingCycleReset)}`);
  if (data?.overagesEnabled === false && data?.overageCapable) {
    lines.push("Overages are switched off, so work stops at the limit.");
  }

  return lines.join("\n") || fallback;
}

/**
 * Last resort for builds whose `usage` command answers with prose instead of
 * data. Only lines that talk about credits are considered, so a stray number
 * elsewhere in the report is never mistaken for a balance.
 */
export function parseAccountUsage(report: string): Partial<UsageInfo> {
  const out: Partial<UsageInfo> = {};

  const NUMBER = String.raw`\d[\d,]*(?:\.\d+)?`;
  const pairPattern = new RegExp(
    String.raw`(${NUMBER})\s*(?:\/|of|out of)\s*(${NUMBER})`,
    "i"
  );
  const singlePattern = new RegExp(
    String.raw`(?:used|spent|consumed)[^\d]{0,20}(${NUMBER})`,
    "i"
  );
  const resetPattern = /(?:resets?|renews?)[a-z]*\s*(?:on|at|in)?\s*[:\-]?\s*(.+)$/i;
  const toNumber = (text: string) => Number(text.replace(/,/g, ""));

  for (const line of report.split(/\r?\n/)) {
    if (/credit/i.test(line) && out.accountCreditsUsed === undefined) {
      const pair = line.match(pairPattern);
      if (pair) {
        out.accountCreditsUsed = toNumber(pair[1]);
        out.accountCreditsLimit = toNumber(pair[2]);
      } else {
        const single = line.match(singlePattern);
        if (single) out.accountCreditsUsed = toNumber(single[1]);
      }
    }
    if (/reset|renew/i.test(line) && !out.accountResetsOn) {
      const when = line.match(resetPattern);
      const text = when?.[1]?.trim().replace(/[.\s]+$/, "");
      if (text && text.length <= 40) out.accountResetsOn = text;
    }
  }

  return out;
}

/**
 * What Kiro says is actually in its context, category by category.
 *
 * Measured by driving `kiro-cli acp` directly: `_kiro.dev/commands/execute`
 * with `{ command: "context", args: {} }` answers with a real breakdown —
 * `contextFiles` (with the matched files named), `tools` (grouped by source),
 * `kiroResponses`, `yourPrompts` and `sessionFiles`, each carrying a token
 * count and a percentage, alongside `contextUsagePercentage` and the model.
 * `{ value: "show" }` returns the same numbers and only flips
 * `initialExpanded`, so the plain call is the one to make.
 *
 * This is why the panel no longer says category totals are unavailable: they
 * were unavailable from the *meter*, which is all it used to have.
 */
export interface ContextEntry {
  name: string;
  tokens: number;
  percent: number;
  /** Context files only: a file Kiro looked for and did not find. */
  matched?: boolean;
}

export interface ContextCategory {
  key: string;
  label: string;
  tokens: number;
  percent: number;
  items: ContextEntry[];
}

export interface ContextBreakdown {
  percent?: number;
  model?: string;
  categories: ContextCategory[];
  totalTokens: number;
}

/** The categories Kiro reports, in the order they are worth reading. */
const CONTEXT_CATEGORIES: Array<{ key: string; label: string }> = [
  { key: "contextFiles", label: "Context files" },
  { key: "sessionFiles", label: "Files in this chat" },
  { key: "yourPrompts", label: "Your messages" },
  { key: "kiroResponses", label: "Kiro's replies" },
  { key: "tools", label: "Tool definitions" },
];

function finite(value: any): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

/**
 * Items come two ways: `items` directly, or nested one level under `groups`
 * (which is how tools arrive, grouped by where they came from). Flattening
 * the groups keeps one shape for the panel to draw.
 */
function entriesOf(block: any): ContextEntry[] {
  const out: ContextEntry[] = [];
  const push = (item: any) => {
    const name = String(item?.name ?? "").trim();
    if (!name) return;
    const entry: ContextEntry = { name, tokens: finite(item?.tokens), percent: finite(item?.percent) };
    if (typeof item?.matched === "boolean") entry.matched = item.matched;
    out.push(entry);
  };
  if (Array.isArray(block?.items)) for (const item of block.items) push(item);
  if (Array.isArray(block?.groups)) {
    for (const group of block.groups) {
      if (Array.isArray(group?.items)) for (const item of group.items) push(item);
    }
  }
  return out;
}

export function readContextCommand(data: any): ContextBreakdown | undefined {
  const breakdown = data?.breakdown;
  if (!breakdown || typeof breakdown !== "object") return undefined;

  const categories: ContextCategory[] = [];
  let totalTokens = 0;
  for (const { key, label } of CONTEXT_CATEGORIES) {
    const block = breakdown[key];
    if (!block || typeof block !== "object") continue;
    const tokens = finite(block.tokens);
    totalTokens += tokens;
    categories.push({ key, label, tokens, percent: finite(block.percent), items: entriesOf(block) });
  }
  if (categories.length === 0) return undefined;

  const out: ContextBreakdown = { categories, totalTokens };
  /*
   * Only a percentage that could be one, read exactly as `readMeter` reads
   * it. `Number(null)` is 0, and 0 is a perfectly good percentage — so a
   * missing reading, passed through the obvious coercion, arrives as the
   * confident claim that the context is empty.
   */
  const raw = data?.contextUsagePercentage;
  const percent =
    typeof raw === "number" || (typeof raw === "string" && raw.trim()) ? Number(raw) : NaN;
  if (Number.isFinite(percent) && percent >= 0 && percent <= 100) out.percent = percent;
  const model = String(data?.model ?? "").trim();
  if (model) out.model = model;
  return out;
}
