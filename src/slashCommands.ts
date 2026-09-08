/**
 * Kiro's own slash commands.
 *
 * Kiro announces the whole list itself, as a `_kiro.dev/commands/available`
 * notification sent right after `session/new`. Everything here is derived from
 * that notification rather than hard-coded, so a Kiro update that adds a
 * command adds it to the menu without a change here.
 *
 * Free of `vscode` so `test/slashCommands.test.js` can drive it directly.
 */

/** One command, as Kiro describes it. */
export interface SlashCommand {
  /** The bare name — "compact", never "/compact". */
  name: string;
  description: string;
  /** Kiro's own argument hint, e.g. "add <path>, remove <path>, clear". */
  hint: string;
  subcommands: string[];
  /** Kiro asks us not to advertise this one. `stats` is the only one today. */
  hidden: boolean;
  /** The CLI answers this itself rather than the agent, so ACP cannot. */
  local: boolean;
}

/**
 * Commands the panel does not offer, and why.
 *
 * `paste` reads the CLI's clipboard, `voice` its microphone and `reply` opens
 * `$EDITOR` — none of which exist behind a webview, and all three would hang
 * or fail somewhere the user cannot see. `feedback` sends something outward
 * and there is no way to show what, which is not a thing to fire off from a
 * menu row. `quit` and `chat` are already excluded by `local`; they are named
 * here too so the reason survives if Kiro ever drops that flag — `quit` kills
 * the process the panel is talking to, and `chat` is a second, competing
 * conversation store next to the panel's own history.
 */
export const NOT_IN_PANEL = new Set([
  "paste",
  "voice",
  "reply",
  "feedback",
  "quit",
  "chat",
]);

/**
 * Why a command Kiro has is not one the panel will run.
 *
 * `/help` advertises the whole list, so someone will type one of these. The
 * alternative to answering is what the panel used to do: fail to recognise the
 * name, and send "/quit" to the model as a chat message — a prompt the user
 * never wrote, charged for, and answered with a guess about what they meant.
 */
export function reasonNotOffered(name: string): string {
  switch (name) {
    case "quit":
      return "closes the Kiro CLI, which this panel is talking to.";
    case "chat":
      return "saves and loads CLI conversations. This panel keeps its own history — use the chat list in the title bar.";
    case "paste":
      return "pastes from the CLI's own clipboard. Attach an image here instead, or paste one straight into the message box.";
    case "voice":
      return "needs the CLI's microphone.";
    case "reply":
      return "opens a text editor inside the CLI.";
    case "feedback":
      return "opens Kiro's feedback flow in the CLI.";
    default:
      return "is handled by the Kiro CLI itself rather than by the agent, so this panel cannot run it.";
  }
}

/** Read the `_kiro.dev/commands/available` payload. */
export function parseAvailableCommands(params: any): SlashCommand[] {
  const raw = params?.commands;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: SlashCommand[] = [];
  for (const entry of raw) {
    // Kiro sends the name with its slash. Ours never carry one, so that a
    // name is only ever spelled one way between here and `runCommand`.
    const name = String(entry?.name ?? "").replace(/^\//, "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const meta = entry?.meta ?? {};
    out.push({
      name,
      description: String(entry?.description ?? "").trim(),
      hint: String(meta?.hint ?? "").trim(),
      subcommands: Array.isArray(meta?.subcommands)
        ? meta.subcommands.map((s: unknown) => String(s))
        : [],
      hidden: meta?.hidden === true,
      local: meta?.local === true,
    });
  }
  return out;
}

/** May this command be run from the panel at all? */
export function isRunnable(command: SlashCommand): boolean {
  return !command.local && !NOT_IN_PANEL.has(command.name);
}

/**
 * What the menu lists. A hidden command stays runnable by typing its name in
 * full — Kiro marks `stats` hidden because it is a debugging aid, not because
 * it is off limits — but it is not put in front of anyone.
 */
export function offerable(commands: SlashCommand[]): SlashCommand[] {
  return commands.filter((c) => isRunnable(c) && !c.hidden);
}

/**
 * What to show for a command that answered.
 *
 * Several commands report through `data` and leave `message` empty — `rewind`,
 * `knowledge`, `goal` and `code` all did when measured against kiro-cli
 * 2.20.2 — so falling straight through to the message would show a blank
 * bubble for a command that worked perfectly well.
 */
export function describeCommandResult(
  name: string,
  result: { ok: boolean; data?: any; text?: string }
): string {
  const text = String(result?.text ?? "").trim();
  if (text) return text;

  const data = result?.data;
  if (data && typeof data === "object") {
    const message = String(data.message ?? "").trim();
    if (message) return message;
    // A single list is the usual shape, and its length is the whole answer.
    for (const [key, value] of Object.entries(data)) {
      if (!Array.isArray(value)) continue;
      const label = key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
      return value.length ? `${value.length} ${label}.` : `No ${label}.`;
    }
  }
  return result?.ok ? `/${name} finished.` : `/${name} did not run.`;
}

/** One entry in the rewind picker, as `/rewind` reports it. */
export interface RewindTurn {
  /** Kiro's index into its own conversation log; the value it wants back. */
  logIndex: number;
  /** The user's message that opened the turn. */
  label: string;
  /** How much of the context window the turn accounts for, e.g. "9%". */
  group: string;
  responseSnippet: string;
}

/** Read the turn list out of a `/rewind` result. Newest first, as Kiro sends it. */
export function parseRewindTurns(data: any): RewindTurn[] {
  const raw = data?.turns;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t) => Number.isFinite(Number(t?.logIndex)))
    .map((t) => ({
      logIndex: Number(t.logIndex),
      label: String(t?.label ?? "").trim(),
      group: String(t?.group ?? "").trim(),
      responseSnippet: String(t?.responseSnippet ?? "").trim(),
    }));
}

/**
 * How many turns survive a rewind to the turn at `index` in that list.
 *
 * Measured, not assumed: with ALPHA, BRAVO and CHARLIE in the log, rewinding
 * to BRAVO forked a session holding ALPHA *and* BRAVO. So the named turn is
 * kept and everything after it is dropped — and since Kiro sends the list
 * newest first, position 0 keeps all of them and the last position keeps one.
 */
export function turnsKeptByRewind(total: number, index: number): number {
  const count = Number.isInteger(total) && total > 0 ? total : 0;
  if (!Number.isInteger(index) || index < 0 || index >= count) return count;
  return count - index;
}
