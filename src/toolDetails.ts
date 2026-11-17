/**
 * What a step was given and what it gave back.
 *
 * The steps list named each step and said nothing about it, so "Read File"
 * was as much as the panel would ever tell you — which file, and what came
 * back, were in the payload and thrown away.
 *
 * Measured by driving `kiro-cli acp --agent-engine v3` (3.1.0) through a real
 * turn and capturing every `tool_call` / `tool_call_update`:
 *
 *   tool_call        title "Read File", kind, status, rawInput, locations
 *   tool_call_update status, rawInput, locations
 *   tool_call_update status, rawInput, **rawOutput**
 *
 * So the input is there from the first notification and the output arrives
 * only on the terminal one, which is why the webview merges rather than
 * replaces. `rawInput` was an object (`{path, offset, limit}`) and
 * `rawOutput` a string; both are formatted here rather than in the webview,
 * so a huge file read is capped before it is posted across.
 *
 * Free of `vscode` so `test/toolDetails.test.js` can drive it.
 */

/** Formatted and ready to show, with a flag when there was more. */
export interface ToolValue {
  text: string;
  /** True when the text stops short of the whole value. */
  clipped?: boolean;
}

/**
 * How much of one value to carry.
 *
 * A step can read a whole file, and the output of one `read` is already
 * larger than every other thing the panel holds about a turn. This is enough
 * to see what happened and nowhere near enough to matter — and it is applied
 * before `postMessage`, not in the webview, because the cost is the copy.
 */
export const MAX_DETAIL_CHARS = 4000;

/**
 * Kiro's own note on *why* it is running a step, which the row already shows
 * on its own line. Left out of the input block so it is not said twice.
 */
const PURPOSE_KEY = "__tool_use_purpose";

/**
 * One value, formatted — or nothing, when there is nothing worth a block.
 *
 * `null` and `undefined` are nothing. An empty string and an empty object
 * are nothing too: a block headed "Output" holding `{}` says less than no
 * block at all, and the row would grow a disclosure that opens onto blank
 * space.
 */
export function formatToolValue(value: unknown, maxChars = MAX_DETAIL_CHARS): ToolValue | undefined {
  if (value === null || value === undefined) return undefined;

  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (typeof value === "number" || typeof value === "boolean") {
    text = String(value);
  } else {
    const trimmed = stripPurpose(value);
    if (trimmed === undefined) return undefined;
    try {
      text = JSON.stringify(trimmed, null, 2);
    } catch {
      // A circular or otherwise unprintable payload. Nothing to show beats a
      // thrown error inside a notification handler.
      return undefined;
    }
    if (text === undefined) return undefined;
  }

  text = text.replace(/\r\n/g, "\n").trim();
  if (!text || text === "{}" || text === "[]" || text === '""') return undefined;
  if (text.length <= maxChars) return { text };
  return { text: text.slice(0, maxChars), clipped: true };
}

/**
 * The input without Kiro's purpose note, and without the keys it left empty.
 *
 * `{"path": "hello.txt", "offset": null, "limit": null}` is what a read
 * actually sends; two thirds of that block is the arguments it did not use.
 * Only the top level is pruned — anything nested is the tool's own structure
 * and is not ours to tidy.
 */
function stripPurpose(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (key === PURPOSE_KEY) continue;
    if (inner === null || inner === undefined) continue;
    out[key] = inner;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
