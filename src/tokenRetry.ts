/**
 * Waiting out an access token Kiro could not refresh.
 *
 * Kiro's access token is short-lived and it refreshes the token itself. When
 * that refresh cannot reach the sign-in server, typically in the seconds after
 * a laptop wakes, `session/prompt` is refused with "you are not signed in" and
 * `data.detail` of `TokenExpiredError`, although the login is perfectly good.
 * In the one case on record the next refresh worked about ninety seconds later
 * with nobody doing anything, and no turn or model call was logged for the
 * refused message, so sending it again spends nothing twice.
 *
 * Kept free of `vscode`, with the wait injected, so the tests can drive it
 * without sitting through it — see `test/tokenRetry.test.js`.
 */

/** About two minutes in all, front-loaded because most outages are a wake-up. */
export const TOKEN_RETRY_DELAYS_MS: readonly number[] = [3000, 7000, 15000, 30000, 30000, 30000];

/**
 * Only Kiro's own structured detail counts.
 *
 * The sentence is no use here: it says "not signed in" for this and could say
 * the same for a login that really has gone, and those need different answers.
 */
export function isExpiredToken(err: unknown): boolean {
  const data = (err as { data?: unknown } | null | undefined)?.data;
  if (typeof data !== "object" || data === null) return false;
  return (data as { detail?: unknown }).detail === "TokenExpiredError";
}

export interface TokenRetryOptions {
  delays?: readonly number[];
  wait: (ms: number) => Promise<void>;
  /** True once sending again would be wrong: Stop, a new chat, or work begun. */
  shouldStop: () => boolean;
  onWaiting?: (attempt: number, total: number) => void;
}

/** Run `attempt`, again after each delay while Kiro keeps refusing the token. */
export async function retryExpiredToken<T>(
  attempt: () => Promise<T>,
  options: TokenRetryOptions
): Promise<T> {
  const delays = options.delays ?? TOKEN_RETRY_DELAYS_MS;
  for (let index = 0; ; index++) {
    try {
      return await attempt();
    } catch (err) {
      if (!isExpiredToken(err) || index >= delays.length || options.shouldStop()) throw err;
      options.onWaiting?.(index + 1, delays.length);
      await options.wait(delays[index]);
      // Asked again: Stop is most likely to arrive during the wait.
      if (options.shouldStop()) throw err;
    }
  }
}
