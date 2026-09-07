// Which side of `acp` each kind of argument goes on.
//
// They were concatenated in front of it, so the example `kiroChat.args`
// documented for itself — ["--agent", "my-agent"] — could not start Kiro:
//
//   kiro-cli --agent my-agent acp
//   error: unexpected argument '--agent' found
//   tip: 'acp --agent' exists
//
// Measured against kiro-cli 2.20.2. Every option worth putting in that setting
// belongs to the subcommand; only the way the binary is reached comes first.
const test = require("node:test");
const assert = require("node:assert/strict");

const { acpArgs } = require("../out/acpClient");

test("the user's arguments go after acp, where the subcommand reads them", () => {
  assert.deepEqual(acpArgs([], ["--agent", "my-agent"]), ["acp", "--agent", "my-agent"]);
});

/*
 * The WSL route runs `wsl kiro-cli acp`, so the binary's own name is an
 * argument of `wsl` and has to precede the subcommand. Putting it after would
 * mean nothing runs at all.
 */
test("what it takes to reach the binary still comes first", () => {
  assert.deepEqual(acpArgs(["kiro-cli"], []), ["kiro-cli", "acp"]);
});

test("both kinds land on their own side of acp", () => {
  assert.deepEqual(
    acpArgs(["kiro-cli"], ["--model", "auto"]),
    ["kiro-cli", "acp", "--model", "auto"]
  );
});

test("acp is always run, with or without arguments", () => {
  assert.deepEqual(acpArgs([], []), ["acp"]);
});

/** A missing setting reads as undefined, and must not become ["undefined"]. */
test("nothing at all is not an argument", () => {
  assert.deepEqual(acpArgs(undefined, undefined), ["acp"]);
});
