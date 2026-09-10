/**
 * Kiro's per-session lock files, and deciding when one is a leftover.
 *
 * Kiro CLI writes `~/.kiro/sessions/cli/<id>.lock` holding the pid that opened
 * the session and when it did so. On `session/load` it reads that back and
 * refuses if the pid is still alive. It never compares the *start time* it
 * stored, so a pid Windows has since handed to something else reads as the
 * original owner and the conversation can never be reopened — the failure this
 * module exists to undo.
 *
 * `AcpClient.stop` kills the agent with `taskkill /t /f`, so Kiro is never
 * given the chance to remove its own lock. Every session the panel opens
 * leaves one behind; almost all of them are harmless, because the pid is dead
 * and Kiro's check passes. It is only the recycled ones that bite.
 *
 * Free of `vscode`, and the process lookup arrives as data rather than being
 * performed here, so `test/sessionLocks.test.js` can drive every branch.
 */
import * as os from "node:os";
import * as path from "node:path";

/** What Kiro writes into a lock file. */
export interface SessionLock {
  pid: number;
  /** When the owning process claimed the session, if it said. */
  startedAt?: Date;
}

/** What we could learn about the process a lock names. */
export interface ProcessFacts {
  running: boolean;
  /** Executable name without extension, lowercased, when it could be read. */
  image?: string;
  /** When the process itself started, when it could be read. */
  startedAt?: Date;
}

/**
 * The image name Kiro's own agent runs under.
 *
 * A Kiro session lock is held by a Kiro process or by nothing at all, so a pid
 * that resolves to anything else is proof of reuse without needing a clock.
 */
export const KIRO_IMAGE = "kiro-cli";

/**
 * How far a process may appear to predate its own lock before the comparison
 * is treated as clock noise rather than as evidence.
 *
 * The genuine owner always starts *before* it writes the lock, so any positive
 * difference is suspicious; a second of slack keeps a coarse timer or a
 * rounded timestamp from condemning a process that really is the owner.
 */
const START_SKEW_MS = 1000;

/** Where Kiro keeps the lock for one session. */
export function sessionLockPath(sessionId: string, home: string = os.homedir()): string {
  return path.join(home, ".kiro", "sessions", "cli", `${sessionId}.lock`);
}

/**
 * Read a lock file's contents.
 *
 * Returns undefined for anything it cannot make sense of, because a lock we
 * cannot read is one we must not act on: the whole point of this module is to
 * delete a file only when there is positive evidence it is dead.
 */
export function parseSessionLock(text: string): SessionLock | undefined {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const pid = Number(raw?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;

  const startedAt = parseTimestamp(raw?.started_at ?? raw?.startedAt);
  return startedAt ? { pid, startedAt } : { pid };
}

/**
 * The pid out of Kiro's refusal, when that is what went wrong.
 *
 * The text arrives as the `data` of a JSON-RPC -32603, whose `message` is the
 * generic "Internal error" — matching on this sentence is the only way to tell
 * this failure from every other internal error, and a wrong match would have
 * us delete a lock over an unrelated fault.
 */
export function lockedPidFrom(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const hit = /session is active in another process\s*\(\s*pid[:\s]*(\d+)\s*\)/i.exec(text);
  if (!hit) return undefined;
  const pid = Number(hit[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Whether the lock provably belongs to a process that is gone.
 *
 * Three ways to be sure, and everything else is a refusal. The default has to
 * be "leave it alone": deleting a live session's lock lets two agents write
 * one conversation, which is a worse failure than the one being fixed, and it
 * cannot be noticed from the panel.
 */
export function isStaleLock(lock: SessionLock, facts: ProcessFacts): boolean {
  // Nothing is running under that number.
  if (!facts.running) return true;

  // Something is, but it is not Kiro — so it cannot be holding a Kiro session.
  if (facts.image && facts.image.toLowerCase() !== KIRO_IMAGE) return true;

  /*
   * It is a Kiro, but a *newer* one than the lock. The process that took the
   * lock must have been running before it wrote it, so one that started
   * afterwards is a different process wearing a reissued number.
   */
  if (facts.startedAt && lock.startedAt) {
    return facts.startedAt.getTime() - lock.startedAt.getTime() > START_SKEW_MS;
  }

  // A running Kiro we cannot date. Assume it means it.
  return false;
}

/** Tolerant of the nanosecond precision Kiro writes, and of nothing at all. */
function parseTimestamp(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value) return undefined;
  // Trim any fraction to the three digits Date is specified to accept.
  const trimmed = value.replace(/\.(\d{3})\d+/, ".$1");
  const at = new Date(trimmed);
  return Number.isNaN(at.getTime()) ? undefined : at;
}
