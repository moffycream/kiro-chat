/*
 * A link to someone else's skill.
 *
 * The rule the whole thing turns on: a GitHub `blob` URL is a web page, not
 * a file. Fetching one gives HTML with the markdown buried in it, so every
 * such link is rewritten to the raw host before anything is downloaded.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  looksLikeUrl,
  rawSkillUrl,
  skillNameFromFrontmatter,
  skillNameFromUrl,
  skillUrlProblem,
} = require("../out/skillUrl");

const PAGE = "https://github.com/DietrichGebert/ponytail/blob/main/skills/ponytail/SKILL.md";
const RAW = "https://raw.githubusercontent.com/DietrichGebert/ponytail/main/skills/ponytail/SKILL.md";

test("a GitHub file page becomes its raw file", () => {
  assert.equal(rawSkillUrl(PAGE), RAW);
  // GitHub's own "raw" link points at the same place by a redirect; doing it
  // here saves a cross-host hop the fetcher refuses by design.
  assert.equal(rawSkillUrl(PAGE.replace("/blob/", "/raw/")), RAW);
  // Already raw, so left alone.
  assert.equal(rawSkillUrl(RAW), RAW);
});

test("the browser's own additions are dropped", () => {
  assert.equal(rawSkillUrl(`${PAGE}?plain=1`), RAW);
  assert.equal(rawSkillUrl(`${PAGE}#L12-L20`), RAW);
  assert.equal(rawSkillUrl(`  ${PAGE}  `), RAW);
});

/*
 * A ref can hold slashes — `refs/heads/main`, or a branch called
 * `release/3.x` — so the segments after the marker are kept whole rather
 * than read positionally. Reading them positionally silently truncated the
 * path to the file.
 */
test("a ref containing slashes survives", () => {
  assert.equal(
    rawSkillUrl("https://github.com/o/r/blob/refs/heads/main/skills/a/SKILL.md"),
    "https://raw.githubusercontent.com/o/r/refs/heads/main/skills/a/SKILL.md"
  );
  assert.equal(
    rawSkillUrl("https://github.com/o/r/blob/release/3.x/skills/a/SKILL.md"),
    "https://raw.githubusercontent.com/o/r/release/3.x/skills/a/SKILL.md"
  );
});

/*
 * Not because http would fail to work, but because this fetches text Kiro
 * later loads as instructions, and over http anything in between chooses
 * what that text says.
 */
test("only https is accepted", () => {
  assert.equal(rawSkillUrl(PAGE.replace("https:", "http:")), undefined);
  assert.equal(rawSkillUrl("ftp://example.com/SKILL.md"), undefined);
  assert.equal(rawSkillUrl("file:///C:/SKILL.md"), undefined);
  assert.match(skillUrlProblem(PAGE.replace("https:", "http:")), /https/);
});

test("a repository page that is not a file is refused", () => {
  assert.equal(rawSkillUrl("https://github.com/DietrichGebert/ponytail"), undefined);
  assert.equal(rawSkillUrl("https://github.com/DietrichGebert/ponytail/tree/main/skills"), undefined);
  assert.match(skillUrlProblem("https://github.com/DietrichGebert/ponytail"), /does not point at a file/);
});

/*
 * A gist's page URL looks like a file URL and is not one. Named explicitly,
 * because the fix is a different button on the page the user is already on.
 */
test("a gist page says what to use instead", () => {
  assert.match(skillUrlProblem("https://gist.github.com/someone/abc123"), /Raw link/);
});

test("a link off GitHub is taken as given", () => {
  assert.equal(
    rawSkillUrl("https://example.com/skills/thing/SKILL.md"),
    "https://example.com/skills/thing/SKILL.md"
  );
  assert.equal(skillUrlProblem("https://example.com/skills/thing/SKILL.md"), undefined);
});

/*
 * Generous on purpose: anything with a scheme is a link *attempt*, and the
 * point of recognising it is to answer about links instead of about folder
 * names. A real name can hold neither ":" nor "/", so nothing legitimate is
 * caught.
 */
test("a link attempt is told apart from a name", () => {
  assert.equal(looksLikeUrl(PAGE), true);
  assert.equal(looksLikeUrl("http://example.com/a.md"), true);
  assert.equal(looksLikeUrl("www.example.com/a.md"), true);
  assert.equal(looksLikeUrl("ponytail"), false);
  assert.equal(looksLikeUrl("release-notes"), false);
  assert.equal(looksLikeUrl(undefined), false);
});

/*
 * The frontmatter wins over the folder, because `name` is what Kiro calls
 * the skill: filing it under the other one would have the panel report a
 * name Kiro never uses.
 */
test("the name comes from the file's own frontmatter", () => {
  assert.equal(skillNameFromFrontmatter("---\nname: ponytail\n---\n\nbody\n"), "ponytail");
  assert.equal(skillNameFromFrontmatter('---\nname: "quoted"\n---\n'), "quoted");
  assert.equal(skillNameFromFrontmatter("---\nname: 'single'\n---\n"), "single");
  // The real ponytail file: a folded description under the name.
  const real = "---\nname: ponytail\ndescription: >\n  Lazy senior dev mode:\n  one read.\nlicense: MIT\n---\n\n# Ponytail\n";
  assert.equal(skillNameFromFrontmatter(real), "ponytail");
  // CRLF, and a byte-order mark, are both things a downloaded file has.
  assert.equal(skillNameFromFrontmatter("---\r\nname: crlf\r\n---\r\n"), "crlf");
  assert.equal(skillNameFromFrontmatter("\uFEFF---\nname: bom\n---\n"), "bom");
});

test("no frontmatter and no name are both nothing, not a guess", () => {
  assert.equal(skillNameFromFrontmatter("# Just a heading\n"), undefined);
  assert.equal(skillNameFromFrontmatter("---\ndescription: no name here\n---\n"), undefined);
  assert.equal(skillNameFromFrontmatter("---\nname:   \n---\n"), undefined);
  assert.equal(skillNameFromFrontmatter(undefined), undefined);
  // An unterminated block is not frontmatter, however it starts.
  assert.equal(skillNameFromFrontmatter("---\nname: open\n"), undefined);
});

test("the folder in the link is the fallback name", () => {
  assert.equal(skillNameFromUrl(PAGE), "ponytail");
  assert.equal(skillNameFromUrl("https://example.com/a/b/release-notes/SKILL.md"), "release-notes");
  // A loose `.md` names itself.
  assert.equal(skillNameFromUrl("https://example.com/a/ponytail.md"), "ponytail");
  // Nothing worth borrowing: "skills" is the container, not a skill.
  assert.equal(skillNameFromUrl("https://example.com/skills/SKILL.md"), undefined);
  assert.equal(skillNameFromUrl("not a url"), undefined);
});
