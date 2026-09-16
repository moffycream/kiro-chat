/**
 * What a running kiro-cli took in when it started, so "+" can tell whether
 * the process it is about to reuse is still the one the user has configured.
 *
 * `newSession` keeps the agent running rather than restarting it for every
 * new chat. Measured against kiro-cli 2.20.2, one process holds several
 * sessions with separate context, and reloads an earlier one without being
 * refused. What that gave up is the restart's side effect: a fresh process
 * reread everything it reads at startup. So a snapshot is taken as Kiro
 * launches and compared when "+" is pressed, and any difference earns the
 * old behaviour, a restart, for that one new chat.
 *
 * It errs towards restarting. A config file Kiro turns out to reread per
 * session costs one unnecessary restart, which is what every "+" used to
 * cost; a change that is missed leaves Kiro silently running a setup the
 * user has already replaced.
 *
 * Free of `vscode` so `test/launchInputs.test.js` can drive it.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** The folders under `.kiro` holding what Kiro loads: MCP servers, agents, steering. */
export const KIRO_CONFIG_FOLDERS = ["settings", "agents", "steering"];

/** Enough for any real config tree; a runaway folder must not stall "+". */
const MAX_ENTRIES = 400;
const MAX_DEPTH = 4;

export interface LaunchInputs {
  /** The extension settings `startInternal` reads, serialised. */
  settings: string;
  /** Kiro's cwd is the first root, and the file boundary covers all of them. */
  roots: string[];
  /** The binary's modified time and size, so an update to Kiro is noticed. */
  binary: string | undefined;
  /** Every file in the config folders, as `mtime:size`, keyed by path. */
  files: Record<string, string>;
}

export interface LaunchSources {
  settings: unknown;
  roots: string[];
  /** The command as launched. Only an absolute path to a file is stamped. */
  command: string | undefined;
  home: string;
}

function stamp(file: string): string | undefined {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? `${stat.mtimeMs}:${stat.size}` : undefined;
  } catch {
    return undefined;
  }
}

function collect(dir: string, depth: number, into: Record<string, string>): void {
  if (depth > MAX_DEPTH || Object.keys(into).length >= MAX_ENTRIES) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // Missing is a state too: a folder that appears later shows up as new files.
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (Object.keys(into).length >= MAX_ENTRIES) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, depth + 1, into);
    else if (entry.isFile()) {
      const value = stamp(full);
      if (value) into[full] = value;
    }
  }
}

export function snapshotLaunchInputs(sources: LaunchSources): LaunchInputs {
  const files: Record<string, string> = {};
  for (const base of [sources.home, ...sources.roots]) {
    for (const folder of KIRO_CONFIG_FOLDERS) {
      collect(path.join(base, ".kiro", folder), 0, files);
    }
  }
  const command = sources.command;
  return {
    settings: JSON.stringify(sources.settings ?? null),
    roots: [...sources.roots],
    binary: command && path.isAbsolute(command) ? stamp(command) : undefined,
    files,
  };
}

/**
 * Why a process started with `before` no longer matches `after`, in words for
 * the output channel. Empty means the running agent is still current.
 */
export function launchInputsChanged(before: LaunchInputs, after: LaunchInputs): string[] {
  const reasons: string[] = [];
  if (before.settings !== after.settings) reasons.push("Kiro Chat's launch settings changed");
  if (before.roots.join("\n") !== after.roots.join("\n")) {
    reasons.push("the workspace folders changed");
  }
  if (before.binary !== after.binary) reasons.push("kiro-cli itself was updated");
  const paths = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
  for (const file of [...paths].sort()) {
    if (before.files[file] === after.files[file]) continue;
    const what =
      before.files[file] === undefined
        ? "added"
        : after.files[file] === undefined
          ? "removed"
          : "changed";
    reasons.push(`${file} was ${what}`);
  }
  return reasons;
}
