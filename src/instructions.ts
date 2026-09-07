/**
 * Standing instructions: how you always want Kiro to work.
 *
 * Distinct from memory, and the distinction is the whole point. A memory file
 * holds *facts* Kiro should know — "this project uses pnpm" — and lives on
 * disk because that is the only thing Kiro reads. An instruction is a
 * *directive* it should follow — "always write the test first" — and needs no
 * file at all: the extension already puts instruction text in front of a
 * message, which is exactly how the Spec and Bug Fix workflows work. This is
 * the same mechanism with the user holding the pen.
 *
 * So nothing is written to disk. The text lives in `kiroChat.instructions`,
 * which means it syncs with Settings Sync and can be edited from the settings
 * UI as well as from the panel.
 *
 * Free of `vscode` so `test/instructions.test.js` can drive it, per the rule
 * the other logic modules follow.
 */

import { ContentBlock } from "./kiroSession";

/**
 * The cap, and why there is one.
 *
 * This text rides in *every* message, so unlike a memory file — which Kiro
 * opens when it wants it — its length is paid for on every turn, against the
 * credits the panel shows. Long enough for a page of standing directions,
 * short enough that nobody funds a novel by accident.
 */
export const MAX_INSTRUCTIONS_CHARS = 4000;

/**
 * Tidy what the user typed without changing what they meant.
 *
 * Trailing whitespace on each line and runs of blank lines are noise that
 * costs tokens every turn; the words are left exactly as written. Line
 * endings are normalised because the box, the setting and the prompt can
 * disagree about them and `\r` is not free either.
 */
export function normaliseInstructions(text: unknown): string {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Cut over-long instructions, and say that they were cut. */
export function clipInstructions(
  text: string,
  max = MAX_INSTRUCTIONS_CHARS
): { text: string; truncated: boolean } {
  const value = normaliseInstructions(text);
  if (value.length <= max) return { text: value, truncated: false };
  return { text: value.slice(0, max).trimEnd(), truncated: true };
}

/**
 * Put the user's standing instructions in front of the message.
 *
 * Prepended *outside* whatever `applyChatMode` added, so the workflow block
 * still sits directly against the request it introduces — that block ends
 * "The user's request follows", and slipping anything between the two would
 * make it untrue.
 *
 * Empty instructions add no block at all. An empty one would be a line of
 * prompt saying nothing, charged for on every turn.
 */
export function applyInstructions(blocks: ContentBlock[], text: unknown): ContentBlock[] {
  const { text: body } = clipInstructions(String(text ?? ""));
  if (!body) return blocks;
  return [
    {
      type: "text",
      text: `[Kiro Chat: standing instructions from the user]\n${body}\n\nFollow these in every reply unless the user says otherwise.`,
    },
    ...blocks,
  ];
}

/** One line of text, cut to fit and marked when it was. */
function clipLine(line: string, max: number): string {
  return line.length <= max ? line : line.slice(0, Math.max(1, max - 1)).trimEnd() + "…";
}

/**
 * The menu row: the instructions themselves, in the two slots a row has.
 *
 * No "Your instructions" label. The group heading above already says
 * Instructions, and repeating it in the row costs a line to say nothing —
 * while the thing actually worth reading, which is what is being applied to
 * every message you send, gets pushed into small grey text underneath.
 *
 * So the first instruction *is* the label, and the rest sit below it as the
 * description. With nothing set the row becomes an invitation instead, the
 * way the "Add project memory" rows do, because a row reading "None yet" is a
 * statement where a control belongs.
 *
 * Clipped on whole instructions wherever one fits: a preview that stops
 * mid-sentence is a preview of something the user did not write.
 */
export function instructionsRow(
  text: unknown,
  max = 48
): { label: string; detail: string } {
  const lines = normaliseInstructions(text)
    .split("\n")
    .filter((line) => line.trim());
  if (lines.length === 0) return { label: "Add instructions", detail: "" };

  const [first, ...rest] = lines;
  if (rest.length === 0) return { label: clipLine(first, max), detail: "" };

  let detail = "";
  for (const line of rest) {
    const next = detail ? `${detail} · ${line}` : line;
    if (next.length > max) break;
    detail = next;
  }
  // Every remaining instruction is too long to add whole, so cut the first of
  // them rather than showing nothing where there is more to see.
  if (!detail) detail = clipLine(rest[0], max);
  else if (detail.split(" · ").length < rest.length) detail += " …";

  return { label: clipLine(first, max), detail };
}
