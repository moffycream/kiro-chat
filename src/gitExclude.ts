/**
 * Keeping a file out of commits without telling anyone it exists.
 *
 * A memory file has to live in `.kiro/steering/` for Kiro to read it, which in
 * a shared repository means it is about to become everybody's. `.gitignore` is
 * the wrong tool: it is itself committed, so hiding your own notes would mean
 * pushing a line naming the file you were trying to keep to yourself, and
 * every teammate would carry the rule.
 *
 * `.git/info/exclude` does the same job from inside `.git/`, which is never
 * committed by definition. Measured in a scratch repository: the file sits in
 * the steering folder, `git status` shows nothing, `git add .` cannot stage
 * it, and no rule reaches anyone else.
 *
 * Free of `vscode` and of `child_process` — the paths and the file text are
 * decided here, the two `git` calls are made by the caller — so
 * `test/gitExclude.test.js` can drive all of it.
 */

import * as path from "node:path";

/**
 * Where the exclude file lives, given what `git rev-parse` reported.
 *
 * The argument must come from `--git-common-dir`, not `--git-dir`, and not a
 * `.git` joined onto the workspace root. In a worktree `.git` is a *file*
 * holding a pointer, so the naive join names nothing; and the worktree's own
 * gitdir has no `info/` directory at all. Measured: git honours the common
 * directory's `info/exclude` from inside a worktree. A naive implementation
 * works on the machine it was written on and fails for anyone using
 * worktrees, which is the worst way for this to break — the file silently
 * becomes committable.
 */
export function excludeFileIn(gitCommonDir: string): string {
  return path.join(gitCommonDir, "info", "exclude");
}

/**
 * How the file is spelled inside the exclude list.
 *
 * Relative to the repository root and forward-slashed, because that is what
 * git patterns are, on every platform. An absolute Windows path with
 * backslashes matches nothing and fails silently — the file stays visible and
 * the panel would have promised otherwise.
 */
export function excludeEntryFor(root: string, target: string): string {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return "";
  return relative.split(path.sep).join("/");
}

/**
 * Add the entry unless it is already there.
 *
 * Clicking twice, or opening a project a second time, must not grow the file
 * a line at a time. Comments are ignored when looking, so the note written
 * above the entry does not stop the entry being found next time.
 */
export function addExcludeEntry(
  contents: string,
  entry: string
): { contents: string; changed: boolean } {
  if (!entry) return { contents, changed: false };

  const has = contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .some((line) => line === entry);
  if (has) return { contents, changed: false };

  // Say who wrote it and why: this file is read by people wondering where a
  // rule came from, and an unexplained path is a small mystery to leave.
  const note = "# Kiro Chat: private memory, kept out of commits";
  const body = contents.length > 0 && !contents.endsWith("\n") ? contents + "\n" : contents;
  return { contents: `${body}${note}\n${entry}\n`, changed: true };
}
