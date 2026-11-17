// Where a new skill goes, and what is in it.
//
// The shape is Kiro's and was measured, not assumed: a folder per skill with
// a SKILL.md inside it, under .kiro/skills in the project or in the user's
// home. See test/progressiveContext.test.js for the report that comes back.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  SKILL_FILENAME,
  globalSkillsDir,
  skillFilePath,
  skillNameProblem,
  skillScope,
  skillScopeDir,
  skillTemplate,
  skillsDir,
} = require("../out/skillFiles");

test("a skill is a folder with a SKILL.md in it", () => {
  assert.equal(skillsDir("C:\\p"), path.join("C:\\p", ".kiro", "skills"));
  assert.equal(
    skillFilePath("project", "release-notes", "C:\\p"),
    path.join("C:\\p", ".kiro", "skills", "release-notes", SKILL_FILENAME)
  );
  assert.equal(
    skillFilePath("global", "release-notes", "C:\\p", "C:\\home"),
    path.join("C:\\home", ".kiro", "skills", "release-notes", SKILL_FILENAME)
  );
  // A global skill ignores the project root entirely — it is the same file
  // whichever folder happens to be open.
  assert.equal(skillScopeDir("global", "C:\\p", "C:\\home"), globalSkillsDir("C:\\home"));
});

/*
 * Nothing is substituted for an unknown scope, for the reason `memoryTarget`
 * gives: the shortcut it replaces was right while there were two scopes and
 * silently wrong the moment a third existed, writing a file somewhere the row
 * had not said.
 */
test("an unknown scope is refused, not rounded", () => {
  assert.equal(skillScope("project"), "project");
  assert.equal(skillScope("global"), "global");
  assert.equal(skillScope("Project"), undefined);
  assert.equal(skillScope("private"), undefined);
  assert.equal(skillScope(undefined), undefined);
  assert.equal(skillScope({ scope: "project" }), undefined);
});

test("an ordinary name is accepted", () => {
  for (const name of ["ponytail", "release-notes", "api_v2", "Notes.2024"]) {
    assert.equal(skillNameProblem(name), undefined, name);
  }
});

/*
 * Every rule here is a way the folder that gets created is not the folder
 * that was asked for — which is worse than a refusal, because the panel would
 * then report a skill under a name Kiro never sees.
 */
test("a name that would not survive being a folder is refused with a reason", () => {
  const problems = [
    "", // nothing typed
    "   ",
    ".",
    "..",
    "a/b", // would nest a level deeper, where the glob does not look
    "a\\b",
    "what?",
    'say "hi"',
    "a:b",
    "notes.", // Windows strips a trailing dot
    "con", // reserved device name
    "LPT1",
    "nul.md",
    "x".repeat(65),
  ];
  for (const name of problems) {
    const problem = skillNameProblem(name);
    assert.equal(typeof problem, "string", `${JSON.stringify(name)} should be refused`);
    assert.ok(problem.length > 0, "and say why");
  }
  /*
   * A trailing space is the user being imprecise rather than asking for
   * something impossible, so the trimmed name is what is judged — and what
   * the provider then writes. Windows would have stripped it anyway.
   */
  assert.equal(skillNameProblem(" ponytail "), undefined);
});

test("a non-string name is refused rather than coerced", () => {
  for (const value of [undefined, null, 7, {}, ["a"]]) {
    assert.equal(typeof skillNameProblem(value), "string");
  }
});

/*
 * The template spells out the mechanism, because it is the thing nobody can
 * guess and it decides whether the skill ever runs. `memoryTemplate` writes
 * its `inclusion:` line for the same reason.
 */
test("the starter file carries the frontmatter Kiro reads", () => {
  const text = skillTemplate("ponytail", "project");
  assert.match(text, /^---\nname: ponytail\ndescription: /);
  assert.match(text, /\n---\n/, "the frontmatter closes");
  assert.match(text, /# ponytail/, "and the body is headed with the name");
  assert.match(text, /this project/);
  assert.match(skillTemplate("ponytail", "global"), /every project you open/);
});

/*
 * Left as an unfinished sentence on purpose. Kiro matches on the description,
 * so filler there is a skill that never fires or fires at random — and the
 * panel's own row shows this line, so the TODO says out loud that it still
 * needs an answer.
 */
test("the description is visibly unwritten, not plausible filler", () => {
  assert.match(skillTemplate("ponytail", "project"), /description: TODO/);
});
