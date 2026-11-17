/**
 * Downloading a skill, and the rules about doing so.
 *
 * This is the extension's only network request. Everything else it knows it
 * learns from `kiro-cli`, so the rules are written down here rather than
 * assumed: what it will follow, how much it will read, and what it refuses
 * to write to disk.
 *
 * The policy is separated from the socket on purpose — `fetchSkillText`
 * takes its `get` as an argument, the way `setupWatcher` takes its
 * `Scheduler`, so `test/skillFetch.test.js` drives every branch (a 404, a
 * redirect chain, a redirect to another host, an oversized body, a web page
 * where a file was expected) without a server or a network.
 *
 * Free of `vscode`.
 */

import { get as httpsGet } from "node:https";

export interface HttpReply {
  status: number;
  /** Lower-cased header names, as Node already gives them. */
  headers: Record<string, string | undefined>;
  body: string;
  /**
   * Set when the reader stopped early because the body ran past the cap.
   *
   * Said outright rather than inferred from the body's length: the reader
   * stops *at* the limit, so the text it returns is within it, and a size
   * check on what came back would call an oversized file acceptable.
   */
  truncated?: boolean;
}

export type Get = (url: string) => Promise<HttpReply>;

export interface FetchLimits {
  /** A SKILL.md is a few kilobytes. This is room to spare, not a target. */
  maxBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
}

export const DEFAULT_LIMITS: Required<FetchLimits> = {
  maxBytes: 256 * 1024,
  maxRedirects: 3,
  timeoutMs: 15000,
};

export type FetchResult = { text: string; url: string } | { error: string };

/**
 * Fetch the text of a skill, or say why not.
 *
 * Errors come back as a sentence rather than thrown, because every one of
 * them is something to show the user in the box they are standing in — and
 * because "the server said 404" is not an exceptional condition, it is the
 * answer.
 */
export async function fetchSkillText(
  url: string,
  get: Get,
  limits: FetchLimits = {}
): Promise<FetchResult> {
  const { maxBytes, maxRedirects } = { ...DEFAULT_LIMITS, ...limits };
  let current = url;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    let reply: HttpReply;
    try {
      reply = await get(current);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Could not reach ${hostOf(current)}: ${message}` };
    }

    if (reply.status >= 300 && reply.status < 400) {
      const next = reply.headers["location"];
      if (!next) return { error: `${hostOf(current)} redirected without saying where.` };
      let resolved: string;
      try {
        resolved = new URL(next, current).toString();
      } catch {
        return { error: `${hostOf(current)} redirected somewhere unreadable.` };
      }
      /*
       * Same host, and https still. A redirect is the server choosing what
       * gets written into the workspace, and following one to another host
       * means the link the user read is not the thing that answered. The
       * links this accepts are rewritten to the raw host up front precisely
       * so a legitimate fetch needs no cross-host hop.
       */
      const target = new URL(resolved);
      if (target.protocol !== "https:") {
        return { error: `${hostOf(current)} redirected to a plain http address.` };
      }
      if (target.hostname.toLowerCase() !== new URL(current).hostname.toLowerCase()) {
        return { error: `${hostOf(current)} redirected to ${target.hostname}, so it was not followed.` };
      }
      current = resolved;
      continue;
    }

    if (reply.status === 404) {
      return { error: `${hostOf(current)} has no such file (404). Check the link.` };
    }
    if (reply.status !== 200) {
      return { error: `${hostOf(current)} answered ${reply.status}.` };
    }

    const body = typeof reply.body === "string" ? reply.body : "";
    if (reply.truncated || Buffer.byteLength(body, "utf8") > maxBytes) {
      return { error: `That file is larger than ${Math.round(maxBytes / 1024)} KB.` };
    }
    if (!body.trim()) return { error: "That file is empty." };
    /*
     * A web page is the commonest wrong answer here — a GitHub `blob` URL
     * that slipped through, a login wall, a 200-with-an-error-page. Writing
     * it would leave a `SKILL.md` full of HTML that Kiro reads as
     * instructions, so it is refused with the thing to do instead.
     */
    if (looksLikeHtml(body)) {
      return { error: "That URL returned a web page, not a file. Use its raw link." };
    }
    return { text: body, url: current };
  }

  return { error: `${hostOf(url)} redirected too many times.` };
}

/** The host to name in a message, never a guess at one. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "that address";
  }
}

/** Enough to catch a page; not a parser. */
export function looksLikeHtml(body: string): boolean {
  const head = body.slice(0, 400).trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html") || head.startsWith("<?xml");
}

/**
 * The real request.
 *
 * Untested by design — it is the one piece that needs a socket, and every
 * decision it could get wrong has been moved into `fetchSkillText` above.
 * It reads at most `maxBytes` and then stops, rather than buffering whatever
 * arrives and checking the size afterwards.
 *
 * It does not honour VS Code's `http.proxy`: Node's client does not read it,
 * and routing through a proxy needs an agent this does not pull in. Behind
 * one, the fetch fails and says so, and the file can still be saved by hand.
 */
export function httpsGetText(limits: FetchLimits = {}): Get {
  const { maxBytes, timeoutMs } = { ...DEFAULT_LIMITS, ...limits };
  return (url) =>
    new Promise<HttpReply>((resolve, reject) => {
      const request = httpsGet(url, { headers: { accept: "text/plain, text/markdown, */*" } }, (res) => {
        const status = res.statusCode ?? 0;
        // A redirect's body is of no interest, and neither is anything past
        // the cap. Both are dropped without being read into memory.
        if (status >= 300 && status < 400) {
          res.resume();
          resolve({ status, headers: res.headers as HttpReply["headers"], body: "" });
          return;
        }
        let size = 0;
        let truncated = false;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            // Stop reading rather than buffering the rest to measure it.
            truncated = true;
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        const done = () =>
          resolve({
            status,
            headers: res.headers as HttpReply["headers"],
            body: Buffer.concat(chunks).toString("utf8"),
            truncated,
          });
        res.on("end", done);
        // `destroy` ends the stream without an `end`, so the oversize case
        // would otherwise hang until the timeout rather than reporting.
        res.on("close", done);
        res.on("error", (err) => (truncated ? done() : reject(err)));
      });
      request.setTimeout(timeoutMs, () => {
        request.destroy(new Error(`no answer in ${Math.round(timeoutMs / 1000)}s`));
      });
      request.on("error", reject);
    });
}
