/**
 * The account's credit figures, from the only place that still has them.
 *
 * The v3 engine reports what this conversation cost but nothing about the plan:
 * measured against kiro-cli 3.1.0 it has no `/usage` (the text goes to the model
 * as a prompt and is charged for), and `kiro-cli` has no `usage` subcommand. The
 * v2 engine, which ships in the same binary, still answers it. So the button
 * starts a v2 agent for the length of one question, separate from the one the
 * conversation is talking to.
 *
 * Free of `vscode` so the argument list can be tested. When Kiro removes v2 this
 * fails with an error the panel already knows how to show.
 */

import { AcpClient } from "./acpClient";

export interface AccountUsageLaunch {
  command: string;
  launchArgs: string[];
  env?: Record<string, string>;
  cwd: string;
}

export interface AccountUsageAnswer {
  ok: boolean;
  data?: any;
  text: string;
  /**
   * The session this had to create. It exists on disk until it is deleted, and
   * only once the process is gone can it be: v2 will not delete a session a
   * live process holds.
   */
  sessionId?: string;
}

export function accountUsageArgs(launchArgs: readonly string[]): string[] {
  return [...launchArgs, "acp", "--agent-engine", "v2"];
}

export async function fetchAccountUsage(
  launch: AccountUsageLaunch,
  log: (line: string) => void
): Promise<AccountUsageAnswer> {
  const client = new AcpClient({
    command: launch.command,
    args: accountUsageArgs(launch.launchArgs),
    cwd: launch.cwd,
    env: launch.env ?? {},
    onLog: log,
    onNotification: () => undefined,
    onRequest: async (method) => {
      throw new Error(`Unsupported request: ${method}`);
    },
    onExit: () => undefined,
  });
  client.start();
  try {
    await client.request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "vscode-kiro-chat", version: "0.39.0" },
      },
      30000
    );
    const session = await client.request(
      "session/new",
      { cwd: launch.cwd, mcpServers: [] },
      30000
    );
    const sessionId = session?.sessionId ? String(session.sessionId) : undefined;
    const result = await client.request(
      "_kiro.dev/commands/execute",
      { sessionId, command: { command: "usage", args: {} } },
      20000
    );
    return {
      ok: result?.success !== false,
      data: result?.data,
      text: String(result?.message ?? "").trim(),
      sessionId,
    };
  } finally {
    client.stop();
  }
}
