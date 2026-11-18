const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  readQoderUsage,
  screenText,
  fetchQoderUsage,
  QODER_USAGE_STEPS,
} = require("../out/qoderUsage");

// Qoder's `/usage` screen exactly as qodercli 1.1.91 drew it in a hidden
// pseudo-console: the trust prompt, the start screen, then the usage tab.
const SCREEN = fs.readFileSync(path.join(__dirname, "fixtures", "qoder-usage-screen.raw"), "utf8");

test("the captured screen is read into Qoder's own account rows", () => {
  const usage = readQoderUsage(SCREEN);
  assert.deepEqual(usage.rows, [
    { label: "Plan", value: "Enterprise" },
    { label: "Plan Expires At", value: "Dec 1, 2026, 00:00:00 GMT+8" },
    { label: "Plan Credits Used", value: "N/A" },
    { label: "Add-on Credits Used", value: "N/A" },
    { label: "Org Resource Package", value: "0/2000" },
  ]);
  assert.equal(usage.planName, "Enterprise");
  assert.equal(usage.expiresOn, "Dec 1, 2026");
});

test("the check's own session rows are left out; they describe the check, not you", () => {
  const labels = readQoderUsage(SCREEN).rows.map((row) => row.label);
  assert.ok(!labels.some((label) => /Duration|Code Changes/.test(label)));
});

test("a screen that is not the usage screen reads as nothing, not as an empty account", () => {
  assert.equal(readQoderUsage(""), undefined);
  assert.equal(readQoderUsage("\x1b[2J Waiting for authentication...\r\n"), undefined);
  assert.equal(readQoderUsage("Total Duration (wall) : 2.3s"), undefined);
});

test("cursor moves become the gaps they were drawn as", () => {
  assert.equal(screenText("Qoder\x1b[1CPlan\x1b[3C:\x1b[1CPro"), "Qoder Plan   : Pro");
  assert.equal(screenText("a\x1b[5;1Hb"), "a\nb");
});

test("the steps wait for Qoder rather than for a fixed time, and trust only when asked", () => {
  assert.equal(QODER_USAGE_STEPS[0], "wait:Type/trust|");
  assert.equal(QODER_USAGE_STEPS[1], "if:trust|\\r");
  assert.ok(QODER_USAGE_STEPS.includes("300|/usage"));
  assert.equal(QODER_USAGE_STEPS.at(-1), "done:Duration");
});

test("the runner hands the script Qoder's path and the steps, and decodes the answer", async () => {
  let seen;
  const usage = await fetchQoderUsage({
    command: "C:\\q\\qodercli.exe",
    script: "C:\\x\\conpty-capture.ps1",
    cwd: "C:\\tmp\\usage",
    run: async (file, args) => {
      seen = { file, args };
      return Buffer.from(SCREEN, "utf8").toString("base64");
    },
  });
  assert.equal(seen.file, "powershell.exe");
  assert.equal(seen.args[seen.args.indexOf("-Exe") + 1], "C:\\q\\qodercli.exe");
  assert.equal(seen.args[seen.args.indexOf("-Cwd") + 1], "C:\\tmp\\usage");
  assert.equal(seen.args[seen.args.indexOf("-Steps") + 1], QODER_USAGE_STEPS.join("~~"));
  assert.equal(usage.planName, "Enterprise");
});

test("a signed-out Qoder is reported as one, anything else as a missing screen", async () => {
  const answer = (text) => async () => Buffer.from(text, "utf8").toString("base64");
  await assert.rejects(
    fetchQoderUsage({ command: "q", script: "s", cwd: "c", run: answer("Not logged in · Please run /login") }),
    /sign in/
  );
  await assert.rejects(
    fetchQoderUsage({ command: "q", script: "s", cwd: "c", run: answer("something else entirely") }),
    /did not show its usage screen/
  );
});
