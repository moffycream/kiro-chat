/**
 * Working out why Kiro would not start.
 *
 * There used to be one answer to this question — "you are not signed in" —
 * given for every failure between spawning the process and getting a session
 * id back. On a restart that is almost always wrong: the user was chatting
 * seconds ago, so they are signed in, and being sent to log in again hides
 * whatever actually broke.
 *
 * Kept free of any `vscode` import so it can be exercised on its own — see
 * `test/startupError.test.js`.
 */

/**
 * Phrases Kiro and its HTTP layer actually use when the login is the problem.
 * Anchored on word boundaries: "auth" as a loose substring appears in plenty
 * of unrelated messages, and matching it would put us straight back to
 * offering a login screen for no reason.
 */
const SIGN_IN_PATTERNS: RegExp[] = [
  /\bunauthori[sz]ed\b/i,
  /\b401\b/,
  /\bnot\s+logged\s+in\b/i,
  /\bnot\s+authenticated\b/i,
  /\bauthentication\s+(required|failed)\b/i,
  /\bcredentials?\b[^.]*\b(expired|invalid|missing)\b/i,
  /\binvalid[_\s-]?token\b/i,
  /\bexpired[_\s-]?token\b/i,
  /\b(please\s+)?sign\s+in\b/i,
  /\blogin\s+required\b/i,
];

export const KIRO_TOO_OLD = "This version of Kiro Chat needs Kiro CLI 3.0 or newer.";

/**
 * A Kiro too old to have the engine this panel speaks to refuses the flag and
 * exits, so the words on stderr are the only sign of why.
 */
export function needsNewerKiro(output: string): boolean {
  return /unexpected argument '--agent-engine'/i.test(String(output ?? ""));
}

/** What a pending request is told when the process dies. Says nothing of why. */
export const AGENT_STOPPED = "The Kiro agent stopped running.";

const STDERR_PREFIX = "[kiro stderr] ";

/** Lines Kiro writes on a healthy start, or that only decorate a real error. */
const STDERR_NOISE: RegExp[] = [
  /^\[(info|warn|warning|debug|trace)\]/i,
  /ExperimentalWarning/,
  /^\(Use `node --trace-warnings/,
  /^note: run with/i,
];

/**
 * The reason Kiro printed before exiting, or undefined if it printed none.
 *
 * Kiro reports a fatal error on stderr as `error:` followed by the reason,
 * sometimes on the next line, among ordinary log lines. Only what it wrote is
 * ever returned: with nothing readable, the caller keeps its own message.
 */
export function startupReason(log: readonly string[]): string | undefined {
  const lines = log
    .filter((entry) => String(entry).startsWith(STDERR_PREFIX))
    .flatMap((entry) => entry.slice(STDERR_PREFIX.length).split(/\r?\n/))
    .map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").trim())
    .filter((line) => line && !STDERR_NOISE.some((pattern) => pattern.test(line)));

  let reason = lines[lines.length - 1];
  for (let index = lines.length - 1; index >= 0; index--) {
    const match = /^(?:\[error\]\s*)?error:\s*(.*)$/i.exec(lines[index]);
    if (!match) continue;
    reason = match[1] || lines[index + 1];
    break;
  }
  const text = reason?.replace(/^\[error\]\s*/i, "").replace(/^error:\s*$/i, "").trim();
  return text ? text.slice(0, 500) : undefined;
}

/**
 * The failure to show. Only the bare "it stopped" is replaced: any other
 * message already says what went wrong, and stderr may hold an unrelated line.
 */
export function describeStartupFailure(message: string, log: readonly string[]): string {
  return message === AGENT_STOPPED ? (startupReason(log) ?? message) : message;
}

/** True when the failure really does look like a missing or stale login. */
export function looksLikeSignIn(message: string): boolean {
  const text = String(message ?? "");
  if (!text.trim()) return false;
  return SIGN_IN_PATTERNS.some((pattern) => pattern.test(text));
}
