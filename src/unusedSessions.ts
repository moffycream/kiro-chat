/**
 * Empty sessions, and how they are taken back.
 *
 * `session/new` writes `~/.kiro/sessions/cli/<id>.json` and an empty `.jsonl`
 * the moment it is called — measured against kiro-cli 2.21, not read from
 * docs — so every connection leaves a conversation on disk whether or not
 * anybody says anything into it. The panel connects when it opens, `+`
 * connects again, and reopening a past chat used to connect before loading,
 * which is how one machine collected forty empty sessions beside the real
 * ones. Most of that is fixed by not creating them (`connect` without
 * `createSession`, and `+` reusing a session nothing was said into); this is
 * for the rest, because a session the user never speaks into cannot be
 * predicted — opening the panel and then closing the window is the ordinary
 * way to make one.
 *
 * Kiro deletes its own sessions: `kiro-cli chat --delete-session <id>`. It is
 * used rather than unlinking the files because Kiro keeps two stores and only
 * it knows about both. `--session-source v2` names the one ACP writes; without
 * it the command also searches the older sqlite store, which measured at 20-30
 * seconds against 2 for v2.
 *
 * Free of `vscode`, so `test/unusedSessions.test.js` drives it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Where the ids we created and nobody spoke into are remembered. */
export const UNUSED_SESSIONS_KEY = "kiroChat.unusedSessions";

/**
 * How many we are willing to carry. A list that only grows would keep asking
 * Kiro about ids it has long forgotten; the oldest are dropped rather than
 * deleted, because forgetting one costs a stray file and getting one wrong
 * costs a conversation.
 */
export const MAX_UNUSED = 50;

/**
 * How many are handed back per connection. Each delete is a `kiro-cli` of its
 * own and takes about two seconds, so a long list is worked through over
 * several starts rather than spending a minute of background CPU on the one
 * that happens to find it.
 */
export const MAX_PER_SWEEP = 10;

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Only Kiro's own ids may be passed to a delete.
 *
 * The id reaches us over JSON-RPC and ends up on a command line, so it is
 * checked for shape rather than trusted. Nothing else about this file is
 * dangerous; this is.
 */
export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value);
}

export function rememberUnused(list: readonly unknown[], id: string): string[] {
  if (!isSessionId(id)) return list.filter(isSessionId);
  const kept = list.filter(isSessionId).filter((known) => known !== id);
  kept.push(id);
  return kept.slice(-MAX_UNUSED);
}

export function forgetUnused(list: readonly unknown[], id: string): string[] {
  return list.filter(isSessionId).filter((known) => known !== id);
}

/** The session files Kiro writes for one conversation. */
export function sessionLogPath(sessionId: string, home: string = os.homedir()): string {
  return path.join(home, ".kiro", "sessions", "cli", `${sessionId}.jsonl`);
}

/**
 * Proof that a session holds nothing — the one gate on every delete.
 *
 * The remembered list is a hint and cannot be better than that: two VS Code
 * windows share one `globalState`, so a read-modify-write in each can lose the
 * removal that marked a session as spoken into. Rather than make the list
 * authoritative, every delete is checked against the conversation log itself,
 * which is the thing being claimed empty. Kiro appends one JSON line per turn,
 * so nothing was ever said exactly when that file is zero bytes.
 *
 * Anything unreadable, missing, or non-empty answers false: the failure that
 * matters here is deleting a conversation, and "I could not tell" must never
 * round towards it.
 */
export function isEmptySession(sessionId: string, home?: string): boolean {
  if (!isSessionId(sessionId)) return false;
  try {
    return fs.statSync(sessionLogPath(sessionId, home)).size === 0;
  } catch {
    return false;
  }
}

/** `kiro-cli chat --delete-session <id> --session-source v2`, reached the way the agent is. */
export function deleteSessionArgs(launchArgs: readonly string[], sessionId: string): string[] {
  return [...launchArgs, "chat", "--delete-session", sessionId, "--session-source", "v2"];
}

/**
 * `busy` is the answer that must not be treated as failure: Kiro refuses to
 * delete a session held by a live process, which is exactly what another
 * window's open panel looks like. That one is kept and tried again later.
 * Everything else is dropped — an old Kiro without the flag would otherwise
 * be asked forever, once per start.
 */
export type DeleteOutcome = "deleted" | "busy" | "failed";

export function readDeleteOutcome(code: number | null, output: string): DeleteOutcome {
  const text = String(output ?? "");
  if (/active in another process/i.test(text)) return "busy";
  if (code === 0) return "deleted";
  return "failed";
}
