/**
 * The context figure Kiro saved for a conversation after its last real request.
 *
 * Reopening a chat, Kiro sends `_kiro.dev/metadata` with a `contextUsagePercentage`
 * — and that figure is an estimate built from the conversation's text alone.
 * Measured against kiro-cli 2.21.4, for one session whose five turns had ended
 * at 7.14, 8.18, 8.26, 8.78 and 9.06 percent, every load reported 4.88: in a
 * fresh process, and again in one that had just loaded it. `/context` gives the
 * same 4.88, so it is not a second opinion. A small chat fared worse — 2.78%
 * after its last reply, about 1% on reopening.
 *
 * The real figure is on disk. `~/.kiro/sessions/cli/<id>.json` holds
 * `session_state.conversation_metadata.last_context_usage.percentage`, which
 * matched the last turn's `final_context_usage_percentage` in every session
 * checked, and is what the strip showed before the chat was closed.
 *
 * This is Kiro's internal file, not a protocol, so everything here answers
 * `undefined` rather than guess: a missing file, a shape that has moved, a
 * number out of range. Kept free of `vscode` so the tests can drive it.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Only an id Kiro could have issued, so a stored value cannot walk the filesystem. */
const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;

export function sessionFilePath(sessionId: string, home: string = os.homedir()): string | undefined {
  if (!SESSION_ID.test(sessionId)) return undefined;
  return path.join(home, ".kiro", "sessions", "cli", `${sessionId}.json`);
}

/** The saved percentage out of a session file's text, when it is there and sane. */
export function savedContextPercentFrom(text: string): number | undefined {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const value = raw?.session_state?.conversation_metadata?.last_context_usage?.percentage;
  // `null` is what a session that never made a request holds; it is not 0.
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    return undefined;
  }
  return value;
}

export function savedContextPercent(
  sessionId: string,
  home: string = os.homedir()
): number | undefined {
  const file = sessionFilePath(sessionId, home);
  if (!file) return undefined;
  try {
    return savedContextPercentFrom(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}
