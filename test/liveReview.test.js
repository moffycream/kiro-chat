/*
 * Reviews arrive as the edits do.
 *
 * Every diff used to wait for `session/prompt` to resolve, so a turn that
 * edited three files showed nothing at all while it worked and then three
 * diffs in a row, each about an edit made some time ago. A step reaching a
 * terminal status is the moment its file can be looked at, and these drive
 * that path — `handleNotification` with a real `tool_call_update` — rather
 * than the end-of-turn sweep the other review tests exercise.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { fileURLToPath } = require("node:url");

const root = path.join(__dirname, "..");

/**
 * Enough of VS Code to open a review and answer it.
 *
 * `answer` is asked what to do with each file as its diff appears, by
 * basename, so a turn touching two files can accept one and reject the other.
 */
function fakeVscode(workspaceRoot, answer, settings = {}) {
  const roots = Array.isArray(workspaceRoot) ? workspaceRoot : [workspaceRoot];
  const commands = new Map();
  const visibleListeners = new Set();
  const closeDocumentListeners = new Set();
  const changeDocumentListeners = new Set();
  let contentProvider;
  let codeLensProvider;

  class EventEmitter {
    constructor() {
      this.listeners = new Set();
      this.event = (listener) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
      };
    }
    fire(value) {
      for (const listener of this.listeners) listener(value);
    }
    dispose() {
      this.listeners.clear();
    }
  }

  class Uri {
    constructor(scheme, uriPath, fsPath) {
      this.scheme = scheme;
      this.path = uriPath;
      this.fsPath = fsPath;
    }
    toString() {
      return `${this.scheme}:${this.path}`;
    }
    static parse(value) {
      const url = new URL(value);
      return new Uri(url.protocol.slice(0, -1), url.pathname, fileURLToPath(url));
    }
    static from(parts) {
      return new Uri(parts.scheme, parts.path, parts.path);
    }
    static file(fsPath) {
      return new Uri("file", String(fsPath).replace(/\\/g, "/"), fsPath);
    }
  }

  const pending = new Map();
  const api = {
    /** The files whose diff was opened, in the order they were opened. */
    reviewed: [],
    /**
     * Writes that went through a workspace edit rather than straight to disk.
     *
     * The difference is the whole of Ctrl+Z: a raw `fs.writeFile` is invisible
     * to the editor, so the document reloads with no undo entry and the change
     * is permanent as far as the user is concerned.
     */
    editorWrites: [],
    WorkspaceEdit: class {
      constructor() {
        this.operations = [];
      }
      replace(uri, _range, content) {
        this.operations.push({ uri, content });
      }
      createFile(uri, options) {
        this.operations.push({ uri, content: String(options?.contents ?? "") });
      }
    },
    Position: class {
      constructor(line, character) {
        this.line = line;
        this.character = character;
      }
    },
    workspace: {
      async applyEdit(edit) {
        for (const operation of edit.operations) {
          pending.set(operation.uri.fsPath, operation.content);
          api.editorWrites.push({ path: operation.uri.fsPath, content: operation.content });
        }
        return true;
      },
      workspaceFolders: roots.map((fsPath) => ({ name: path.basename(fsPath), uri: { fsPath } })),
      getConfiguration: () => ({
        get: (name, fallback) => (name in settings ? settings[name] : fallback),
      }),
      asRelativePath: (value) => path.basename(String(value)),
      registerTextDocumentContentProvider(_scheme, provider) {
        contentProvider = provider;
        return { dispose() {} };
      },
      async openTextDocument(uri) {
        if (uri.scheme === "file") {
          if (!fs.existsSync(uri.fsPath)) throw new Error("cannot open");
          const text = () => pending.get(uri.fsPath) ?? fs.readFileSync(uri.fsPath, "utf8");
          return {
            uri,
            getText: () => text(),
            positionAt: (offset) => ({ line: 0, character: offset }),
            get lineCount() {
              return text().split(/\r\n|\r|\n/).length;
            },
            async save() {
              if (pending.has(uri.fsPath)) {
                fs.writeFileSync(uri.fsPath, pending.get(uri.fsPath));
                pending.delete(uri.fsPath);
              }
              return true;
            },
          };
        }
        const lines = () =>
          contentProvider.provideTextDocumentContent(uri).split(/\r\n|\r|\n/);
        return {
          uri,
          get lineCount() {
            return Math.max(1, lines().length);
          },
          lineAt(line) {
            const text = lines()[line] ?? "";
            return { range: { end: { line, character: text.length } } };
          },
        };
      },
      onDidChangeTextDocument(listener) {
        changeDocumentListeners.add(listener);
        return { dispose: () => changeDocumentListeners.delete(listener) };
      },
      onDidCloseTextDocument(listener) {
        closeDocumentListeners.add(listener);
        return { dispose: () => closeDocumentListeners.delete(listener) };
      },
    },
    window: {
      visibleTextEditors: [],
      activeTextEditor: undefined,
      createTextEditorDecorationType() {
        return { dispose() {} };
      },
      async showTextDocument(document) {
        const editor = { document, selection: { active: { line: 0 } }, setDecorations() {} };
        api.window.visibleTextEditors = [editor];
        api.window.activeTextEditor = editor;
        for (const listener of visibleListeners) listener([editor]);

        // The tab is named "<file> (Working Tree)", so the real file's name is
        // what identifies which review is on screen.
        const label = decodeURIComponent(String(document.uri.path).split("/").pop() || "");
        const name = label.replace(/ \(Working Tree\)$/, "");
        api.reviewed.push(name);

        setImmediate(async () => {
          const wanted =
            answer(name) === "accept"
              ? "kiroChat.review.acceptAll"
              : "kiroChat.review.rejectAll";
          const lens = codeLensProvider
            .provideCodeLenses(document)
            .find((item) => item.command.command === wanted);
          if (lens) await commands.get(wanted)(...lens.command.arguments);
        });
        return editor;
      },
      showErrorMessage() {},
      showInformationMessage() {},
      onDidChangeVisibleTextEditors(listener) {
        visibleListeners.add(listener);
        return { dispose: () => visibleListeners.delete(listener) };
      },
    },
    languages: {
      registerCodeLensProvider(_selector, provider) {
        codeLensProvider = provider;
        return { dispose() {} };
      },
    },
    commands: {
      registerCommand(name, handler) {
        commands.set(name, handler);
        return { dispose: () => commands.delete(name) };
      },
      async executeCommand(name) {
        if (name === "workbench.action.closeActiveEditor") {
          const closing = api.window.activeTextEditor?.document;
          api.window.visibleTextEditors = [];
          api.window.activeTextEditor = undefined;
          for (const listener of visibleListeners) listener([]);
          if (closing) for (const listener of closeDocumentListeners) listener(closing);
        }
      },
    },
    Uri,
    ViewColumn: { Active: 1 },
    EventEmitter,
    ThemeColor: class {
      constructor(id) {
        this.id = id;
      }
    },
    OverviewRulerLane: { Right: 4 },
    Range: class {
      constructor(startLine, startCharacter, endLine, endCharacter) {
        this.start = { line: startLine, character: startCharacter };
        this.end = { line: endLine, character: endCharacter };
      }
    },
    CodeLens: class {
      constructor(range, command) {
        this.range = range;
        this.command = command;
      }
    },
  };
  return api;
}

function loadSession(vscode) {
  const original = Module._load;
  Module._load = function (request, ...args) {
    if (request === "vscode") return vscode;
    return original.call(this, request, ...args);
  };
  try {
    for (const key of Object.keys(require.cache)) {
      if (key.includes(`${path.sep}out${path.sep}`)) delete require.cache[key];
    }
    return require(path.join(root, "out", "kiroSession.js")).KiroSession;
  } finally {
    Module._load = original;
  }
}

function events() {
  return {
    onStatus() {},
    onText() {},
    onThought() {},
    onTool() {},
    onTurnEnd() {},
    onError() {},
    onNeedsSetup() {},
    onModels() {},
    onUsage() {},
    onCapabilities() {},
  };
}

/** A `tool_call`: the notification that names the file being edited. */
const announce = (id, file) => ({
  update: {
    sessionUpdate: "tool_call",
    toolCallId: id,
    title: `Editing ${path.basename(file)}`,
    kind: "edit",
    rawInput: { command: "strReplace", path: file },
  },
});

/** A `tool_call_update`: the only one carrying a status. */
const finished = (id, status = "completed") => ({
  update: { sessionUpdate: "tool_call_update", toolCallId: id, kind: "edit", status },
});

function workspace() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "kiro-live-"));
  return {
    folder,
    file(name, content) {
      const full = path.join(folder, name);
      fs.writeFileSync(full, content);
      return full;
    },
    read: (full) => fs.readFileSync(full, "utf8"),
    cleanup() {
      fs.rmSync(folder, { recursive: true, force: true });
    },
  };
}

function sessionOn(space, answer, settings = {}) {
  const vscode = fakeVscode(space.folder, answer, {
    allowFileWrites: true,
    reviewFileWrites: true,
    reviewDuringTurn: true,
    ...settings,
  });
  const KiroSession = loadSession(vscode);
  const logged = [];
  const session = new KiroSession({ appendLine: (line) => logged.push(line) }, events());
  session.beginTurnFileCapture([]);
  return { vscode, session, logged };
}

test("a finished edit is reviewed before the turn ends", async () => {
  const space = workspace();
  try {
    const file = space.file("example.js", "const value = 'old';\n");
    const { vscode, session } = sessionOn(space, () => "reject");

    session.handleNotification("session/update", announce("write-1", file));
    // Kiro CLI 2.21 writing the file itself, inside its own tool.
    fs.writeFileSync(file, "const value = 'new';\n");
    session.handleNotification("session/update", finished("write-1"));

    await session.reviewQueue;
    assert.deepEqual(vscode.reviewed, ["example.js"], "the diff opened during the turn");
    assert.equal(space.read(file), "const value = 'old';\n", "and rejecting put it back");
  } finally {
    space.cleanup();
  }
});

test("two edited files are reviewed one at a time, in the order they were edited", async () => {
  const space = workspace();
  try {
    const first = space.file("first.js", "one\n");
    const second = space.file("second.js", "two\n");
    const { vscode, session } = sessionOn(space, () => "accept");

    session.handleNotification("session/update", announce("write-1", first));
    fs.writeFileSync(first, "one changed\n");
    session.handleNotification("session/update", finished("write-1"));

    session.handleNotification("session/update", announce("write-2", second));
    fs.writeFileSync(second, "two changed\n");
    session.handleNotification("session/update", finished("write-2"));

    await session.reviewQueue;
    assert.deepEqual(vscode.reviewed, ["first.js", "second.js"]);
    assert.equal(space.read(first), "one changed\n");
    assert.equal(space.read(second), "two changed\n");
  } finally {
    space.cleanup();
  }
});

/*
 * The review baseline moves forward; the turn baseline does not.
 *
 * A file edited twice would otherwise show its second diff against the
 * pre-turn content, re-proposing hunks the user had already accepted with
 * nothing to tell them apart from the new edit.
 */
test("a second edit to the same file is diffed against what was accepted", async () => {
  const space = workspace();
  try {
    const file = space.file("example.js", "alpha\nbravo\n");
    const seen = [];
    const { vscode, session } = sessionOn(space, () => "accept");
    const reviewer = session.changeReviewer;
    const review = reviewer.review.bind(reviewer);
    reviewer.review = (request) => {
      seen.push({ before: request.before, after: request.after });
      return review(request);
    };

    session.handleNotification("session/update", announce("write-1", file));
    fs.writeFileSync(file, "ALPHA\nbravo\n");
    session.handleNotification("session/update", finished("write-1"));
    await session.reviewQueue;

    session.handleNotification("session/update", announce("write-2", file));
    fs.writeFileSync(file, "ALPHA\nBRAVO\n");
    session.handleNotification("session/update", finished("write-2"));
    await session.reviewQueue;

    assert.deepEqual(vscode.reviewed, ["example.js", "example.js"], "reviewed twice");
    assert.equal(seen[0].before, "alpha\nbravo\n", "the first diff is against the pre-turn file");
    assert.equal(
      seen[1].before,
      "ALPHA\nbravo\n",
      "the second is against what the first review left, not the pre-turn file"
    );
    assert.equal(seen[1].after, "ALPHA\nBRAVO\n");
  } finally {
    space.cleanup();
  }
});

/*
 * The diff is a proposal, during the turn exactly as at the end of it.
 *
 * The file goes back to what it was before the diff opens, so what is on disk
 * while you are reading is the version you have not changed your mind about
 * yet. A live review briefly left Kiro's version in place instead — and that
 * is what cost Ctrl+Z, since accepting then had nothing to write.
 */
test("the file is put back before the diff opens, during the turn too", async () => {
  const space = workspace();
  try {
    const file = space.file("example.js", "old\n");
    let onScreen;
    const { session } = sessionOn(space, () => {
      onScreen = space.read(file);
      return "accept";
    });

    session.handleNotification("session/update", announce("write-1", file));
    fs.writeFileSync(file, "new\n");
    session.handleNotification("session/update", finished("write-1"));
    await session.reviewQueue;

    assert.equal(onScreen, "old\n", "the original is on disk while the diff is open");
    assert.equal(space.read(file), "new\n", "and accepting applies the change");
  } finally {
    space.cleanup();
  }
});

/*
 * Ctrl+Z has to work on a change you accepted.
 *
 * Kiro CLI writes the file itself, and a raw disk write is invisible to the
 * editor: the document reloads with no undo entry and the change is permanent
 * as far as the user is concerned. Everything they can accept they must be
 * able to undo the ordinary way, in the file, where they are already looking —
 * so the accepted content has to travel through a workspace edit, whether the
 * review opened during the turn or at the end of it.
 */
test("a change accepted during the turn can still be undone in the editor", async () => {
  const space = workspace();
  try {
    const file = space.file("example.js", "const value = 'old';\n");
    const { vscode, session } = sessionOn(space, () => "accept");

    session.handleNotification("session/update", announce("write-1", file));
    fs.writeFileSync(file, "const value = 'new';\n");
    session.handleNotification("session/update", finished("write-1"));
    await session.reviewQueue;

    assert.equal(space.read(file), "const value = 'new';\n", "the change still has to land");
    assert.ok(
      vscode.editorWrites.some((write) => write.path.endsWith("example.js")),
      "the accepted content must go through a workspace edit, not straight to disk"
    );
  } finally {
    space.cleanup();
  }
});

test("a file already reviewed as it landed is not asked about again at the end", async () => {
  const space = workspace();
  try {
    const file = space.file("example.js", "old\n");
    const { vscode, session } = sessionOn(space, () => "accept");

    session.handleNotification("session/update", announce("write-1", file));
    fs.writeFileSync(file, "new\n");
    session.handleNotification("session/update", finished("write-1"));
    await session.reviewQueue;
    assert.equal(vscode.reviewed.length, 1);

    await session.finishDirectFileReviews();
    assert.equal(vscode.reviewed.length, 1, "the sweep found nothing left to ask about");
  } finally {
    space.cleanup();
  }
});

/*
 * The sweep is the safety net, and it has to stay one. A tool that never
 * reports finishing is exactly the case the end-of-turn pass exists for.
 */
test("a step that never reports finishing is still reviewed at the end", async () => {
  const space = workspace();
  try {
    const file = space.file("example.js", "old\n");
    const { vscode, session } = sessionOn(space, () => "reject");

    session.handleNotification("session/update", announce("write-1", file));
    fs.writeFileSync(file, "new\n");
    // No tool_call_update at all.
    await session.reviewQueue;
    assert.deepEqual(vscode.reviewed, [], "nothing opened during the turn");

    await session.finishDirectFileReviews();
    assert.deepEqual(vscode.reviewed, ["example.js"]);
    assert.equal(space.read(file), "old\n");
  } finally {
    space.cleanup();
  }
});

test("a repeated terminal status does not open the same review twice", async () => {
  const space = workspace();
  try {
    const file = space.file("example.js", "old\n");
    const { vscode, session } = sessionOn(space, () => "accept");

    session.handleNotification("session/update", announce("write-1", file));
    fs.writeFileSync(file, "new\n");
    session.handleNotification("session/update", finished("write-1"));
    session.handleNotification("session/update", finished("write-1"));
    await session.reviewQueue;

    assert.deepEqual(vscode.reviewed, ["example.js"]);
  } finally {
    space.cleanup();
  }
});

/* A tool that errored halfway can still have written part of a file. */
test("a failed step is reviewed too", async () => {
  const space = workspace();
  try {
    const file = space.file("example.js", "old\n");
    const { vscode, session } = sessionOn(space, () => "reject");

    session.handleNotification("session/update", announce("write-1", file));
    fs.writeFileSync(file, "half written\n");
    session.handleNotification("session/update", finished("write-1", "failed"));
    await session.reviewQueue;

    assert.deepEqual(vscode.reviewed, ["example.js"]);
    assert.equal(space.read(file), "old\n");
  } finally {
    space.cleanup();
  }
});

test("a step still running opens nothing", async () => {
  const space = workspace();
  try {
    const file = space.file("example.js", "old\n");
    const { vscode, session } = sessionOn(space, () => "accept");

    session.handleNotification("session/update", announce("write-1", file));
    fs.writeFileSync(file, "new\n");
    session.handleNotification("session/update", finished("write-1", "in_progress"));
    await session.reviewQueue;

    assert.deepEqual(vscode.reviewed, []);
  } finally {
    space.cleanup();
  }
});

test("stopping the turn drops reviews that have not opened", async () => {
  const space = workspace();
  try {
    const file = space.file("example.js", "old\n");
    const { vscode, session } = sessionOn(space, () => "accept");

    session.handleNotification("session/update", announce("write-1", file));
    fs.writeFileSync(file, "new\n");
    session.cancel();
    session.handleNotification("session/update", finished("write-1"));
    await session.reviewQueue;

    assert.deepEqual(vscode.reviewed, [], "a cancelled turn asks nothing");
  } finally {
    space.cleanup();
  }
});

/*
 * The kill switch. With it off the behaviour is what it was before: every diff
 * waits for the end of the turn.
 */
test("reviewDuringTurn off keeps every diff until the end of the turn", async () => {
  const space = workspace();
  try {
    const file = space.file("example.js", "old\n");
    const { vscode, session } = sessionOn(space, () => "reject", { reviewDuringTurn: false });

    session.handleNotification("session/update", announce("write-1", file));
    fs.writeFileSync(file, "new\n");
    session.handleNotification("session/update", finished("write-1"));
    await session.reviewQueue;
    assert.deepEqual(vscode.reviewed, [], "nothing opened during the turn");

    await session.finishDirectFileReviews();
    assert.deepEqual(vscode.reviewed, ["example.js"]);
    assert.equal(space.read(file), "old\n");
  } finally {
    space.cleanup();
  }
});

/*
 * Plan mode reverts rather than reviews, and reverting a file under a running
 * agent breaks its next edit. Those endings stay at the end of the turn.
 */
test("Plan mode still reverts at the end rather than reviewing as it goes", async () => {
  const space = workspace();
  try {
    const file = space.file("example.js", "old\n");
    const { vscode, session } = sessionOn(space, () => "accept");
    session.turnReadOnly = true;

    session.handleNotification("session/update", announce("write-1", file));
    fs.writeFileSync(file, "new\n");
    session.handleNotification("session/update", finished("write-1"));
    await session.reviewQueue;
    assert.deepEqual(vscode.reviewed, []);

    await session.finishDirectFileReviews();
    assert.deepEqual(vscode.reviewed, [], "Plan mode opens no diff at all");
    assert.equal(space.read(file), "old\n", "the edit was reverted");
  } finally {
    space.cleanup();
  }
});

/*
 * One file at a time, and the permission gate is what enforces it. Kiro is
 * blocked on this reply, so waiting here is the only way to stop it starting
 * the next edit while the last one is still on screen.
 */
test("an edit waits for the review already on screen", async () => {
  const space = workspace();
  try {
    const file = space.file("example.js", "old\n");
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });

    const vscode = fakeVscode(space.folder, () => "accept", {
      allowFileWrites: true,
      reviewFileWrites: true,
      reviewDuringTurn: true,
    });
    const KiroSession = loadSession(vscode);
    const session = new KiroSession({ appendLine() {} }, events());
    session.beginTurnFileCapture([]);

    // A review that does not answer itself until the test says so.
    const reviewer = session.changeReviewer;
    reviewer.review = () => held.then(() => ({ accepted: false }));

    session.handleNotification("session/update", announce("write-1", file));
    fs.writeFileSync(file, "new\n");
    session.handleNotification("session/update", finished("write-1"));

    let allowed = false;
    const next = session
      .askPermission({
        toolCall: { title: "Editing other.js", kind: "edit" },
        options: [
          { optionId: "allow-once", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      })
      .then((outcome) => {
        allowed = true;
        return outcome;
      });

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(allowed, false, "the next edit is held while a diff is unanswered");

    release();
    assert.deepEqual(await next, {
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
  } finally {
    space.cleanup();
  }
});
