/**
 * Asking Windows what a pid actually is.
 *
 * Only `sessionLocks` needs this, and only to tell a live Kiro from a number
 * that has been handed to something else. Kept apart from that module so the
 * decision stays pure and testable and the shelling-out lives on its own.
 *
 * `Get-Process` rather than `tasklist`, because the start time is the whole
 * point and `tasklist` does not report it. Free of `vscode`.
 */
import { execFile } from "node:child_process";
import { ProcessFacts } from "./sessionLocks";

/** Long enough for PowerShell to start; short enough not to stall a chat. */
const LOOKUP_TIMEOUT_MS = 5000;

/**
 * What is running under `pid` right now.
 *
 * Every failure answers `{ running: true }` — the shape that decides nothing.
 * A lookup that did not work is not evidence a process is gone, and treating
 * it as such would delete locks on the strength of PowerShell being slow.
 */
export function lookupProcess(
  pid: number,
  run: Runner = defaultRunner
): Promise<ProcessFacts> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve({ running: false });

  /*
   * StartTime throws for a process this user may not read, so it is fetched
   * inside its own try and simply left out when it fails — the image name
   * alone still settles the recycled-pid case, which is the common one.
   */
  const script = [
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue;`,
    `if ($null -eq $p) { '{"running":false}' } else {`,
    `$s = $null; try { $s = $p.StartTime.ToUniversalTime().ToString('o') } catch {};`,
    `[pscustomobject]@{ running = $true; image = $p.ProcessName; startedAt = $s }`,
    `| ConvertTo-Json -Compress }`,
  ].join(" ");

  return run(script)
    .then((stdout) => readFacts(stdout))
    .catch(() => ({ running: true }));
}

/** Parse what the script above prints. Anything unreadable decides nothing. */
export function readFacts(stdout: string): ProcessFacts {
  let raw: any;
  try {
    raw = JSON.parse(String(stdout).trim());
  } catch {
    return { running: true };
  }
  /*
   * "Gone" has to be said explicitly, never arrived at by falling through.
   * `JSON.parse("null")` succeeds, and reading `running` off that answers
   * undefined — which under a `!== true` test reads as proof the process is
   * dead, and the lock gets deleted on the strength of garbled output.
   */
  if (raw?.running === false) return { running: false };
  if (raw?.running !== true) return { running: true };

  const facts: ProcessFacts = { running: true };
  if (typeof raw.image === "string" && raw.image) facts.image = raw.image.toLowerCase();
  if (typeof raw.startedAt === "string" && raw.startedAt) {
    const at = new Date(raw.startedAt);
    if (!Number.isNaN(at.getTime())) facts.startedAt = at;
  }
  return facts;
}

export type Runner = (script: string) => Promise<string>;

const defaultRunner: Runner = (script) =>
  new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: LOOKUP_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
  });
