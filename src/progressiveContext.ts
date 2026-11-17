/**
 * What Kiro loads only when it becomes relevant.
 *
 * Kiro CLI 3 reads `.kiro/skills/<name>/SKILL.md` out of the workspace and
 * the same shape out of the user's own `.kiro`, and announces the lot on
 * `_kiro/progressive_context/items_changed`. Measured against 3.1.0 by
 * driving `kiro-cli acp --agent-engine v3` in a folder holding one skill:
 *
 * ```json
 * { "sessionId": "sess_…", "status": "success", "items": [{
 *     "name": "greet", "type": "skill", "scope": "workspace",
 *     "description": "Use when the user asks to be greeted…",
 *     "uri": "file:///C:/…/.kiro/skills/greet/SKILL.md",
 *     "_meta": { "kiro": { "resource": { "resourceType": "skill" } } } }] }
 * ```
 *
 * "Progressive" is the whole point and is why the panel can show these at
 * all: the same session reported the file under `contextFiles` with
 * `tokens: 0` and `progressivelyLoaded: true`, so only the name and the
 * description sit in context until Kiro decides the description fits what
 * was asked. A skill is therefore not a file the user chose to send — it is
 * one Kiro may reach for — which is why these rows say what they are for
 * rather than only naming a path.
 *
 * Free of `vscode` so the tests can drive it against the captured payload.
 */

export interface KiroSkill {
  name: string;
  /** What it is for — the half Kiro matches against the request. */
  description?: string;
  /** Kiro's own word: `workspace`, `global`, or something newer. */
  scope?: string;
  /** The `SKILL.md`, where the item names a file at all. */
  path?: string;
}

/**
 * The skills in Kiro's latest report, or `undefined` for one that cannot be
 * read.
 *
 * The difference matters: an empty array means Kiro says there are none, and
 * `undefined` means it said nothing legible. Answering `[]` to both would let
 * one malformed notification empty a list that is still true — the rule
 * `isStaleLock` and `readFacts` already follow, that a reading which failed
 * is not evidence about the thing being read.
 */
export function readProgressiveContext(params: unknown): KiroSkill[] | undefined {
  const items = (params as { items?: unknown })?.items;
  if (!Array.isArray(items)) return undefined;

  const skills: KiroSkill[] = [];
  for (const raw of items) {
    const item = raw as Record<string, any> | undefined;
    if (!item || typeof item !== "object") continue;
    /*
     * `items` is not promised to hold skills alone — the notification is
     * about progressive context, and `type` is there to say which kind each
     * item is. Anything unrecognised is left out rather than drawn as a
     * skill: a row naming something the panel has mislabelled is worse than
     * a row that is not there.
     */
    const kind = item.type ?? item._meta?.kiro?.resource?.resourceType;
    if (kind !== "skill") continue;

    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!name) continue;

    const skill: KiroSkill = { name };
    const description =
      typeof item.description === "string" ? item.description.trim() : "";
    if (description) skill.description = description;
    const scope = typeof item.scope === "string" ? item.scope.trim() : "";
    if (scope) skill.scope = scope;
    const path = fsPathFromFileUri(item.uri);
    if (path) skill.path = path;
    skills.push(skill);
  }
  return skills;
}

/**
 * The file a `file://` URI names, or nothing.
 *
 * A bundled skill is announced with a `builtin:` URI — the steering
 * documents in the same handshake are — so there is not always a file to
 * open, and a row that opens nothing has to know that about itself rather
 * than finding out when the click fails. Only `file://` is accepted, for
 * the reason `canReadSelectionFrom` is an allow-list.
 */
export function fsPathFromFileUri(uri: unknown): string | undefined {
  if (typeof uri !== "string") return undefined;
  const match = /^file:\/\/(?:localhost)?\/(.*)$/i.exec(uri.trim());
  if (!match) return undefined;
  let rest = match[1];
  if (!rest) return undefined;
  try {
    rest = decodeURIComponent(rest);
  } catch {
    // A URI the engine escaped in some way we cannot undo. Better to show no
    // path than a wrong one.
    return undefined;
  }
  // `file:///C:/x` keeps its drive letter; a UNC-style `file://server/share`
  // never reaches here, because the pattern needs the third slash.
  if (!/^[a-zA-Z]:/.test(rest)) rest = "/" + rest;
  // Windows-only extension, and every other path the menu shows is spelled
  // the way the platform spells it.
  return rest.replace(/\//g, "\\");
}
