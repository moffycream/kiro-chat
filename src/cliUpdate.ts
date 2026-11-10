/**
 * Noticing that a newer Kiro CLI exists.
 *
 * The handshake reports no version, and the only other signal the panel had
 * was a CLI so old that it rejected the engine flag, so anything newer than
 * that was never offered an update. `kiro-cli update --check` answers without
 * installing anything.
 *
 * Kept free of `vscode` so `test/cliUpdate.test.js` can run it.
 */
import { spawn } from "child_process";
import { needsShell, quote } from "./acpClient";

export const CLI_UPDATE_KEY = "kiroChat.cliUpdateCheckedAt";
export const CLI_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 30000;

export type CliUpdate = { available: false } | { available: true; version?: string };

export interface CliUpdateLaunch {
  command: string;
  launchArgs: string[];
  env?: Record<string, string>;
}

export function updateCheckArgs(launchArgs: readonly string[]): string[] {
  return [...launchArgs, "update", "--check"];
}

/** A clock that has gone backwards counts as due rather than as never. */
export function updateCheckDue(lastCheckedAt: unknown, now: number): boolean {
  if (typeof lastCheckedAt !== "number" || !Number.isFinite(lastCheckedAt)) return true;
  const elapsed = now - lastCheckedAt;
  return elapsed < 0 || elapsed >= CLI_UPDATE_INTERVAL_MS;
}

/**
 * What the check said, or undefined for anything it did not plainly say.
 *
 * An unreadable answer must not become "an update is available": that would
 * be a notice about nothing, once a day. The version is only ever read off the
 * line announcing the update, so the current one cannot be offered by mistake.
 */
export function readUpdateCheck(output: string): CliUpdate | undefined {
  const text = String(output ?? "");
  const announced = /update available:([^\r\n]*)/i.exec(text);
  if (announced) {
    const versions = announced[1].match(/\d+\.\d+\.\d+[0-9A-Za-z.-]*/g);
    return versions ? { available: true, version: versions[versions.length - 1] } : { available: true };
  }
  return /you are on the current version/i.test(text) ? { available: false } : undefined;
}

/** Ask Kiro. Never rejects: failing to check is not worth telling anyone. */
export function runUpdateCheck(
  launch: CliUpdateLaunch,
  timeoutMs: number = CHECK_TIMEOUT_MS
): Promise<CliUpdate | undefined> {
  return new Promise((resolve) => {
    const args = updateCheckArgs(launch.launchArgs);
    const viaShell = needsShell(launch.command);
    let output = "";
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (timer) clearTimeout(timer);
      resolve(readUpdateCheck(output));
    };
    try {
      const child = spawn(
        viaShell ? [launch.command, ...args].map(quote).join(" ") : launch.command,
        viaShell ? [] : args,
        {
          shell: viaShell,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, ...(launch.env ?? {}) },
        }
      );
      timer = setTimeout(() => child.kill(), timeoutMs);
      child.stdout?.on("data", (chunk) => (output += chunk));
      child.stderr?.on("data", (chunk) => (output += chunk));
      child.on("error", finish);
      child.on("close", finish);
    } catch {
      finish();
    }
  });
}
