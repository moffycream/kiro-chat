const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const root = path.join(__dirname, "..");
const reviewer = fs.readFileSync(path.join(root, "src", "changeReviewer.ts"), "utf8");
const session = fs.readFileSync(path.join(root, "src", "kiroSession.ts"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

test("file review is enabled by default and happens before the write", () => {
  const setting = pkg.contributes.configuration.properties["kiroChat.reviewFileWrites"];
  assert.equal(setting.default, true);

  const write = session.slice(session.indexOf("private async writeFile"));
  assert.ok(write.indexOf("changeReviewer.review") < write.indexOf("fs.writeFile"));
  assert.match(write, /current\.content !== before\.content/);
});

test("the editor-tab review has obvious whole-file and per-hunk decisions", () => {
  assert.match(reviewer, /registerTextDocumentContentProvider/);
  assert.match(reviewer, /createTextEditorDecorationType/);
  assert.match(reviewer, /diffEditor\.insertedLineBackground/);
  assert.match(reviewer, /diffEditor\.removedLineBackground/);
  assert.match(reviewer, /"Accept all"/);
  assert.match(reviewer, /"Reject all"/);
  assert.match(reviewer, /title: "Accept"/);
  assert.match(reviewer, /title: "Reject"/);
  assert.match(reviewer, /registerCodeLensProvider/);

  // The numbered badge over every hunk is gone, and the labels carry no icons.
  assert.doesNotMatch(reviewer, /REVIEW CHANGE/);
  assert.doesNotMatch(reviewer, /\$\(check\)|\$\(x\)|\$\(check-all\)|\$\(close-all\)/);

  /*
   * Inlay hints look like buttons — VS Code paints them as chips — but they
   * only fire through ClickLinkGesture, which requires the trigger modifier.
   * A plain click does nothing, so they must not be the review's controls.
   */
  assert.doesNotMatch(reviewer, /registerInlayHintsProvider/);
  assert.doesNotMatch(reviewer, /InlayHintLabelPart/);
  assert.match(reviewer, /buildReviewDiff\(request\.before, request\.after, 0\)/);
  assert.match(reviewer, /applySelectedLines/);
});

test("resolved hunks collapse to the accepted side and lose their decorations", () => {
  const original = Module._load;
  Module._load = function (request, ...args) {
    if (request === "vscode") {
      return {
        Range: class {
          constructor(startLine, startCharacter, endLine, endCharacter) {
            this.start = { line: startLine, character: startCharacter };
            this.end = { line: endLine, character: endCharacter };
          }
        },
      };
    }
    return original.call(this, request, ...args);
  };
  let renderReview;
  try {
    ({ renderReview } = require(path.join(root, "out", "changeReviewer.js")));
  } finally {
    Module._load = original;
  }
  const { buildReviewDiff } = require(path.join(root, "out", "lineDiff.js"));
  const before = "first\nkeep 1\nkeep 2\nkeep 3\nkeep 4\nkeep 5\nkeep 6\nkeep 7\nlast\n";
  const after =
    "changed first\nkeep 1\nkeep 2\nkeep 3\nkeep 4\nkeep 5\nkeep 6\nkeep 7\nchanged last\n";
  const diff = buildReviewDiff(before, after);
  const pending = renderReview(before, after, diff, new Map());

  assert.equal(diff.hunks.length, 2);
  assert.equal(pending.hunks.size, 2);
  assert.equal(pending.deleted.length, 2);
  assert.equal(pending.inserted.length, 2);
  assert.match(pending.content, /first[\s\S]*changed first/);

  const firstAccepted = renderReview(before, after, diff, new Map([[0, true]]));
  assert.equal(firstAccepted.hunks.size, 1);
  assert.equal(firstAccepted.deleted.length, 1);
  assert.equal(firstAccepted.inserted.length, 1);
  assert.doesNotMatch(firstAccepted.content, /^first$/m);
  assert.match(firstAccepted.content, /^changed first$/m);

  const mixed = renderReview(before, after, diff, new Map([[0, true], [1, false]]));
  assert.equal(mixed.hunks.size, 0);
  assert.equal(mixed.deleted.length, 0);
  assert.equal(mixed.inserted.length, 0);
  assert.match(mixed.content, /^changed first$/m);
  assert.match(mixed.content, /^last$/m);
  assert.doesNotMatch(mixed.content, /^changed last$/m);
});

test("closing or cancelling a review rejects pending writes", () => {
  assert.match(reviewer, /onDidCloseTextDocument/);
  assert.match(reviewer, /rejectAll/);
  assert.match(reviewer, /accepted: false/);
  assert.match(session, /cancel\(\)[\s\S]*changeReviewer\.cancelPending/);
});

test("Kiro built-in FileWrite tools are staged even when they bypass the ACP callback", () => {
  assert.match(session, /beginTurnFileCapture\(usable\)/);
  assert.match(session, /observeToolPaths\(update\)/);
  assert.match(session, /finishDirectFileReviews\(\)/);
  assert.match(session, /restoreSnapshot\(tracked\.before\)/);
  assert.match(session, /expectedToolResult/);
});

test("the file boundary checks every open root in a multi-root workspace", () => {
  // The walk over the roots — and the symlink resolution that goes with it —
  // lives in workspacePaths.isInsideAnyRoot, exercised directly in
  // test/workspaceBoundary.test.js. What has to hold here is that the boundary
  // hands it *every* open root rather than only the cwd.
  assert.match(session, /isInsideAnyRoot\(this\.workspaceRoots\(\)/);
  assert.match(session, /outside the open folders/);
});

/*
 * Issue #2: a review for a file that has since been removed is abandoned, not
 * rejected. Rejecting would restore an "original" that never existed;
 * `abandonReview` just closes the diff and resolves it as declined, leaving
 * disk untouched.
 */
test("abandonReview closes a stale review without touching disk", () => {
  const from = reviewer.indexOf("async abandonReview(");
  assert.ok(from > -1, "abandonReview exists");
  const body = reviewer.slice(from, reviewer.indexOf("\n  }", from));
  assert.match(body, /request\.sourcePath !== sourcePath/, "only for the matching path");
  assert.match(body, /this\.finish\(review, \{ accepted: false \}\)/, "closes without applying");
  // It must not restore or write — that is the whole point.
  assert.doesNotMatch(body, /rejectAll|applyDecision|writeFile/);
});

/*
 * Issue #3: a deliberate whole-file reject tells the session, so a running
 * turn can be interrupted. Fired from the chat bar's reject and the editor's
 * "Reject all" — but never from a hunk decision, a tab-close, or a turn that
 * is already being cancelled.
 */
test("a whole-file reject notifies through onWholeFileRejected", () => {
  assert.match(reviewer, /onWholeFileRejected: \(\(\) => void\) \| undefined/, "the hook exists");

  // The chat-bar reject fires it.
  const rejectActive = reviewer.slice(reviewer.indexOf("async rejectActive("));
  const activeBody = rejectActive.slice(0, rejectActive.indexOf("\n  }"));
  assert.match(activeBody, /this\.onWholeFileRejected\?\.\(\)/, "chat-bar reject notifies");

  // The editor "Reject all" command fires it after the reject completes.
  const cmd = reviewer.slice(reviewer.indexOf("registerCommand(REJECT_ALL"));
  const cmdBody = cmd.slice(0, cmd.indexOf("}),"));
  assert.match(cmdBody, /onWholeFileRejected\?\.\(\)/, "editor reject-all notifies");

  // The session interrupts a running turn on that signal.
  const wire = session.slice(session.indexOf("this.changeReviewer.onWholeFileRejected"));
  const wireBody = wire.slice(0, wire.indexOf("\n    };") + 6);
  assert.match(wireBody, /this\.status === "busy"/, "only mid-turn");
  assert.match(wireBody, /this\.cancel\(\)/, "and it cancels the turn");
});
