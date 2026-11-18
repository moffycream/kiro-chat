const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { agentArgs, agentIdOf, agentProfile, AGENTS } = require("../out/agents");
const { forAgent } = require("../out/history");
const { readSessionConfig } = require("../out/configOptions");
const { isWriteLikeTool, isReadOnlyTool } = require("../out/writeTools");

test("an unknown or missing agent is Kiro, which is what every older setting meant", () => {
  assert.equal(agentIdOf(undefined), "kiro");
  assert.equal(agentIdOf(""), "kiro");
  assert.equal(agentIdOf("claude"), "kiro");
  assert.equal(agentIdOf("qoder"), "qoder");
});

test("Qoder starts with --acp as an option, never `acp` as a subcommand or Kiro's engine flag", () => {
  // `qodercli acp` is read as a prompt and answers "Not logged in" — measured.
  assert.deepEqual(agentArgs("qoder", [], []), ["--acp"]);
  assert.deepEqual(agentArgs("qoder", [], ["--acp", "-d"]), ["--acp", "-d"]);
  assert.deepEqual(agentArgs("kiro", [], []), ["acp", "--agent-engine", "v3"]);
});

test("attached files are linked in the form each agent can read", () => {
  const { fileLinkFor } = require("../out/agents");
  const standard = () => "file:///c%3A/w/sub%20dir/a.css";
  // Qoder drops "file://" and resolves the rest as a path, undecoded — the
  // standard form became c:\c%3A\w\... and was refused (qodercli 1.1.91).
  assert.equal(fileLinkFor("qoder", "C:\\w\\sub dir\\a.css", standard), "file://C:/w/sub dir/a.css");
  assert.equal("file://C:/w/sub dir/a.css".slice(7), "C:/w/sub dir/a.css");
  // Kiro keeps the form it has always been sent.
  assert.equal(fileLinkFor("kiro", "C:\\w\\sub dir\\a.css", standard), standard());
  const provider = fs.readFileSync(path.join(__dirname, "..", "src", "chatViewProvider.ts"), "utf8");
  assert.match(provider, /buildBlocks\(trimmed, attached, this\.selection, includeSelection, this\.session\.agentId\)/);
});

test("only Kiro carries the Kiro-only extras", () => {
  assert.equal(AGENTS.kiro.kiroExtras, true);
  assert.equal(AGENTS.qoder.kiroExtras, false);
  assert.equal(agentProfile("qoder").loginCommand, "qodercli login");
  assert.match(agentProfile("qoder").installCommand, /qoder\.com\/install\.ps1/);
});

test("history shows each agent only its own chats; a record with no agent is Kiro's", () => {
  const records = [
    { id: "a", cwd: "c:\\w" },
    { id: "b", cwd: "c:\\w", agent: "kiro" },
    { id: "c", cwd: "c:\\w", agent: "qoder" },
  ];
  assert.deepEqual(forAgent(records, "kiro").map((r) => r.id), ["a", "b"]);
  assert.deepEqual(forAgent(records, "qoder").map((r) => r.id), ["c"]);
});

/** Trimmed from `session/new` as qodercli 1.1.91 answered it. */
const QODER_CONFIG = [
  {
    type: "select",
    id: "mode",
    name: "Mode",
    category: "mode",
    currentValue: "default",
    options: [{ value: "default", name: "Default" }],
  },
  {
    type: "select",
    id: "model",
    name: "Model",
    category: "model",
    currentValue: "auto",
    options: [
      { value: "auto", name: "Auto (default)", description: "Vision · 0.30x Credit" },
      { value: "ultimate", name: "Ultimate", description: "Reasoning · Vision · 2.00x Credit" },
      { value: "efficient", name: "Efficient", description: "Vision · 0.00x Credit" },
    ],
  },
];

test("Qoder's models are read, with the rate it gives only in the description", () => {
  const config = readSessionConfig(QODER_CONFIG);
  assert.equal(config.currentModelId, "auto");
  assert.deepEqual(
    config.models.map((m) => [m.modelId, m.creditRate]),
    [
      ["auto", "0.30x"],
      ["ultimate", "2.00x"],
      ["efficient", "0.00x"],
    ]
  );
  // Qoder has a mode option but no effort option, and the mode must not be
  // mistaken for one.
  assert.equal(config.effort, undefined);
});

test("Qoder's edit and read steps are told apart, so its edits are reviewed", () => {
  // Shapes from a captured qodercli 1.1.91 turn.
  const edit = {
    kind: "edit",
    title: "Edit C:\\w\\hello.txt",
    rawInput: { file_path: "C:\\w\\hello.txt", old_string: "two", new_string: "three" },
    locations: [{ path: "C:\\w\\hello.txt" }],
  };
  const read = { kind: "read", title: "Read C:\\w\\hello.txt", locations: [{ path: "C:\\w\\hello.txt" }] };
  assert.equal(isWriteLikeTool(edit), true);
  assert.equal(isReadOnlyTool(read), true);
  assert.equal(isReadOnlyTool(edit), false);
});

test("both halves of the agent switch exist", () => {
  const js = fs.readFileSync(path.join(__dirname, "..", "media", "chat.js"), "utf8");
  const provider = fs.readFileSync(path.join(__dirname, "..", "src", "chatViewProvider.ts"), "utf8");
  assert.match(js, /type: "setAgent"/);
  assert.match(provider, /case "setAgent"/);
  assert.match(provider, /affectsConfiguration\("kiroChat\.agent"\)/);
});

test("the panel names the agent that is answering, not always Kiro", () => {
  const js = fs.readFileSync(path.join(__dirname, "..", "media", "chat.js"), "utf8");
  for (const shown of [
    "`Ask ${agentName}…`",
    "`Ask ${agentName} about your code.`",
    "roleLabel(`${agentName}`)",
    "`${agentName} wants to ${permission.title}.`",
  ]) {
    assert.ok(js.includes(shown), shown);
  }
  const session = fs.readFileSync(path.join(__dirname, "..", "out", "kiroSession.js"), "utf8");
  assert.match(session, /`\$\{this\.profile\.label\} is not connected\.`/);
});

test("Qoder's usage is fetched into the panel, never through a visible terminal", () => {
  const js = fs.readFileSync(path.join(__dirname, "..", "media", "chat.js"), "utf8");
  const panel = js.slice(js.indexOf("function renderUsagePanel()"), js.indexOf("function setUsagePanel("));
  assert.match(panel, /currentAgent !== "kiro"/);
  assert.match(panel, /type: "refreshUsage"/);
  assert.doesNotMatch(js, /openAgentUsage/);
  const provider = fs.readFileSync(path.join(__dirname, "..", "src", "chatViewProvider.ts"), "utf8");
  assert.match(provider, /rows: qoder\.rows/);
  // The capture script ships with the extension.
  const ignore = fs.readFileSync(path.join(__dirname, "..", ".vscodeignore"), "utf8");
  assert.doesNotMatch(ignore, /^resources/m);
  assert.ok(fs.existsSync(path.join(__dirname, "..", "resources", "conpty-capture.ps1")));
});

test("a refused agent switch is said out loud, not dropped", () => {
  // Right after an install the window refuses the write until it reloads, and
  // the rejection used to vanish inside the async message handler.
  const provider = fs.readFileSync(path.join(__dirname, "..", "src", "chatViewProvider.ts"), "utf8");
  const start = provider.indexOf('case "setAgent"');
  const body = provider.slice(start, provider.indexOf("case ", start + 10));
  assert.match(body, /catch \(err\)/);
  assert.match(body, /not a registered configuration/);
  assert.match(body, /workbench\.action\.reloadWindow/);
});
