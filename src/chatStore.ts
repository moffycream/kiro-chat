/**
 * Where past chats live: one file per chat, and a small index in globalState.
 *
 * Every chat used to sit in one `globalState` entry with its whole transcript,
 * and VS Code stores an extension's globalState as a single blob — so saving
 * one turn rewrote every stored chat. Measured on a real profile: 76 chats,
 * 4.4 MB, rewritten after each turn (and by any other globalState write, such
 * as an agent warning being remembered). Now a save writes that one chat's file
 * plus an index of titles and dates, a few kilobytes.
 *
 * The index is still re-read at write time rather than cached, for the reason
 * `flushChats` always gave: a second VS Code window shares it, and a cached copy
 * would write that window's chats out of the list.
 *
 * Free of `vscode` so `test/chatStore.test.js` drives it against a temp folder.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { ChatRecord, HistoryItem, previewOf, pruneHistory, upsertRecord } from "./history";

/** A chat without its transcript: what the history list and lookups need. */
export interface ChatIndexEntry extends Omit<ChatRecord, "history"> {
  /** The newest line, for the list. Kept here so drawing it reads no files. */
  preview: string;
}

/** The part of `vscode.Memento` this uses. */
export interface ChatMemento {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

/** The index. A new key, so an index is never mistaken for the old full list. */
export const CHAT_INDEX_KEY = "kiroChat.chatIndex";
/** Where every chat, transcript and all, used to be kept. Read once to move it. */
export const LEGACY_HISTORY_KEY = "kiroChat.history";

/** Chat ids are `freshId()`s; anything else is refused rather than used as a path. */
function fileNameFor(id: string): string | undefined {
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? `${id}.json` : undefined;
}

export function indexEntryOf(record: ChatRecord): ChatIndexEntry {
  const { history, ...rest } = record;
  return { ...rest, preview: previewOf(history ?? []) };
}

export class ChatStore {
  constructor(
    private readonly dir: string,
    private readonly memento: ChatMemento
  ) {}

  index(): ChatIndexEntry[] {
    return this.memento.get<ChatIndexEntry[]>(CHAT_INDEX_KEY, []);
  }

  find(id: string): ChatIndexEntry | undefined {
    return this.index().find((entry) => entry.id === id);
  }

  /**
   * A chat with its transcript. A listed chat whose file is gone or unreadable
   * still opens, with no messages, rather than vanishing from under the user.
   */
  load(id: string): ChatRecord | undefined {
    const entry = this.find(id);
    if (!entry) return undefined;
    const { preview: _preview, ...rest } = entry;
    return { ...rest, history: this.readHistory(id) };
  }

  /**
   * Write one chat and put it at the top of the index.
   *
   * The file first, so the index never points at a transcript that was not
   * written. Through a temporary file and a rename, so a crash mid-write leaves
   * the previous save rather than half a file. Chats the per-folder cap drops
   * lose their files as well.
   */
  save(record: ChatRecord, maxPerFolder: number): Thenable<void> | Promise<void> {
    this.writeHistory(record.id, record.history ?? []);
    const before = this.index();
    const kept = pruneHistory(upsertRecord(before, indexEntryOf(record)), maxPerFolder);
    const keptIds = new Set(kept.map((entry) => entry.id));
    for (const entry of before) {
      if (!keptIds.has(entry.id)) this.removeFile(entry.id);
    }
    return this.memento.update(CHAT_INDEX_KEY, kept);
  }

  remove(id: string): Thenable<void> | Promise<void> {
    this.removeFile(id);
    return this.memento.update(
      CHAT_INDEX_KEY,
      this.index().filter((entry) => entry.id !== id)
    );
  }

  /**
   * Move chats out of the old single entry, once.
   *
   * Every file is written and read back before the index is written, and the
   * old entry is cleared only after that — so a failure anywhere leaves the old
   * entry in place and the move is simply tried again next time. It has to be
   * cleared, not kept for safety: globalState is one blob, so 4 MB left in it
   * is 4 MB rewritten by every save that follows. A version of the extension
   * from before this change will therefore find no history.
   *
   * Answers how many chats were moved.
   */
  async migrate(): Promise<number> {
    const legacy = this.memento.get<ChatRecord[] | undefined>(LEGACY_HISTORY_KEY, undefined);
    if (!Array.isArray(legacy)) return 0;
    const moved: ChatIndexEntry[] = [];
    for (const record of legacy) {
      if (!record || typeof record.id !== "string" || !fileNameFor(record.id)) continue;
      const history = Array.isArray(record.history) ? record.history : [];
      this.writeHistory(record.id, history);
      if (this.readHistory(record.id).length !== history.length) {
        throw new Error(`Chat ${record.id} did not read back as written.`);
      }
      moved.push(indexEntryOf({ ...record, history }));
    }
    // Chats this window already saved in the new form win over their old copy.
    const current = this.index();
    const known = new Set(current.map((entry) => entry.id));
    const merged = [...current, ...moved.filter((entry) => !known.has(entry.id))];
    await this.memento.update(CHAT_INDEX_KEY, merged);
    await this.memento.update(LEGACY_HISTORY_KEY, undefined);
    return moved.length;
  }

  /**
   * Remove files no index entry points at, if they are old.
   *
   * Only old ones: another window writes its file a moment before its index
   * entry, and that file must not be taken for an orphan in between.
   */
  sweep(now: number, olderThanMs = 24 * 60 * 60 * 1000): number {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return 0;
    }
    const listed = new Set(this.index().map((entry) => `${entry.id}.json`));
    let removed = 0;
    for (const name of names) {
      if (!name.endsWith(".json") || listed.has(name)) continue;
      const full = path.join(this.dir, name);
      try {
        if (now - fs.statSync(full).mtimeMs < olderThanMs) continue;
        fs.unlinkSync(full);
        removed += 1;
      } catch {
        // Gone already, or in use: either way not ours to insist on.
      }
    }
    return removed;
  }

  private readHistory(id: string): HistoryItem[] {
    const name = fileNameFor(id);
    if (!name) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(this.dir, name), "utf8"));
      return Array.isArray(parsed?.history) ? parsed.history : [];
    } catch {
      return [];
    }
  }

  private writeHistory(id: string, history: HistoryItem[]): void {
    const name = fileNameFor(id);
    if (!name) throw new Error(`Not a chat id: ${id}`);
    fs.mkdirSync(this.dir, { recursive: true });
    const full = path.join(this.dir, name);
    const temp = `${full}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ id, history }), "utf8");
    fs.renameSync(temp, full);
  }

  private removeFile(id: string): void {
    const name = fileNameFor(id);
    if (!name) return;
    try {
      fs.unlinkSync(path.join(this.dir, name));
    } catch {
      // Already gone is the state we wanted.
    }
  }
}
