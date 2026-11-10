// Noticing a newer Kiro CLI. "You are on the current version (3.1.0)" is what
// `kiro-cli update --check` printed. Only the words "Update available: " are
// known for the other answer, from the binary, as the CLI here was current.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  readUpdateCheck,
  runUpdateCheck,
  updateCheckArgs,
  updateCheckDue,
  CLI_UPDATE_INTERVAL_MS,
} = require("../out/cliUpdate");

test("the current version is not an update", () => {
  assert.deepEqual(
    readUpdateCheck("Checking for updates...\nYou are on the current version (3.1.0)\n"),
    { available: false }
  );
});

test("an update names the newest version on its own line", () => {
  assert.deepEqual(readUpdateCheck("Checking...\nUpdate available: 3.1.0 -> 3.2.0\n"), {
    available: true,
    version: "3.2.0",
  });
  assert.deepEqual(readUpdateCheck("Update available: \n"), { available: true });
});

test("a version elsewhere in the output is not mistaken for the update", () => {
  assert.deepEqual(readUpdateCheck("Using 9.9.9\nUpdate available: soon\n"), { available: true });
});

test("anything unreadable is no answer at all", () => {
  for (const output of ["", "error: network", undefined, null]) {
    assert.equal(readUpdateCheck(output), undefined);
  }
});

test("a check is due once a day, and when the stamp makes no sense", () => {
  const now = 1_000_000_000;
  assert.equal(updateCheckDue(now - 1000, now), false);
  assert.equal(updateCheckDue(now - CLI_UPDATE_INTERVAL_MS, now), true);
  assert.equal(updateCheckDue(undefined, now), true);
  assert.equal(updateCheckDue("yesterday", now), true);
  assert.equal(updateCheckDue(now + 1000, now), true);
});

test("the launch prefix comes first", () => {
  assert.deepEqual(updateCheckArgs(["prefix"]), ["prefix", "update", "--check"]);
});

function script(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kiro-update-"));
  const file = path.join(dir, "fake.js");
  fs.writeFileSync(file, body);
  return { command: process.execPath, launchArgs: [file] };
}

test("a real process is asked with the right arguments", async () => {
  const launch = script(
    'console.log(process.argv.slice(2).join(" ") === "update --check" ? "Update available: 1.2.3" : "wrong");'
  );
  assert.deepEqual(await runUpdateCheck(launch), { available: true, version: "1.2.3" });
});

test("a check that hangs or cannot start answers nothing, and never rejects", async () => {
  assert.equal(await runUpdateCheck(script("setInterval(() => {}, 1000);"), 300), undefined);
  assert.equal(await runUpdateCheck({ command: "Z:/no/such/file.exe", launchArgs: [] }), undefined);
});
