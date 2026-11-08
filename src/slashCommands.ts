/**
 * The panel's slash commands.
 *
 * The v3 engine has no command endpoint: `_kiro.dev/commands/execute` is
 * refused, and text like `/usage` goes to the model as a prompt and is charged
 * for. So this list is the panel's own, and each entry is answered by something
 * v3 does have — see `KiroSession.runCommand`.
 *
 * Free of `vscode` so `test/slashCommands.test.js` can drive it directly.
 */

/** One command the composer knows about. */
export interface SlashCommand {
  /** The bare name — "compact", never "/compact". */
  name: string;
  description: string;
  /** What goes after the name, e.g. "level". */
  hint: string;
  subcommands: string[];
  /** Runs if typed in full, but is not put in the menu. */
  hidden: boolean;
  /** Kiro's terminal can do this and the panel cannot. */
  local: boolean;
}

const runnable = (name: string, description: string, hint = ""): SlashCommand => ({
  name,
  description,
  hint,
  subcommands: [],
  hidden: false,
  local: false,
});

const terminalOnly = (name: string): SlashCommand => ({
  name,
  description: "",
  hint: "",
  subcommands: [],
  hidden: true,
  local: true,
});

/**
 * What the composer recognises.
 *
 * The terminal-only names are here so they are recognised at all. Someone used
 * to `/tools` will type it, and unrecognised it would be sent to the model as a
 * message nobody wrote. Recognised, the panel says why it will not run.
 */
export const PANEL_COMMANDS: SlashCommand[] = [
  runnable("help", "List the commands that can be run here"),
  runnable("model", "Show or change the model", "model"),
  runnable("effort", "Show or change how hard the model thinks", "level"),
  runnable("compact", "Summarise the conversation to free up context"),
  runnable("context", "Show what is using the context"),
  runnable("usage", "Show the plan's credits"),
  runnable("rewind", "Go back to an earlier message"),
  runnable("clear", "Start a new chat"),
  ...[
    "agent", "chat", "code", "feedback", "goal", "guide", "hooks", "knowledge",
    "mcp", "paste", "plan", "prompts", "quit", "reply", "stats", "tools", "voice",
  ].map(terminalOnly),
];

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
      return "is only available in Kiro's own terminal, so this panel cannot run it.";
  }
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
 * A command with structured data and no sentence would otherwise be a blank
 * card for something that worked perfectly well.
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

/** One entry in the rewind picker. */
export interface RewindTurn {
  /** Position in the session's own list of user messages. */
  logIndex: number;
  /** The user's message that opened the turn. */
  label: string;
  /** Unused on v3, which does not say what a turn occupies. */
  group: string;
  responseSnippet: string;
}

/**
 * How many turns survive a rewind to the turn at `index` in that list.
 *
 * Measured, not assumed: `session/fork` at a message keeps that message and its
 * reply and drops everything after. The picker lists newest first, so position
 * 0 keeps all of them and the last position keeps one.
 */
export function turnsKeptByRewind(total: number, index: number): number {
  const count = Number.isInteger(total) && total > 0 ? total : 0;
  if (!Number.isInteger(index) || index < 0 || index >= count) return count;
  return count - index;
}
