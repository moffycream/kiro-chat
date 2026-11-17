/**
 * Where a new skill goes, and what is in it.
 *
 * The counterpart to `progressiveContext.ts`, which reads the skills Kiro
 * *reports*. This one answers the other half: the panel could list them and
 * not make one, so adding a skill meant creating a folder and a file by hand
 * in a place nothing on screen named.
 *
 * Measured against `kiro-cli acp --agent-engine v3` (3.1.0), and the second
 * measurement is what makes a plain "write the file" row enough: Kiro
 * **watches** the folder. A `SKILL.md` written two seconds into a live
 * session was re-announced about 600ms later, so nothing here has to tell the
 * panel to refresh and no new chat is needed.
 *
 * Free of `vscode` so `test/skillFiles.test.js` can drive it, per the rule
 * `memory.ts` follows — which is also the model for this whole file, because
 * a skill and a memory file are the same job: make something Kiro already
 * reads reachable, without building a second copy of it.
 */

import * as os from "node:os";
import * as path from "node:path";

export type SkillScope = "project" | "global";

export const SKILL_SCOPES: readonly SkillScope[] = ["project", "global"] as const;

/** The file inside a skill's folder. Kiro looks for this name exactly. */
export const SKILL_FILENAME = "SKILL.md";

/**
 * Read a scope out of a webview message, or refuse it.
 *
 * Nothing is substituted, for the reason `memoryTarget` gives: the shortcut
 * it replaces (`value === "global" ? "global" : "project"`) was right while
 * there were two scopes and silently wrong the moment a third existed, and
 * wrote a file the user had been promised somewhere else.
 */
export function skillScope(value: unknown): SkillScope | undefined {
  return SKILL_SCOPES.find((scope) => scope === value);
}

/** Kiro's skills folder under a project root. */
export function skillsDir(root: string): string {
  return path.join(root, ".kiro", "skills");
}

/** Kiro's skills folder for every project, under the user's home. */
export function globalSkillsDir(home: string = os.homedir()): string {
  return path.join(home, ".kiro", "skills");
}

export function skillScopeDir(scope: SkillScope, root: string, home?: string): string {
  return scope === "global" ? globalSkillsDir(home) : skillsDir(root);
}

/**
 * One skill is a folder holding a `SKILL.md`, not a loose file.
 *
 * That shape is Kiro's, not a convention invented here: the glob in the
 * default agent's resources names a folder per skill and a `SKILL.md` inside
 * it, so a loose `.kiro/skills/thing.md` is read by nothing.
 */
export function skillFilePath(
  scope: SkillScope,
  name: string,
  root: string,
  home?: string
): string {
  return path.join(skillScopeDir(scope, root, home), name, SKILL_FILENAME);
}

/** Windows cannot hold a file by any of these names, with or without a suffix. */
const RESERVED = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/**
 * Why this name cannot be a skill, or `undefined` if it can.
 *
 * Returned as the sentence to show rather than a boolean, because this feeds
 * `showInputBox`'s `validateInput`, which wants the reason or nothing. Every
 * rule here is a way the folder that gets created is not the folder that was
 * asked for, which is worse than a refusal: the panel would report a skill
 * under a name Kiro never sees.
 */
export function skillNameProblem(value: unknown): string | undefined {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) return "Give the skill a name.";
  if (name === "." || name === "..") return "That is a folder, not a name.";
  // One segment. A name carrying a separator would quietly nest the skill a
  // level deeper, where the glob does not look for it.
  if (/[\\/]/.test(name)) return "A skill name is one folder — no slashes.";
  if (/[<>:"|?*]/.test(name)) return 'Windows will not allow < > : " | ? * in a folder name.';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) return "That name has a control character in it.";
  /*
   * Windows silently strips a trailing dot, so `notes.` becomes `notes` — the
   * row would then name a skill that does not exist at the path it was given.
   * Refusing is the only way to say so. A trailing *space*, which Windows
   * strips too, cannot reach here: the name is trimmed above, because that is
   * the user being imprecise rather than asking for something impossible.
   */
  if (/\.$/.test(name)) return "A name cannot end in a dot on Windows.";
  if (RESERVED.has(name.toLowerCase().split(".")[0])) {
    return `"${name}" is a reserved device name on Windows.`;
  }
  if (name.length > 64) return "Keep the name under 64 characters.";
  return undefined;
}

/**
 * The starter file.
 *
 * It spells out the mechanism, because that is the thing nobody can guess
 * and it decides whether the skill ever runs: the two frontmatter lines are
 * in Kiro's context from the start of every turn, and the body is opened only
 * when the description fits what was asked. `memoryTemplate` writes its
 * `inclusion:` line for the same reason — a default left implicit is a
 * default nobody can adjust.
 *
 * The description is deliberately left as an unfinished sentence rather than
 * a plausible one. Kiro matches on that line, so a skill shipped with filler
 * there is a skill that never fires or fires at random; writing `TODO` means
 * the panel's own row says out loud that it still needs an answer.
 */
export function skillTemplate(name: string, scope: SkillScope): string {
  const where = scope === "global" ? "every project you open" : "this project";
  return [
    "---",
    `name: ${name}`,
    "description: TODO — say when Kiro should use this. Kiro matches on this line.",
    "---",
    "",
    `# ${name}`,
    "",
    "Write what Kiro should do when this skill applies.",
    "",
    `Available in ${where}. Kiro keeps the name and description above in`,
    "context on every turn and reads the rest of this file only when that",
    "description fits what you asked — so keep it specific, and put the",
    "detail down here where it costs nothing until it is needed.",
    "",
  ].join("\n");
}
