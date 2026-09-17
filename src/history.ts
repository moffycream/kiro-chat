/**
 * Past chats: naming them, grouping them by day, and working out which ones
 * belong to the folder that is open.
 *
 * Kept free of any `vscode` import so it can be exercised on its own — see
 * `test/history.test.js`. The records themselves are stored by the provider
 * in the extension's globalState; nothing here touches storage.
 */

import { normalisePath, samePath } from "./paths";

/** One turn as the webview records it. */
export interface HistoryItem {
  role: string;
  text?: string;
  attachments?: { kind: string; label: string }[];
  selection?: string;
  tools?: { title: string; status: string }[];
  /** What an agent turn cost, when Kiro reported it. */
  credits?: number;
}

/**
 * What a stored conversation has already cost, or `undefined` when that
 * cannot be known.
 *
 * Every turn's cost is stored beside it, so reopening a chat can pick the
 * total back up rather than counting from zero — which made the strip say
 * "0.2 cr" under a transcript showing 0.39 and 0.2. But a sum is only the
 * total when nothing is missing from it: a transcript trimmed to its tail has
 * lost turns, and a turn stored without a figure (a chat from before the
 * meter was read, or a reading that never came) cost something unknown.
 * Either way a sum would be too low and look exact, so the answer is none.
 */
export function creditsSpentIn(items: HistoryItem[], truncated = false): number | undefined {
  if (truncated) return undefined;
  let total = 0;
  for (const item of items ?? []) {
    if (item?.role !== "agent") continue;
    if (typeof item.credits !== "number" || !Number.isFinite(item.credits)) return undefined;
    total += item.credits;
  }
  return total;
}

export interface ChatRecord {
  /** Ours, and stable across saves. */
  id: string;
  /** Kiro's, so the conversation can actually be resumed. */
  sessionId?: string;
  /** The folder the chat happened in. Kiro binds a session to it. */
  cwd: string;
  title: string;
  updatedAt: number;
  messageCount: number;
  history: HistoryItem[];
  /** True when the stored transcript is only the tail of a longer chat. */
  truncated?: boolean;
}

const MAX_TITLE = 60;
const MAX_PREVIEW = 90;

/** Remove the newest turns, including their replies and tool records. */
export function removeLatestTurns(items: HistoryItem[], remove: number): HistoryItem[] {
  if (!Number.isInteger(remove) || remove < 0) throw new Error("Invalid checkpoint.");
  if (remove === 0) return items.slice();
  let remaining = remove;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].role === "user" && --remaining === 0) return items.slice(0, i);
  }
  return [];
}

/**
 * Name a chat after the first thing the user said. A message that carried
 * only attachments still counts — "screenshot.png" says more about the chat
 * than "New chat" does.
 */
export function titleFrom(history: HistoryItem[]): string {
  for (const item of history ?? []) {
    if (item?.role !== "user") continue;

    const firstLine = String(item.text ?? "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);

    if (firstLine) return clip(firstLine);

    const labels = (item.attachments ?? []).map((a) => a.label).filter(Boolean);
    if (labels.length > 0) return clip(labels.join(", "));
  }
  return "New chat";
}

function clip(text: string, max = MAX_TITLE): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "…";
}

/**
 * The name a chat keeps.
 *
 * A long chat is stored as its tail, so re-deriving the title from the saved
 * transcript renames it the moment the opening message falls out of the
 * window — the row in the list changes under the user for no reason they can
 * see. Once a chat has a real name it keeps it; only the placeholder is
 * allowed to be replaced.
 */
export function stableTitle(
  existing: string | undefined,
  history: HistoryItem[]
): string {
  const kept = String(existing ?? "").trim();
  if (kept && kept !== "New chat") return kept;
  return titleFrom(history);
}

/**
 * A line of the conversation to show under the title.
 *
 * Real chats open with whatever was on the user's mind — "fix this", "change
 * null to true" — so titles repeat, and a list of identical rows cannot be
 * told apart by name. The newest message is what actually distinguishes them.
 */
export function previewOf(history: HistoryItem[]): string {
  for (let i = (history ?? []).length - 1; i >= 0; i--) {
    const item = history[i];
    const line = String(item?.text ?? "")
      .split("\n")
      .map((part) => part.trim())
      .find((part) => part.length > 0);
    if (line) return clip(line, MAX_PREVIEW);
  }
  return "";
}

export interface DayGroup {
  label: string;
  records: ChatRecord[];
}

/**
 * Group into Today, Yesterday, then a plain date. The boundary is midnight,
 * not a rolling 24 hours: a chat at 11pm last night is Yesterday even though
 * it was only twelve hours ago, which is what a person means by it.
 */
export function groupByDay(records: ChatRecord[], now: number): DayGroup[] {
  const startOfDay = (time: number) => {
    const d = new Date(time);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const today = startOfDay(now);
  const DAY = 24 * 60 * 60 * 1000;

  const groups = new Map<number, ChatRecord[]>();
  for (const record of records ?? []) {
    const day = startOfDay(record.updatedAt);
    const bucket = groups.get(day);
    if (bucket) bucket.push(record);
    else groups.set(day, [record]);
  }

  return [...groups.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([day, list]) => ({
      label:
        day === today
          ? "Today"
          : day === today - DAY
            ? "Yesterday"
            : new Date(day).toLocaleDateString(undefined, {
                day: "numeric",
                month: "long",
                year: "numeric",
              }),
      records: [...list].sort((a, b) => b.updatedAt - a.updatedAt),
    }));
}

/** Chats that belong to the open folder. With no folder open, none do. */
export function forWorkspace(
  records: ChatRecord[],
  cwd: string | undefined
): ChatRecord[] {
  if (!cwd) return [];
  // Whole-path equality, so "kiro-chat-old" is never mistaken for "kiro-chat".
  return (records ?? []).filter((record) => samePath(record.cwd, cwd));
}

/**
 * Keep the newest `max` chats **per folder** and drop the rest.
 *
 * The list only ever shows one folder's chats, so a global cap means a busy
 * project quietly evicts a quiet one's history — the user loses chats from a
 * repo they have not touched in a week because of work done somewhere else.
 * Counting per folder makes the cap mean what the list shows.
 */
export function pruneHistory(records: ChatRecord[], max: number): ChatRecord[] {
  const limit = Math.max(0, max);
  const seen = new Map<string, number>();
  return [...(records ?? [])]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter((record) => {
      const folder = normalisePath(record.cwd);
      const count = seen.get(folder) ?? 0;
      if (count >= limit) return false;
      seen.set(folder, count + 1);
      return true;
    });
}

/** Save a chat, replacing any earlier save of the same one. */
export function upsertRecord(records: ChatRecord[], record: ChatRecord): ChatRecord[] {
  const rest = (records ?? []).filter((r) => r.id !== record.id);
  return [record, ...rest];
}
