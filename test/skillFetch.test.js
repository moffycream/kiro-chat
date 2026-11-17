/*
 * The extension's only network request, and the rules about it.
 *
 * `fetchSkillText` takes its `get` as an argument — the way `setupWatcher`
 * takes its `Scheduler` — so every branch is driven here without a server:
 * a 404, a redirect chain, a redirect to another host, an oversized body, a
 * web page where a file was expected. The socket itself (`httpsGetText`) is
 * the one piece left untested, and every decision it could get wrong has
 * been moved into the function below it.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { DEFAULT_LIMITS, fetchSkillText, hostOf, looksLikeHtml } = require("../out/skillFetch");

const URL_A = "https://raw.githubusercontent.com/o/r/main/skills/a/SKILL.md";
const SKILL = "---\nname: a\ndescription: Use when asked.\n---\n\nbody\n";

/** A `get` that answers from a table, and records what it was asked for. */
function fakeGet(replies) {
  const asked = [];
  const get = async (url) => {
    asked.push(url);
    const reply = typeof replies === "function" ? replies(url) : replies[url];
    if (!reply) throw new Error(`nothing stubbed for ${url}`);
    if (reply instanceof Error) throw reply;
    return { status: 200, headers: {}, body: "", ...reply };
  };
  get.asked = asked;
  return get;
}

test("a plain 200 gives back the text", async () => {
  const get = fakeGet({ [URL_A]: { body: SKILL } });
  const result = await fetchSkillText(URL_A, get);
  assert.deepEqual(result, { text: SKILL, url: URL_A });
  assert.deepEqual(get.asked, [URL_A]);
});

test("a 404 says the file is not there, with the host", async () => {
  const get = fakeGet({ [URL_A]: { status: 404, body: "Not Found" } });
  const result = await fetchSkillText(URL_A, get);
  assert.match(result.error, /raw\.githubusercontent\.com/);
  assert.match(result.error, /404/);
  assert.ok(!("text" in result));
});

test("any other status is reported as itself", async () => {
  for (const status of [401, 403, 500, 0]) {
    const get = fakeGet({ [URL_A]: { status, body: "" } });
    const result = await fetchSkillText(URL_A, get);
    assert.match(result.error, new RegExp(String(status)));
  }
});

test("a redirect on the same host is followed", async () => {
  const moved = `${URL_A}?v=2`;
  const get = fakeGet({
    [URL_A]: { status: 302, headers: { location: moved } },
    [moved]: { body: SKILL },
  });
  const result = await fetchSkillText(URL_A, get);
  assert.equal(result.text, SKILL);
  assert.equal(result.url, moved, "and the url it answers is the one that replied");
});

test("a relative redirect resolves against the url it came from", async () => {
  const get = fakeGet({
    [URL_A]: { status: 301, headers: { location: "/o/r/main/skills/a/OTHER.md" } },
    "https://raw.githubusercontent.com/o/r/main/skills/a/OTHER.md": { body: SKILL },
  });
  assert.equal((await fetchSkillText(URL_A, get)).text, SKILL);
});

/*
 * A redirect is the server choosing what gets written into the workspace,
 * and following one to another host means the link the user read is not the
 * thing that answered. Accepted links are rewritten to the raw host up
 * front precisely so a legitimate fetch needs no cross-host hop.
 */
test("a redirect to another host is refused, naming it", async () => {
  const get = fakeGet({
    [URL_A]: { status: 302, headers: { location: "https://elsewhere.example/SKILL.md" } },
  });
  const result = await fetchSkillText(URL_A, get);
  assert.match(result.error, /elsewhere\.example/);
  assert.match(result.error, /not followed/);
  assert.equal(get.asked.length, 1, "and nothing is fetched from it");
});

test("a redirect down to http is refused", async () => {
  const get = fakeGet({
    [URL_A]: { status: 302, headers: { location: "http://raw.githubusercontent.com/o/r/a.md" } },
  });
  assert.match((await fetchSkillText(URL_A, get)).error, /http/);
});

test("a redirect with no destination is not a crash", async () => {
  const get = fakeGet({ [URL_A]: { status: 302, headers: {} } });
  assert.match((await fetchSkillText(URL_A, get)).error, /without saying where/);
});

test("a redirect loop ends, and says so", async () => {
  const get = fakeGet(() => ({ status: 302, headers: { location: URL_A } }));
  const result = await fetchSkillText(URL_A, get);
  assert.match(result.error, /too many times/);
  assert.equal(get.asked.length, DEFAULT_LIMITS.maxRedirects + 1, "bounded, not endless");
});

/*
 * The reader stops *at* the cap, so what comes back is within it — which is
 * why the reply says it was truncated rather than the size being inferred
 * from the text. Inferring it would call an oversized file acceptable.
 */
test("an oversized body is refused either way it is reported", async () => {
  const big = "x".repeat(DEFAULT_LIMITS.maxBytes + 1);
  const byLength = fakeGet({ [URL_A]: { body: big } });
  assert.match((await fetchSkillText(URL_A, byLength)).error, /larger than/);

  const byFlag = fakeGet({ [URL_A]: { body: "x".repeat(10), truncated: true } });
  assert.match((await fetchSkillText(URL_A, byFlag)).error, /larger than/);
});

test("the cap can be lowered, and the message says the figure", async () => {
  const get = fakeGet({ [URL_A]: { body: "x".repeat(2049) } });
  const result = await fetchSkillText(URL_A, get, { maxBytes: 2048 });
  assert.match(result.error, /2 KB/);
});

test("an empty file is nothing to write", async () => {
  for (const body of ["", "   \n\t "]) {
    const get = fakeGet({ [URL_A]: { body } });
    assert.match((await fetchSkillText(URL_A, get)).error, /empty/);
  }
});

/*
 * The commonest wrong answer: a blob URL that slipped through, a login
 * wall, a 200 with an error page. Writing it would leave a SKILL.md full of
 * HTML that Kiro reads as instructions.
 */
test("a web page is refused with the thing to do instead", async () => {
  const pages = [
    "<!doctype html>\n<html><body>hi</body></html>",
    "<html lang=\"en\">…",
    "  \n<!DOCTYPE HTML><head>",
    '<?xml version="1.0"?><rss>',
  ];
  for (const body of pages) {
    const get = fakeGet({ [URL_A]: { body } });
    const result = await fetchSkillText(URL_A, get);
    assert.match(result.error, /web page/, JSON.stringify(body.slice(0, 20)));
    assert.match(result.error, /raw link/i);
  }
  // Markdown that merely contains a tag is not a page.
  const inline = fakeGet({ [URL_A]: { body: "# Title\n\nUse <html> carefully.\n" } });
  assert.equal((await fetchSkillText(URL_A, inline)).text, "# Title\n\nUse <html> carefully.\n");
});

test("looksLikeHtml only reads the start of the body", () => {
  assert.equal(looksLikeHtml("<!doctype html><p>"), true);
  assert.equal(looksLikeHtml("---\nname: a\n---\n<!doctype html>"), false);
});

test("a dead connection is reported as the host, not as a stack trace", async () => {
  const get = fakeGet({ [URL_A]: new Error("getaddrinfo ENOTFOUND") });
  const result = await fetchSkillText(URL_A, get);
  assert.match(result.error, /raw\.githubusercontent\.com/);
  assert.match(result.error, /ENOTFOUND/);
});

test("hostOf never throws, whatever it is handed", () => {
  assert.equal(hostOf(URL_A), "raw.githubusercontent.com");
  assert.equal(hostOf("not a url"), "that address");
  assert.equal(hostOf(""), "that address");
});
