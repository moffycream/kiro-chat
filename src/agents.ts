/**
 * Which CLI the panel drives, and the few ways the two differ at the door.
 *
 * Kiro and Qoder both speak ACP over stdio, so everything past the handshake —
 * the transcript, tool steps, permission cards, the change review — is shared.
 * What differs is how each is found and started, and a handful of features
 * that read Kiro's own files or call Kiro-only methods.
 *
 * Measured against qodercli 1.1.91 by driving `qodercli --acp` directly:
 * `initialize` names `agentInfo.name: "qoder-cli"`, advertises `loadSession`,
 * fork, list, delete and images; `session/new` answers with a `models` block
 * *and* `configOptions` (category `model`, no effort option), with each
 * model's credit rate only in its description ("Vision · 0.30x Credit"). Its
 * edit tool writes the file itself — no `fs/write_text_file` call — and
 * announces `kind: "edit"` with `locations`, so the direct-write review path
 * covers it. A turn reports no credits and no context figure; the prompt's
 * own `usage` block was all zeros.
 *
 * Free of `vscode` so `test/agents.test.js` can drive it.
 */
import * as os from "node:os";
import * as path from "node:path";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { findKiro, KiroLocation } from "./findKiro";
import { acpArgs } from "./acpClient";

export type AgentId = "kiro" | "qoder";

export interface AgentProfile {
  id: AgentId;
  /** What the panel calls it. */
  label: string;
  /** The binary, as `where` would be asked for it. */
  binary: string;
  /**
   * Whether the Kiro-only extras apply: `/usage` through a v2 agent, tidying
   * empty sessions under `~/.kiro`, the saved context figure, the CLI update
   * check and skills under `.kiro/skills`. Each reads Kiro's files or calls a
   * method only Kiro has, so for anything else they are switched off rather
   * than left to fail.
   */
  kiroExtras: boolean;
  /** How to sign in, for the setup screen. */
  loginCommand: string;
  /** The official PowerShell installer, typed and left for the user to run. */
  installCommand: string;
  /** How to update it, typed and left for the user to run. */
  updateCommand: string;
}

export const AGENTS: Record<AgentId, AgentProfile> = {
  kiro: {
    id: "kiro",
    label: "Kiro",
    binary: "kiro-cli",
    kiroExtras: true,
    loginCommand: "kiro-cli login",
    installCommand: "irm 'https://cli.kiro.dev/install.ps1' | iex",
    updateCommand: "kiro-cli update",
  },
  qoder: {
    id: "qoder",
    label: "Qoder",
    binary: "qodercli",
    kiroExtras: false,
    loginCommand: "qodercli login",
    // From docs.qoder.com/cli/install.
    installCommand: "irm 'https://qoder.com/install.ps1' | iex",
    updateCommand: "qodercli update",
  },
};

/** Anything that is not a known id is Kiro, which is what every older setting meant. */
export function agentIdOf(value: unknown): AgentId {
  return value === "qoder" ? "qoder" : "kiro";
}

export function agentProfile(value: unknown): AgentProfile {
  return AGENTS[agentIdOf(value)];
}

/**
 * The arguments for the agent's ACP mode.
 *
 * Kiro takes `acp` as a subcommand plus the engine flag (`acpArgs`). Qoder
 * takes `--acp` as an option: `qodercli acp` is read as a prompt, and answers
 * "Not logged in" whatever the login state — measured.
 */
export function agentArgs(agent: AgentId, launch: string[], user: string[]): string[] {
  if (agent === "kiro") return acpArgs(launch, user);
  const own = user ?? [];
  return [...(launch ?? []), ...(own.includes("--acp") ? [] : ["--acp"]), ...own];
}

/**
 * The `file://` link an attached file is sent as.
 *
 * Kiro takes the standard form VS Code writes, `file:///c%3A/Users/...`. Qoder
 * does not decode a link: measured against 1.1.91, it turns a `resource_link`
 * into a path by dropping the first seven characters, `file://`, and resolving
 * what is left against the workspace — so the standard form arrived as
 * `/c%3A/Users/...`, resolved to `c:\c%3A\Users\...`, and every attached file
 * was refused as outside the workspace. It is given `file://C:/Users/...`,
 * whose remainder is the plain path, spaces and all.
 */
export function fileLinkFor(
  agent: AgentId,
  fsPath: string,
  standard: (fsPath: string) => string
): string {
  if (agent === "qoder") return `file://${fsPath.replace(/\\/g, "/")}`;
  return standard(fsPath);
}

function run(command: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 5000 }, (err, stdout) => {
      if (err || !stdout) return resolve(undefined);
      resolve(stdout.toString().split("\n")[0]?.trim() || undefined);
    });
  });
}

/** Where the Qoder installer puts the CLI on Windows. */
export function qoderPaths(home = os.homedir()): string[] {
  const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
  return [
    path.join(home, ".qoder", "bin", "qodercli", "qodercli.exe"),
    path.join(home, ".qoder", "bin", "qodercli.exe"),
    path.join(localAppData, "Programs", "qodercli", "qodercli.exe"),
  ];
}

/**
 * Find Qoder the way `findKiro` finds Kiro: install folders, then PATH.
 *
 * Only `qodercli.exe`, never the `qoder.cmd` entry shim beside it, which
 * starts the editor rather than the CLI.
 */
export async function findQoder(log: (line: string) => void): Promise<KiroLocation | undefined> {
  for (const candidate of qoderPaths()) {
    if (existsSync(candidate)) {
      log(`Found Qoder at ${candidate}`);
      return { command: candidate, extraArgs: [], source: "install folder" };
    }
  }
  const onPath = await run("where", ["qodercli"]);
  if (onPath && existsSync(onPath)) {
    log(`Found Qoder on PATH at ${onPath}`);
    return { command: onPath, extraArgs: [], source: "PATH" };
  }
  log("Could not find qodercli anywhere.");
  return undefined;
}

export function findAgent(
  agent: AgentId,
  log: (line: string) => void
): Promise<KiroLocation | undefined> {
  return agent === "qoder" ? findQoder(log) : findKiro(log);
}
