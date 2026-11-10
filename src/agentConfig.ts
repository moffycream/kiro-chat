/**
 * An agent Kiro refused to load.
 *
 * Kiro announces this with `_kiro/customAgent/config_error` and carries on
 * without the agent, typically one written for V2 that V3 will not accept.
 * The panel only ever logged the method name, so the agent was simply missing.
 * The report repeats on every start, so a warning is remembered and shown once
 * for each file and reason.
 *
 * Kept free of `vscode` so `test/agentConfig.test.js` can drive it.
 */

export const AGENT_WARNINGS_KEY = "kiroChat.agentConfigWarned";
const MAX_REMEMBERED = 50;

export interface AgentConfigError {
  path: string;
  name: string;
  reason: string;
}

export function readAgentConfigError(params: any): AgentConfigError | undefined {
  const file = typeof params?.path === "string" ? params.path.trim() : "";
  if (!file) return undefined;
  const leaf = file.split(/[\\/]/).pop() || file;
  const reason = [params?.error, params?.reasonCode].find(
    (value) => typeof value === "string" && value.trim()
  );
  return {
    path: file,
    name: leaf.replace(/\.json$/i, ""),
    reason: reason ? String(reason).trim() : "Kiro did not say why.",
  };
}

export function agentWarningKey(problem: AgentConfigError): string {
  return `${problem.path}\n${problem.reason}`;
}

/** Whether this one is new, and the list to store. A changed reason is new. */
export function rememberAgentWarning(
  seen: unknown,
  key: string
): { fresh: boolean; seen: string[] } {
  const list = Array.isArray(seen) ? seen.filter((k): k is string => typeof k === "string") : [];
  if (list.includes(key)) return { fresh: false, seen: list };
  return { fresh: true, seen: [...list, key].slice(-MAX_REMEMBERED) };
}
