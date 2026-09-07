/**
 * Where Kiro's own memory lives, and what to put in a new one.
 *
 * This does not implement memory. Kiro CLI already loads these files into
 * every turn by itself — measured against `kiro-cli acp` 2.20.2 by asking for
 * a fact that exists nowhere else and watching it answer with **zero tool
 * calls**, which is what proves the text was already in the prompt rather
 * than read on demand. Four placements were confirmed:
 *
 *   - `.kiro/steering/*.md` in the project
 *   - `~/.kiro/steering/*.md` for every project
 *   - `AGENTS.md` in the project root
 *   - a steering file with no frontmatter at all
 *
 * So the extension's job here is only to make those files *reachable* — the
 * panel gave no sign they existed, which is the whole gap. Building a second
 * memory system on top would pay for the same text twice: once in Kiro's
 * context and again in ours.
 *
 * Free of `vscode` so `test/memory.test.js` can drive it, per the rule the
 * other logic modules follow.
 */

import * as os from "node:os";
import * as path from "node:path";

import { samePath } from "./paths";

export type MemoryScope = "project" | "global";

/** One file Kiro is reading as memory right now. */
export interface MemoryFile {
  scope: MemoryScope;
  path: string;
  /** Basename, for the menu. The full path stays in the tooltip. */
  label: string;
  /** Which chats it applies to, under the name. Filled in by the provider. */
  detail?: string;
}

/**
 * Which chats a file steers, in the words the menu uses.
 *
 * Two files can share a basename — `memory.md` exists in both scopes — so the
 * row needs this to be about anything at all. Deleting the wrong one of two
 * identically named rows is exactly the mistake worth designing out.
 *
 * Global says "this machine only" because the add rows mark the local file
 * "(not committed)", which would otherwise imply the other two *are*. Project
 * memory is; global memory is not, and for a different reason — it lives in
 * the home directory, outside any repository. Saying so keeps the qualifier
 * on the local row from misleading about this one.
 */
export function scopeLabel(scope: MemoryScope): string {
  return scope === "global" ? "Global memory · this machine only" : "Project memory";
}

/**
 * The local file's row, which is the only one making a promise about git.
 *
 * So it is the only one that asks: `ignored` comes from `git check-ignore`,
 * not from having written the exclude entry. A file committed before it was
 * excluded is still tracked, and no ignore rule touches a tracked file —
 * precisely the case where the reassuring half would be false.
 */
export function localLabel(ignored: boolean): string {
  return ignored ? "Local memory · not committed" : "Local memory · git can see this";
}

/**
 * The file the button creates when there is nothing yet.
 *
 * `memory.md` rather than `AGENTS.md`, although Kiro reads both. `AGENTS.md`
 * sits at the repo root, is read by other tools and by people, and is the
 * kind of thing that gets committed — creating one because somebody clicked a
 * menu row is a larger side effect than the click implies. A file inside
 * `.kiro/steering/` is unambiguously Kiro's, and lives where the rest of its
 * configuration already does.
 */
export const MEMORY_FILENAME = "memory.md";

/**
 * The same idea, kept out of commits.
 *
 * It has to sit in `.kiro/steering/` like any other memory file, because that
 * is the only place Kiro reads — so in a shared repository it is one `git add`
 * away from being everybody's. The name marks it, and `gitExclude.ts` makes
 * git blind to it. `.local.` follows the convention the surrounding tooling
 * already uses for "mine, not the team's".
 */
export const PRIVATE_MEMORY_FILENAME = "memory.local.md";

/**
 * What the panel can create, which is not the same as where files live.
 *
 * There are two folders — `MemoryScope` — and three files worth offering,
 * because the private one shares the project folder and differs only by name.
 * Listing walks folders; adding names a file.
 */
export type MemoryTarget = MemoryScope | "private";

/** The folder a target lands in. Private memory is project memory. */
export function targetScope(target: MemoryTarget): MemoryScope {
  return target === "global" ? "global" : "project";
}

export const MEMORY_TARGETS: readonly MemoryTarget[] = ["project", "private", "global"] as const;

/**
 * Read a target out of a webview message, or refuse it.
 *
 * This exists because the shortcut it replaces shipped broken. The handler
 * said `scope === "global" ? "global" : "project"`, which was right while
 * there were two targets and quietly wrong the moment there were three:
 * `"private"` is not `"global"`, so it became `"project"` and the button made
 * an ordinary `memory.md` with no git rule — a file the user had been told
 * would never be committed. A default that swallows an unrecognised value
 * cannot report that anything went wrong.
 *
 * So nothing is substituted. An unknown target is refused, the way
 * `gatesForMode` refuses a mode it does not know, and the caller says so.
 */
export function memoryTarget(value: unknown): MemoryTarget | undefined {
  return MEMORY_TARGETS.find((target) => target === value);
}

export function targetPath(target: MemoryTarget, root: string, home?: string): string {
  const name = target === "private" ? PRIVATE_MEMORY_FILENAME : MEMORY_FILENAME;
  return path.join(memoryDir(targetScope(target), root, home), name);
}

/** True for a file the panel would have excluded from git when it made it. */
export function isPrivateMemory(filePath: string): boolean {
  return path.basename(String(filePath ?? "")).toLowerCase() === PRIVATE_MEMORY_FILENAME;
}

/** Kiro's steering folder under a project root. */
export function steeringDir(root: string): string {
  return path.join(root, ".kiro", "steering");
}

/** Kiro's steering folder for every project, under the user's home. */
export function globalSteeringDir(home: string = os.homedir()): string {
  return path.join(home, ".kiro", "steering");
}

export function memoryDir(scope: MemoryScope, root: string, home?: string): string {
  return scope === "global" ? globalSteeringDir(home) : steeringDir(root);
}

export function memoryFilePath(scope: MemoryScope, root: string, home?: string): string {
  return path.join(memoryDir(scope, root, home), MEMORY_FILENAME);
}

/**
 * Which files in a steering listing Kiro will actually read.
 *
 * Markdown only, and dotfiles left out so an editor's swap file or a
 * `.DS_Store` is not reported to the user as something Kiro is reading.
 * Sorted so the menu does not reshuffle between openings.
 */
export function memoryFilesIn(dir: string, names: string[], scope: MemoryScope): MemoryFile[] {
  return names
    .filter((name) => name.toLowerCase().endsWith(".md") && !name.startsWith("."))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ scope, path: path.join(dir, name), label: name }));
}

/**
 * Whether a path is one of the files the panel is currently listing.
 *
 * The guard on removal. A path arriving in a webview message is not a licence
 * to delete anything on disk — the same rule `setSetting` applies to an
 * untrusted settings key. The list is rebuilt from the folders at the moment
 * of the click rather than trusted from the message, so a stale panel cannot
 * name a file that is no longer memory, and a crafted message cannot name one
 * that never was.
 */
export function isListedMemory(target: string, files: MemoryFile[]): boolean {
  if (!target) return false;
  // samePath, not a string compare: Windows spells one file several ways, and
  // a guard that misses a spelling is a guard that refuses a real click.
  return files.some((f) => samePath(f.path, target));
}

/**
 * The starter file.
 *
 * The frontmatter is not required — a bare `.md` in the steering folder is
 * included, which was measured rather than assumed. It is written anyway
 * because it is the only place the user finds out the knob exists: `always`
 * is what they have, and `fileMatch` and `manual` are what they can change it
 * to. A default left implicit is a default nobody can adjust.
 */
export function memoryTemplate(target: MemoryTarget): string {
  const where = target === "global" ? "every project you open" : "this project";
  return [
    "---",
    "inclusion: always",
    "---",
    "",
    `# Kiro memory (${target})`,
    "",
    `Kiro reads this file at the start of every turn in ${where}.`,
    "Write the things you would otherwise repeat in each chat.",
    "",
    // Only on the private one, and stated as what was done rather than as a
    // promise: the entry is written when the file is made, and the panel says
    // separately whether git actually honours it.
    ...(target === "private"
      ? [
          "This file is listed in `.git/info/exclude`, which lives inside `.git`",
          "and is never committed — so it stays here without reaching the repo.",
          "",
        ]
      : []),
    "Change `inclusion` above to `fileMatch` to load this only alongside",
    "certain files, or to `manual` to load it only when you ask.",
    "",
    "## Notes",
    "",
    "- ",
    "",
  ].join("\n");
}
