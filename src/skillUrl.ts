/**
 * A link to someone else's skill, turned into something fetchable.
 *
 * The name box takes a link as well as a name, because pasting the URL is
 * what people actually do — and the first version refused it with "a skill
 * name is one folder", which is accurate and tells you nothing about what to
 * do instead.
 *
 * The one rule worth stating up front: a GitHub `blob` URL is a **web page**,
 * not a file. Fetching it gives you HTML with the markdown buried in it, so
 * every such link is rewritten to `raw.githubusercontent.com` here rather
 * than being downloaded and then found wanting.
 *
 * Free of `vscode` so `test/skillUrl.test.js` can drive it.
 */

/** Markdown held in a repository, and nothing else, is what this can take. */
const RAW_HOST = "raw.githubusercontent.com";

/**
 * Whether the box should read this as a link rather than a name.
 *
 * Deliberately generous: anything with a scheme or a leading `www.` is a
 * link *attempt*, and the point of recognising it is to answer with the
 * reason it cannot be used instead of a sentence about folder names. A name
 * cannot contain `:` or `/` anyway, so nothing legitimate is caught here.
 */
export function looksLikeUrl(value: unknown): boolean {
  const text = typeof value === "string" ? value.trim() : "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^www\./i.test(text) || text.includes("://");
}

/**
 * The URL to actually fetch, or `undefined` for one that cannot be used.
 *
 * Only `https`. Not because `http` would fail to work, but because this
 * fetches text that Kiro will later load as instructions, and over `http`
 * anything between here and the server chooses what that text says.
 */
export function rawSkillUrl(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return undefined;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;

  // A fragment is the browser's business and a query is usually `?plain=1`
  // or `?raw=1`, neither of which the raw host needs.
  url.hash = "";
  url.search = "";

  const host = url.hostname.toLowerCase();
  if (host === "github.com") {
    const raw = rawFromGithubPage(url);
    return raw ?? undefined;
  }
  /*
   * A gist's page URL is refused here rather than downloaded.
   *
   * It looks exactly like a file URL and is not one — the file lives on
   * `gist.githubusercontent.com`, reached by the Raw button. The fetcher's
   * own guard would catch the HTML a moment later, but saying so in the box
   * the user is standing in beats saying it after a round trip.
   */
  if (host === "gist.github.com" && !url.pathname.includes("/raw/")) return undefined;
  return url.toString();
}

/**
 * `github.com/<owner>/<repo>/blob/<ref>/<path>` → the raw file.
 *
 * `<ref>` may itself contain slashes (`refs/heads/main`, or a branch named
 * `release/3.x`), so the segments after the marker are kept whole rather
 * than being read positionally — the raw host accepts the same shape. `raw`
 * appears in place of `blob` on GitHub's own "raw" links, which redirect to
 * the same place; rewriting it here saves a cross-host redirect that the
 * fetcher refuses by design.
 */
function rawFromGithubPage(url: URL): string | undefined {
  const parts = url.pathname.split("/").filter(Boolean);
  const marker = parts.findIndex((part) => part === "blob" || part === "raw");
  if (marker !== 2) return undefined;
  const [owner, repo] = parts;
  const rest = parts.slice(marker + 1);
  if (!owner || !repo || rest.length < 2) return undefined;
  return `https://${RAW_HOST}/${owner}/${repo}/${rest.join("/")}`;
}

/**
 * Why this link cannot be used, or `undefined` if it can.
 *
 * The sentence names what to do, because the box it appears in is the place
 * the user is standing. A gist is called out by name: its page URL looks
 * like a file URL and is not one, and the fix is a different button on that
 * same page.
 */
export function skillUrlProblem(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^https:/i.test(text)) {
    if (/^http:/i.test(text)) return "Use an https link — this file becomes instructions for Kiro.";
    return "That is not a link this can fetch. Paste an https link, or type a name.";
  }
  if (!rawSkillUrl(text)) {
    if (/^https:\/\/gist\.github\.com/i.test(text)) {
      return "For a gist, use its Raw link.";
    }
    if (/^https:\/\/github\.com/i.test(text)) {
      return "That GitHub link does not point at a file. Open the file and copy its URL.";
    }
    return "That link cannot be read as a file.";
  }
  return undefined;
}

/**
 * What the skill is called, as the file itself says.
 *
 * Preferred over the folder in the URL because the frontmatter `name` is
 * what Kiro actually calls the skill: taking the folder when the two differ
 * would file it under a name the panel then reports and Kiro never uses.
 * Only a plain scalar is read — a name is one word, and a `>` or `|` block
 * there is someone doing something this should not guess at.
 */
export function skillNameFromFrontmatter(text: unknown): string | undefined {
  const body = typeof text === "string" ? text : "";
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(body);
  if (!match) return undefined;
  for (const line of match[1].split(/\r?\n/)) {
    const named = /^name:[ \t]*(.*)$/.exec(line);
    if (!named) continue;
    // Quotes are legal YAML and are not part of the name.
    const value = named[1].trim().replace(/^(['"])(.*)\1$/, "$2").trim();
    return value || undefined;
  }
  return undefined;
}

/**
 * The folder the link sits in, as a fallback name.
 *
 * `…/skills/ponytail/SKILL.md` is called `ponytail`, which is the convention
 * the file lives by. A link straight to a `SKILL.md` at the root of a
 * repository has no folder to borrow, and that is a name the user has to
 * supply rather than one to invent.
 */
export function skillNameFromUrl(value: unknown): string | undefined {
  const url = rawSkillUrl(value);
  if (!url) return undefined;
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  const last = parts[parts.length - 1] ?? "";
  // The file itself is never the name: every one of these is `SKILL.md`.
  const folder = /^skill\.md$/i.test(last) ? parts[parts.length - 2] : last.replace(/\.md$/i, "");
  if (!folder) return undefined;
  // `skills/SKILL.md` would otherwise be called "skills".
  return /^skills?$/i.test(folder) ? undefined : folder;
}
