/**
 * Qoder's account usage, read off its own `/usage` screen.
 *
 * Measured against qodercli 1.1.91: over ACP every token count is 0 and no
 * credit, context or plan figure is ever sent; its SDK mode has no account
 * request either (`get_context_usage` is the nearest); the account calls inside
 * the CLI are encrypted and signed; and the interactive screen draws nothing
 * without a real terminal. So the panel runs `qodercli` in a Windows
 * pseudo-console nobody sees (`resources/conpty-capture.ps1`), types `/usage`,
 * and reads the screen it draws. `test/fixtures/qoder-usage-screen.raw` is that
 * screen as captured.
 *
 * Reading a screen meant for people is the weak point, so this answers only
 * what it can read: a row is a label and a value either side of a colon on one
 * line, and nothing is reported when no known label is found.
 *
 * Free of `vscode` so `test/qoderUsage.test.js` can drive it.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface QoderUsageRow {
  label: string;
  value: string;
}

export interface QoderUsage {
  /** In the order Qoder drew them, account rows only. */
  rows: QoderUsageRow[];
  planName?: string;
  /** The date part of "Plan Expires At", for the strip's renewal slot. */
  expiresOn?: string;
}

/**
 * Rows about the account. The screen also lists this throwaway session's own
 * durations and code changes, which describe the check rather than the user.
 */
const ACCOUNT_LABELS = [
  "Qoder Plan",
  "Plan Expires At",
  "Plan Credits Used",
  "Add-on Credits Used",
  "Org Resource Package",
];

/**
 * The input that gets Qoder from start-up to the usage screen.
 *
 * It waits for the message box ("Type your message") rather than for a fixed
 * time. A folder Qoder has not seen first asks "Do you trust the files in this
 * folder?" with Trust highlighted, so Enter is pressed only when that was
 * drawn; the folder is an empty one of the panel's own, so trusting it opens
 * nothing. "Duration" is on the last screen's rows.
 */
export const QODER_USAGE_STEPS = [
  "wait:Type/trust|",
  "if:trust|\\r",
  "wait:Type|",
  "300|/usage",
  "700|\\r",
  "done:Duration",
];

/** Turn the raw terminal stream into lines of text, keeping column gaps. */
export function screenText(raw: string): string {
  return String(raw ?? "")
    .replace(/\x1b\[(\d*)C/g, (_, n) => " ".repeat(Number(n || 1)))
    .replace(/\x1b\[\d+;\d+H/g, "\n")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?>]*[ -\/]*[@-~]/g, "")
    .replace(/\x1b[()][A-Z0-9]/g, "")
    .replace(/\x1b[=>]/g, "")
    .replace(/\r/g, "");
}

/**
 * The account rows, from the last time each was drawn.
 *
 * The last, because the screen is redrawn as it loads and an earlier frame can
 * hold a placeholder. `undefined` when no known row is there at all — a screen
 * that is not the usage screen (signed out, a prompt nobody answered) must not
 * read as an account with nothing on it.
 */
export function readQoderUsage(raw: string): QoderUsage | undefined {
  const found = new Map<string, string>();
  for (const line of screenText(raw).split("\n")) {
    const match = line.match(/^\s*([A-Za-z][A-Za-z\- ]*?)\s*:\s*(.+?)\s*$/);
    if (!match) continue;
    const label = match[1].trim();
    if (ACCOUNT_LABELS.includes(label)) found.set(label, match[2]);
  }
  if (found.size === 0) return undefined;

  const rows = ACCOUNT_LABELS.filter((label) => found.has(label)).map((label) => ({
    label: label === "Qoder Plan" ? "Plan" : label,
    value: found.get(label) as string,
  }));
  const usage: QoderUsage = { rows };
  const plan = found.get("Qoder Plan");
  if (plan && plan !== "N/A") usage.planName = plan;
  // "Dec 1, 2026, 00:00:00 GMT+8" — the time and zone add nothing to a date.
  const expires = found.get("Plan Expires At")?.match(/^[A-Za-z]{3,9}\.? \d{1,2}, \d{4}/);
  if (expires) usage.expiresOn = expires[0];
  return usage;
}

export type RunCapture = (
  file: string,
  args: string[],
  timeoutMs: number
) => Promise<string>;

const defaultRun: RunCapture = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr || err.message).trim()));
        else resolve(String(stdout));
      }
    );
  });

/** The empty folder Qoder runs in for this, made on first use. */
export function usageFolder(): string {
  const dir = path.join(os.tmpdir(), "kiro-chat-qoder-usage");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Run Qoder's `/usage` screen invisibly and read it.
 *
 * `run` is injectable so the tests drive every branch without a terminal.
 * Throws with a sentence for the panel when the screen could not be read.
 */
export async function fetchQoderUsage(options: {
  command: string;
  script: string;
  cwd?: string;
  run?: RunCapture;
  timeoutMs?: number;
}): Promise<QoderUsage> {
  const total = options.timeoutMs ?? 45000;
  const run = options.run ?? defaultRun;
  const stdout = await run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      options.script,
      "-Exe",
      options.command,
      "-Cwd",
      options.cwd ?? usageFolder(),
      "-TotalMs",
      String(total),
      "-Steps",
      QODER_USAGE_STEPS.join("~~"),
    ],
    total + 15000
  );
  const raw = Buffer.from(stdout.trim(), "base64").toString("utf8");
  const usage = readQoderUsage(raw);
  if (!usage) {
    const text = screenText(raw);
    if (/sign\s*in|log\s*in|not logged in|authenticat/i.test(text) && !/Signed in/i.test(text)) {
      throw new Error("Qoder needs you to sign in before it can show usage.");
    }
    throw new Error("Qoder did not show its usage screen.");
  }
  return usage;
}

function figure(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return String(Math.round(value * 100) / 100);
}

function bucket(used: unknown, total: unknown): string {
  const spent = figure(used);
  const cap = figure(total);
  if (spent === undefined) return "N/A";
  return cap === undefined ? spent : `${spent}/${cap}`;
}

/**
 * The same rows, from the SDK's `getUsageInfo` rather than from the screen.
 *
 * The SDK answers this directly, so the ConPTY capture is only the fallback
 * for when the SDK cannot be reached. The labels match the screen's, and an
 * absent figure reads "N/A" as Qoder itself prints it — never a zero, which
 * would be a claim about the account nobody made.
 */
export function qoderUsageFromInfo(info: any): QoderUsage | undefined {
  if (!info || typeof info !== "object") return undefined;
  const rows: QoderUsageRow[] = [];
  const plan = typeof info.userType === "string" && info.userType.trim()
    ? info.userType.trim()[0].toUpperCase() + info.userType.trim().slice(1)
    : undefined;
  if (plan) rows.push({ label: "Plan", value: plan });
  let expiresOn: string | undefined;
  if (typeof info.expiresAt === "number" && Number.isFinite(info.expiresAt) && info.expiresAt > 0) {
    expiresOn = new Date(info.expiresAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    rows.push({ label: "Plan Expires At", value: expiresOn });
  }
  rows.push({ label: "Plan Credits Used", value: bucket(info.userQuota?.used, info.userQuota?.total) });
  rows.push({ label: "Add-on Credits Used", value: bucket(info.addOnQuota?.used, info.addOnQuota?.total) });
  const org = info.orgResourcePackage;
  if (org && (org.used !== undefined || org.cap !== undefined)) {
    rows.push({ label: "Org Resource Package", value: bucket(org.used, org.cap) });
  }
  const usage: QoderUsage = { rows };
  if (plan) usage.planName = plan;
  if (expiresOn) usage.expiresOn = expiresOn;
  return usage;
}
