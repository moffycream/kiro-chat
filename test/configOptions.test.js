/*
 * What the v3 engine says can be configured.
 *
 * `test/fixtures/kiro-config-options.json` is captured from kiro-cli 3.1.0, the
 * model, effort and thinking options exactly as sent: once on `auto`, which
 * takes no effort, and once on `claude-opus-4.6`, which does.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { contextWindowFrom, readSessionConfig } = require("../out/configOptions");

const CAPTURED = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "kiro-config-options.json"), "utf8")
);

test("the model list, with rates, comes out of the config options", () => {
  const config = readSessionConfig(CAPTURED.autoModel);
  assert.equal(config.currentModelId, "auto");
  assert.ok(config.models.length > 5, "the whole list");
  const opus = config.models.find((m) => m.modelId === "claude-opus-4.6");
  assert.equal(opus.creditRate, "2.2x");
  assert.deepEqual(opus.effortLevels, ["low", "medium", "high", "max"]);
  assert.equal(opus.defaultEffort, "high");
});

/** Kiro drops the option for a model with no levels, and that is the signal. */
test("auto has no effort control", () => {
  const config = readSessionConfig(CAPTURED.autoModel);
  assert.equal(config.effort, undefined);
  assert.equal(config.models.find((m) => m.modelId === "auto").effortLevels, undefined);
});

test("effort is read for a model that has it", () => {
  const { effort } = readSessionConfig(CAPTURED.opus46);
  assert.equal(effort.configId, "effortLevel");
  assert.equal(effort.current, "high");
  assert.equal(effort.defaultLevel, "high");
  assert.deepEqual(
    effort.levels.map((l) => l.value),
    ["low", "medium", "high", "max"],
    "the levels are the model's own: this one has no xhigh"
  );
});

/* `session/new` can answer before the list has been fetched. */
test("options with no model list are not a model list", () => {
  assert.equal(readSessionConfig([]), undefined);
  assert.equal(readSessionConfig(undefined), undefined);
  assert.equal(readSessionConfig([{ id: "mode", options: [] }]), undefined);
});

test("a context window is only read where Kiro calls it one", () => {
  assert.equal(contextWindowFrom("Claude Opus 5.5 model with 1M context window"), 1_000_000);
  assert.equal(contextWindowFrom("Preview with 272k context window"), 272_000);
  assert.equal(contextWindowFrom("Models chosen by task for optimal usage"), undefined);
  assert.equal(contextWindowFrom("Uses 3M tokens per run"), undefined);
  assert.equal(contextWindowFrom(undefined), undefined);
});
