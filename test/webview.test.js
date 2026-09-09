// Guards for the webview assets. These are the failures that show up as
// "the UI is buggy" and that nothing else in the build would catch.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(root, "media", "chat.css"), "utf8");
const js = fs.readFileSync(path.join(root, "media", "chat.js"), "utf8");
const provider = fs.readFileSync(path.join(root, "src", "chatViewProvider.ts"), "utf8");
const reviewer = fs.readFileSync(path.join(root, "src", "changeReviewer.ts"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

test("sparse tool updates preserve names and do not multiply Working rows", () => {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(sliceFrom(js, "function mergeToolStep(previous, incoming)"), sandbox);
  const merge = sandbox.mergeToolStep;
  for (let i = 0; i < 50; i++) {
    assert.equal(merge(null, { id: `chunk-${i}`, title: "Working", status: "running" }), null);
  }
  const first = merge(null, {
    id: "read-1", title: "Reading package.json", status: "running", purpose: "Check version",
  });
  const completed = merge(first, { id: "read-1", title: "Working", status: "completed" });
  assert.equal(completed.title, "Reading package.json");
  assert.equal(completed.purpose, "Check version");
  assert.equal(completed.status, "completed");
  assert.equal(merge(completed, { id: "read-1", title: "Read package.json", status: "completed" }).title,
    "Read package.json");
  assert.ok(merge(null, { title: "Working", purpose: "Inspect the application" }),
    "a meaningful purpose must not be hidden");
  assert.match(sliceFrom(js, 'case "tool":'), /if \(!tool\) break;/);
  assert.match(sliceFrom(js, "function restoreHistory(saved)"), /filter\(\(tool\) => mergeToolStep\(null, tool\)\)/);
});

/**
 * One function's source, from its opening line to the next one at the same
 * indent.
 *
 * Never `slice(0, someNumber)`. Nine tests used a fixed character count and
 * every one of them failed for a comment being added above the line it wanted,
 * which says nothing about whether the code is right.
 */
function sliceFrom(source, marker) {
  const start = source.indexOf(marker);
  if (start === -1) return "";
  const indent = " ".repeat(source.slice(0, start).match(/[ \t]*$/)[0].length);
  const rest = source.slice(start + marker.length);
  /*
   * The next thing at the same indent — and in a TypeScript class that is a
   * member, not a `function`. Without those spellings the slice ran past the
   * end of a method into the one after it, so an assertion could be satisfied
   * by code it was not looking at.
   */
  const next =
    "function |const |let |case |private |public |protected |async |get |// ---|/\\*";
  const end = rest.search(new RegExp(`\\n${indent}(${next})`));
  return marker + (end === -1 ? rest : rest.slice(0, end));
}

test("chat.js is valid JavaScript", () => {
  assert.doesNotThrow(() => new vm.Script(js, { filename: "chat.js" }));
});

test("session context shows estimates, guidance, and clears unavailable readings", () => {
  function element() {
    return {
      children: [], style: {}, attributes: {}, textContent: "",
      appendChild(child) { this.children.push(child); },
      append(...children) { this.children.push(...children); },
      setAttribute(key, value) { this.attributes[key] = value; },
    };
  }
  const sandbox = {
    usage: { contextPercent: 10 },
    models: [{ modelId: "test", contextWindowTokens: 1000000 }],
    currentModelId: "test", document: { createElement: element }, usagePanel: element(),
  };
  vm.createContext(sandbox);
  for (const name of ["credits", "contextState", "contextTokens", "renderContextPanel"]) {
    vm.runInContext(sliceFrom(js, `function ${name}(`), sandbox);
  }
  const contents = (node) => [node.textContent, ...node.children.map(contents)].join(" ");
  const draw = (percent) => {
    sandbox.usage = percent === undefined ? {} : { contextPercent: percent };
    sandbox.usagePanel = element();
    vm.runInContext("renderContextPanel()", sandbox);
    return contents(sandbox.usagePanel);
  };
  assert.match(draw(10), /≈100k tokens.*≈900k tokens.*No reset is needed/);
  assert.match(draw(80), /Context is filling up/);
  assert.match(draw(95), /Context is nearly full/);
  assert.match(draw(20), /No reset is needed/, "a lower reading after compaction replaces the warning");
  const empty = draw(undefined);
  assert.match(empty, /Not reported/);
  assert.doesNotMatch(empty, /≈|No reset is needed/, "a new session must not inherit an estimate");
  sandbox.models = [];
  assert.match(draw(25), /Used 25%.*Remaining 75%/);
  assert.doesNotMatch(draw(25), /≈/, "an unknown capacity must not invent token counts");
});

test("the composer offers and persists all requested workflow modes", () => {
  for (const label of ["Default", "Spec", "Quick Spec", "Bug Fix", "Plan"]) {
    assert.match(js, new RegExp(`label: "${label}"`));
  }
  assert.match(provider, /id="mode-btn"/);
  assert.match(provider, /id="mode-menu"/);
  assert.match(js, /mode: currentModeId/, "the selected mode must go with each request");
  assert.match(js, /mode: currentModeId[\s\S]*vscode\.setState|vscode\.setState\([\s\S]*mode: currentModeId/);
  assert.match(js, /setMode\(currentModeId, false\)/, "restoring a mode must not erase history");
  assert.match(css, /^\.mode-row \{/m);
});

test("tool permission choices are shown inside the chat instead of a modal", () => {
  const session = fs.readFileSync(path.join(root, "src", "kiroSession.ts"), "utf8");
  const permission = session.slice(session.indexOf("private async askPermission"));
  assert.match(provider, /onPermission:/, "the provider must own permission interaction");
  assert.match(provider, /permissionDecision/, "the chat must return the chosen option");
  assert.match(js, /case "permission"/, "the webview must render permission requests");
  assert.match(js, /permission-card/, "permission choices need an inline card");
  assert.match(css, /^\.permission-card \{/m, "the inline permission card needs a style");
  assert.doesNotMatch(
    permission.slice(0, 1800),
    /modal:\s*true/,
    "permission requests must not open a modal popup"
  );
});

/**
 * The panel toggles four elements with the hidden attribute. Every one of them
 * also has an author rule setting display, and an author rule beats the
 * browser's own [hidden] { display: none }. Without the override below, the
 * attach menu, the drop overlay, the usage strip and the chip row are all
 * painted permanently.
 */
test("the hidden attribute wins over our own display rules", () => {
  const override = css.match(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
  assert.ok(override, "chat.css must force [hidden] to display: none");

  for (const id of ["chips", "usage-bar", "dropzone", "attach-menu", "usage-panel"]) {
    assert.ok(
      new RegExp(`\\.hidden\\s*=|${id}`).test(js),
      `chat.js should still manage #${id}`
    );
  }

  // The override has to sit above the component rules it is undoing. `.icon`
  // joined this list when Stop became an icon button: it is toggled with
  // `hidden` and now carries `display: inline-flex`.
  const overrideAt = css.indexOf(override[0]);
  for (const selector of [
    ".chips {",
    ".usage-bar {",
    ".dropzone {",
    ".popup {",
    ".usage-panel {",
    ".icon {",
    // The pinned permission bar joined this list when the card stopped living
    // in the transcript: it is toggled with `hidden` and sets `display: flex`.
    ".permission-bar {",
  ]) {
    const at = css.indexOf(selector);
    assert.ok(at > -1, `${selector} should exist`);
    assert.ok(at > overrideAt, `${selector} must come after the [hidden] override`);
  }
  assert.match(js, /stopBtn\.hidden = /, "Stop is toggled with the hidden attribute");
});

/*
 * The row was sized three different ways — the attach button by fixed pixels,
 * the pickers by their own padding, Send by the global button padding — so
 * nothing in it lined up.
 */
test("every control in the composer row is one height", () => {
  assert.match(css, /\.composer-row \{[^}]*--control-h: \d+px/);
  /*
   * One selector covering every control, not a list of paths to each of them.
   * The enumerated version only held the controls it happened to name, so one
   * moved into a different wrapper would quietly drop out and go back to
   * sizing itself.
   */
  const rule = css.match(/\.composer-row :is\(([^)]*)\) \{([^}]*)\}/);
  assert.ok(rule, "the row has to hand its height to every control at once");
  for (const cls of [".icon", ".mode-btn", ".model-btn"]) {
    assert.ok(rule[1].includes(cls), `${cls} must be covered by that one rule`);
  }
  assert.match(rule[2], /height: var\(--control-h\)/);
  assert.match(rule[2], /min-height: var\(--control-h\)/, "so content cannot push one taller");

  // Square: the icon buttons take their width from the same number.
  assert.match(css, /^\.icon \{[^}]*width: var\(--control-h/m);
});

/*
 * A chevron on the right said only "this opens", which a click discovers
 * anyway, while costing width in a panel that has none to spare. The icon
 * leads instead, and it says which picker this is.
 */
test("the pickers lead with an icon and Send and Stop are icons", () => {
  const row = provider.slice(provider.indexOf('<div class="composer-row">'));
  const markup = row.slice(0, row.indexOf("</div>\n  </form>"));
  assert.doesNotMatch(markup, /class="caret"/, "no chevrons in the composer row");
  assert.match(markup, /<svg class="btn-icon"[\s\S]*?<span id="mode-label">/, "icon before label");
  assert.match(markup, /<svg class="btn-icon"[\s\S]*?<span id="model-label">/);

  // A button with no text needs a name for anyone not looking at it.
  for (const id of ["send", "stop"]) {
    const button = markup.slice(markup.indexOf(`id="${id}"`));
    assert.match(button.slice(0, 400), /aria-label="/, `#${id} must be labelled`);
    assert.match(button.slice(0, 400), /<svg /, `#${id} must be an icon`);
  }
  assert.doesNotMatch(markup, />Send</, "Send is no longer a word");
  assert.doesNotMatch(markup, />Stop</);
});

test("each toggled element has exactly one rule block", () => {
  for (const selector of [".dropzone", ".chips", ".usage-bar", ".popup", ".usage-panel"]) {
    const matches = css.match(new RegExp(`^\\${selector} \\{`, "gm")) ?? [];
    assert.equal(matches.length, 1, `${selector} is defined ${matches.length} times`);
  }
});

/*
 * Every plain-looking button has to cancel the global button hover as well as
 * the global button background.
 *
 * `button { background: var(--vscode-button-background) }` is undone by a
 * class rule, but `button:hover` is a type plus a pseudo-class — specificity
 * (0,1,1) — and beats any single class. So a button that only sets
 * `background: none` sits transparent at rest and then paints solid primary
 * blue the moment the pointer crosses it. That has now shipped three times:
 * the usage strip, the review summary line, and the past-chats rows, where it
 * covered the row's own hover tint with a blue slab.
 */
test("a button styled to look plain cancels the global hover too", () => {
  // Comments sit between rules, so they land in the selector unless dropped.
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)];
  const hovered = new Set();
  const plain = [];
  for (const [, rawSelector, body] of rules) {
    for (const selector of rawSelector.split(",").map((s) => s.trim().replace(/\s+/g, " "))) {
      if (selector.includes(":hover")) hovered.add(selector.replace(":hover", ""));
      // Only the ones that are buttons; `background: none` on a <code> block
      // has no global rule to fight.
      if (/background:\s*none/.test(body) && /border:\s*none/.test(body)) {
        plain.push(selector);
      }
    }
  }
  assert.ok(plain.length >= 4, `expected several plain buttons, found ${plain.length}`);
  const missing = plain.filter((selector) => !hovered.has(selector));
  assert.deepEqual(
    missing,
    [],
    `these paint solid blue on hover because nothing outranks button:hover: ${missing.join(", ")}`
  );
});

/*
 * A selection always comes from the file you are looking at, so while one is
 * being sent the chip row named the same file twice — "media/chat.js" beside
 * "media/chat.js:26-26  1 line". The narrower chip says everything the
 * broader one did, so it stands for both; switch the selection off and the
 * file chip comes back, because then it is the only thing still going.
 */
test("the file chip and the selection chip do not both name the same file", () => {
  assert.match(
    js,
    /const sendingSelection = Boolean\(\s*\n?\s*selection && selection\.hasSelection && includeSelection/,
    "whether the highlighted lines are going is one question"
  );
  assert.match(
    js,
    /const selectionCoversActiveFile = sendingSelection && includeActiveFile;/,
    "and whether the selection chip may stand in for the file chip is another"
  );
  const render = js.slice(js.indexOf("function renderChips()"));
  const body = render.slice(0, render.indexOf("\n  function "));
  assert.match(body, /if \(selectionCoversActiveFile\) \{/, "which suppresses the file chip");
  assert.doesNotMatch(body, /chip-count/, "the range already says how many lines it is");
  assert.doesNotMatch(body, /lineCount/);
  assert.doesNotMatch(css, /\.chip-count/, "and the rule for it is gone too");
  assert.doesNotMatch(provider, /lineCount:/, "so the provider need not send it");

  // A sidebar is narrow, and the folder is one the user is already in.
  assert.match(js, /function fileName\(pathish\)/, "chips show the name, not the path");
  assert.match(body, /fileName\(selection\.relativePath\)/);
  assert.match(body, /fileName\(activeFile\.label\)/);

  /*
   * And the same in the sent message, which had its own copy of the problem:
   * a message sent with a highlight carried both "media/chat.js" and
   * "media/chat.js:23-27" under it — the same file twice, one of them saying
   * strictly less.
   */
  const bubble = js.slice(js.indexOf("function addUserBubble(message)"));
  const tags = bubble.slice(0, bubble.indexOf("messagesEl.appendChild(node)"));
  assert.match(tags, /samePathish\(a\.label, selected\)/, "the range stands in for the file");
  // Only for the file that was added automatically, though. One attached by
  // hand is a separate thing the user did and is still sent as its own link,
  // so hiding it would leave no record in the transcript that it went.
  assert.match(
    tags,
    /a\.source === "active" && samePathish/,
    "and only the automatic one may be stood in for"
  );
  assert.match(provider, /source: a\.source \?\? "user"/, "so the provider has to say which");
  assert.match(tags, /replace\(\/:\\d\+-\\d\+\$\/, ""\)/, "which means stripping the range off");
  assert.match(tags, /fileName\(a\.label\)/, "and both are named, not pathed");
  assert.match(tags, /fileName\(selected\)/);
});

/*
 * The selection chip reports the highlight; it is not a control.
 *
 * Its × switched off sending the highlighted code, which left the editor
 * showing a selection the panel had quietly decided not to send — two places
 * disagreeing, with nothing on screen saying which was true. Clearing the
 * highlight is the one way to stop it, and that is the editor's job.
 */
test("the selection chip cannot be dismissed while the code is highlighted", () => {
  const render = js.slice(js.indexOf("function renderChips()"));
  const body = render.slice(0, render.indexOf("\n  function "));
  // These files are CRLF, so slice on a pattern rather than a literal newline.
  const from = body.search(/if \(sendingSelection\) \{\s*\n\s*const chip/);
  assert.ok(from > -1, "the selection chip block should be findable");
  const chip = body.slice(from);
  const to = chip.search(/for \(const a of attachments\)/);
  assert.ok(to > -1, "and it should end before the attachment chips");
  const upToNext = chip.slice(0, to);
  assert.doesNotMatch(upToNext, /chip-x/, "the selection chip must carry no dismiss button");
  assert.doesNotMatch(upToNext, /includeSelection = false/);
  assert.doesNotMatch(body, /includeSelection = true/, "and no add-it-back chip either");

  // With no per-message choice left, the setting is the only thing deciding.
  assert.doesNotMatch(js, /restoredChoice/, "a restored panel has no choice to protect");
  // The setting always wins, and it now arrives as one of the five the panel
  // reports rather than in a `defaults` message of its own — one writer for
  // `includeSelection`, not two.
  assert.match(
    js,
    /if \(typeof settings\.sendSelection === "boolean"\) \{/,
    "so the setting always wins"
  );
  assert.doesNotMatch(js, /case "defaults":/, "and it has one message, not two");
  assert.doesNotMatch(provider, /type: "defaults"/);
  assert.doesNotMatch(
    manifest.contributes.configuration.properties["kiroChat.sendSelection"].description,
    /per message using the chip/,
    "and the setting must not promise a toggle that is gone"
  );
});

/*
 * A code block you cannot get out of the panel is half a code block.
 *
 * The button has to be wired by delegation: a streaming reply rebuilds its
 * markdown on every frame, so a listener bound to the button itself would be
 * thrown away several times a second and the control would go dead mid-reply.
 */
test("code blocks can be copied", () => {
  assert.match(js, /class="code-block"/, "the block needs a wrapper to position on");
  assert.match(js, /class="code-copy"/);
  assert.match(css, /^\.code-block \{[^}]*position: relative/m);
  assert.match(css, /^\.code-copy \{/m);

  assert.match(
    js,
    /messagesEl\.addEventListener\("click"/,
    "the copy must be delegated from the transcript, not bound per button"
  );
  const handler = js.slice(js.indexOf('messagesEl.addEventListener("click"'));
  const body = handler.slice(0, handler.indexOf("\n  });"));
  assert.match(body, /closest\(["']\.code-copy["']\)/);
  // Reading the rendered element means what is copied is what is on screen,
  // with no second escaping pass to get wrong.
  assert.match(body, /querySelector\("code"\)/);
  assert.match(body, /copyText\(code\.textContent\)/);
  assert.match(body, /isConnected/, "a mid-render button must not be written to");

  // Something has to happen when the clipboard is refused, or the button
  // looks broken.
  assert.match(body, /selectNodeContents\(code\)/, "failing over to a selection");
  assert.match(js, /document\.execCommand\("copy"\)/, "and to the older API");

  // Hover is not the only way to reach it.
  assert.match(css, /\.code-copy:focus-visible/);
});

/*
 * Between pressing Send and the first token — however long Kiro spends
 * thinking and running tools — the transcript said nothing at all, so a slow
 * turn was indistinguishable from a dead one. The only sign was the status
 * dot at the very top of the panel, nowhere near where the answer lands.
 */
/*
 * Windows line endings used to leave a carriage return inside every code
 * block. The fence pattern consumed `\n` after the language but not `\r\n`,
 * so the `\r` was captured as the first character of the code — and `<pre>`
 * renders a lone `\r` as a break, so every snippet came out with a blank line
 * above and below it that was not even visibly whitespace.
 */
test("code blocks survive Windows line endings", () => {
  const render = js.slice(js.indexOf("function renderMarkdown(rawSource)"));
  const body = render.slice(0, render.indexOf("\n  // ---"));
  assert.match(
    body,
    /String\(rawSource\)\.replace\(\/\\r\\n\?\/g, "\\n"\)/,
    "line endings must be normalised before anything parses the text"
  );
  // The newline before a closing fence belongs to the fence, and so does any
  // indent in front of it.
  assert.match(body, /code\.replace\(\/\\n\[ \\t\]\*\$\/, ""\)/);
});

/*
 * A fence only opens a block at the start of a line.
 *
 * Matching ``` anywhere meant a run of backticks *inside a sentence* — "uses
 * longer fences (````)", a shell snippet quoted inline, anything discussing
 * markdown — opened a code block and swallowed the whole rest of the reply
 * into it as code. The more a reply talked about code, the more likely it was
 * to be destroyed.
 */
test("backticks inside a sentence do not open a code block", () => {
  const render = js.slice(js.indexOf("function renderMarkdown(rawSource)"));
  const body = render.slice(0, render.indexOf("\n  // ---"));
  const fence = body.match(/const FENCE = (\/.*\/gm);/);
  assert.ok(fence, "the fence pattern should be named and anchored");

  assert.match(fence[1], /^\/\^\[ \\t\]\{0,3\}```/, "the opening fence must start a line");
  assert.match(fence[1], /\^\[ \\t\]\{0,3\}```\[ \\t\]\*\$/, "and so must the closing one");
  assert.ok(fence[1].endsWith("/gm"), "which needs the multiline flag");

  /*
   * `$` under `m` means end of *line*, so using it for the unterminated case
   * would cut every block at its first newline — and a streaming reply is
   * unterminated for as long as it is arriving.
   */
  assert.match(fence[1], /\(\?!\[\\s\\S\]\)/, "end-of-string, not end-of-line");

  // Exercise it, so the assertions above are about behaviour and not shape.
  const pattern = new RegExp(fence[1].slice(1, -3), "gm");
  const inline = "uses longer fences (````)\n3. next item\n4. another";
  assert.equal(pattern.test(inline), false, "a mid-line run of backticks is not a fence");
  pattern.lastIndex = 0;
  assert.equal(pattern.test("```js\nlet a = 1;\n```"), true, "a real fence still opens");
  pattern.lastIndex = 0;
  assert.equal(pattern.test("```js\nlet a = 1;"), true, "and an unfinished one still renders");
});

/**
 * The markdown renderer, lifted out of `chat.js` and actually run.
 *
 * Everything from `escapeHtml` to the end of `renderMarkdown` is contiguous
 * and depends on nothing outside itself, so it evaluates on its own. Asserting
 * on the shape of the source can only say the code looks right; a reply
 * arriving unreadable is a behaviour, and these are the tests that can check
 * the behaviour rather than the spelling.
 */
function loadRenderer() {
  const from = js.indexOf("function escapeHtml");
  const to = js.indexOf("async function copyText");
  assert.ok(from > -1 && to > from, "the renderer should be findable in chat.js");
  return new Function(js.slice(from, to) + "\nreturn renderMarkdown;")();
}

/*
 * Tables came out as a wall of pipes.
 *
 * Every row fell through to the paragraph branch, so each became its own <p>
 * with a margin between, and `|---|---|` printed as literal dashes. Agents
 * answer with tables constantly — any "here is the mapping" reply is one — so
 * this was most of a long answer arriving unreadable.
 */
test("a pipe table is rendered as a table", () => {
  const html = loadRenderer()(
    "Here is the mapping:\n\n" +
      "| Case | Condition |\n|---|---|\n" +
      "| SOURCE_NOT_RENEWABLE | `isRenewableSource()` is false |\n" +
      "| RENEWAL_IN_PROGRESS | a sibling exists |\n\n" +
      "Note the order."
  );
  assert.match(html, /<table>/, "a pipe table has to become a table");
  assert.equal((html.match(/<tr>/g) ?? []).length, 3, "a header row and two body rows");
  assert.match(html, /<th>Case<\/th>/);
  assert.match(
    html,
    /<td><code>isRenewableSource\(\)<\/code> is false<\/td>/,
    "cells are inline markdown, not flat text"
  );
  assert.doesNotMatch(html, /\|---\|/, "and the delimiter row is not printed as content");
  assert.doesNotMatch(html, /<p>\|/, "no row may fall through to a paragraph");

  // A table is the one thing in a reply with a width of its own, and this
  // panel is often a sidebar. It scrolls inside itself or it widens the
  // whole transcript.
  assert.match(html, /class="table-wrap"/);
  assert.match(css, /^\.table-wrap \{/m);
  assert.match(css, /overflow-x: auto/);
});

/*
 * A table asks for the width its content needs — no more, no less.
 *
 * Two versions of this were wrong in opposite directions.
 * `overflow-wrap: anywhere` broke words at any character, so the first column
 * — in a mapping table always an identifier — rendered as "SOURCE_NOT_REN /
 * EWABLE". A flat `min-width: 8em` per cell fixed that and priced every table
 * the same, so "| a | b | c |" scrolled in a panel with room to spare.
 *
 * Letting the content ask for its own width does both, and is the browser's
 * default: the job is to not override it.
 */
test("a table is as wide as its content, and never breaks a word", () => {
  const rule = css.slice(css.indexOf(".table-wrap th,"));
  // Declarations only. The comment inside this rule names the values it
  // rejected, and reading those as declarations failed the test on its own
  // explanation.
  const body = rule.slice(0, rule.indexOf("\n}")).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(body, /overflow-wrap: normal/, "a word is never broken");
  assert.match(body, /word-break: normal/);
  assert.doesNotMatch(body, /overflow-wrap: (anywhere|break-word)/, "not even as a last resort");
  assert.doesNotMatch(body, /min-width:/, "and a short table must not be priced like a long one");
});

/*
 * A rule under the header and hairlines between rows, not a full grid.
 * Bordering every cell draws the container rather than the content, and at
 * chat width the vertical lines are pure noise.
 */
test("a table reads as prose, not as a spreadsheet", () => {
  assert.match(css, /^\.table-wrap th \{[^}]*border-bottom:/m, "the header gets a rule");
  assert.match(css, /^\.table-wrap tbody tr \+ tr td \{[^}]*border-top:/m, "rows get hairlines");
  const cells = css.slice(css.indexOf(".table-wrap th,"));
  assert.doesNotMatch(
    cells.slice(0, cells.indexOf("}")),
    /^\s*border: /m,
    "and no cell draws a box around itself"
  );
  assert.doesNotMatch(css, /\.table-wrap tbody tr:nth-child/, "no zebra striping either");
});

test("column alignment markers are honoured", () => {
  const html = loadRenderer()("| L | C | R |\n|:---|:---:|---:|\n| a | b | c |");
  assert.match(html, /<th style="text-align:center">C<\/th>/);
  assert.match(html, /<th style="text-align:right">R<\/th>/);
  assert.match(html, /<td style="text-align:right">c<\/td>/, "the body follows the header");
  assert.doesNotMatch(html, /text-align:left/, "left is the default, not a style to write");
});

/*
 * The guard matters more than the feature. A line with a pipe in it above a
 * line of dashes is ordinary prose over a horizontal rule, and turning that
 * into a table would be a worse bug than the one being fixed — which is why
 * the delimiter's cell count has to match the header's, as GFM says.
 */
test("prose that merely contains a pipe is not a table", () => {
  const render = loadRenderer();
  assert.doesNotMatch(render("use grep | wc -l for this\n---\nnext"), /<table>/);
  assert.doesNotMatch(
    render("| a | b | c |\n|---|---|\n| 1 | 2 | 3 |"),
    /<table>/,
    "the delimiter has to describe the same number of columns"
  );
  assert.doesNotMatch(
    render("```js\nconst a = b | c;\n```"),
    /<table>/,
    "and a fenced block is never read for tables at all"
  );
});

test("a short row is padded rather than dropped", () => {
  // A ragged table still reads; a missing cell shifts every column after it.
  const html = loadRenderer()("| a | b | c |\n|---|---|---|\n| 1 |");
  assert.equal((html.match(/<td/g) ?? []).length, 3, "the row keeps its columns");
});

test("tables without outer pipes still count", () => {
  assert.match(loadRenderer()("a | b\n--- | ---\n1 | 2"), /<th>a<\/th>/);
});

/*
 * Kiro says something, calls a tool, then says something else — and all of it
 * was appended to one buffer with nothing between, so the two ran together
 * with no space at all: "…rather than guessing from names.I notice
 * RENEWAL_WINDOW_CLOSED…". Nothing in the stream separates one message from
 * the next, but a step starting is a boundary that can be seen.
 */
test("text that resumes after a tool step starts a new paragraph", () => {
  assert.match(js, /let breakBeforeText = false;/, "the boundary needs somewhere to live");

  const chunk = js.slice(js.indexOf('case "chunk": {'));
  const chunkBody = chunk.slice(0, chunk.indexOf('case "tool": {'));
  assert.ok(
    chunkBody.includes("if (breakBeforeText && buffer && !/\\n\\s*$/.test(buffer))"),
    "a break is inserted only when there is text to break from, and none already"
  );
  assert.ok(chunkBody.includes('buffer += "\\n\\n";'), "and it is a paragraph break");
  assert.match(chunkBody, /breakBeforeText = false;/, "consumed, so it fires once");

  /*
   * Set where a row is *created*, never on a status update for a step already
   * on screen — those arrive while text is still streaming and would split a
   * sentence down the middle, which is the same bug pointing the other way.
   */
  const tool = js.slice(js.indexOf('case "tool": {'));
  const toolBody = tool.slice(0, tool.indexOf("\n      case "));
  const created = toolBody.slice(toolBody.indexOf("if (!row) {"), toolBody.indexOf("startThinking()"));
  assert.match(created, /breakBeforeText = true;/, "a step Kiro has just decided on");
  assert.equal(
    (toolBody.match(/breakBeforeText = true;/g) ?? []).length,
    1,
    "and only there — a status update for a listed step is not a boundary"
  );
});

test("the transcript says when Kiro is working, and for how long", () => {
  assert.match(js, /function startThinking\(\)/);
  assert.match(js, /function stopThinking\(/);
  assert.match(js, /function elapsedText\(ms\)/, "a stuck turn is told from a slow one by time");
  assert.match(css, /^\.steps-time \{/m);

  const sent = js.slice(js.indexOf('case "userMessage":'));
  assert.match(
    sent.slice(0, 400),
    /startThinking\(\)/,
    "it must go in when the message is sent, not when the reply starts"
  );

  // The clock has to keep running while the reply streams — that is the whole
  // point of it — so only the end of the turn stops it.
  const start = js.slice(js.indexOf("function startThinking()"));
  assert.match(start.slice(0, 800), /setInterval\(tick, 1000\)/);
  const chunk = js.slice(js.indexOf('case "chunk": {'));
  assert.doesNotMatch(
    chunk.slice(0, 500),
    /stopThinking/,
    "the first token does not mean the turn is over"
  );
  const finish = js.slice(js.indexOf("function finishAgentBubble()"));
  assert.match(finish.slice(0, 400), /stopThinking\(current\)/, "turnEnd and errors do");
  assert.match(finish.slice(0, 400), /clearInterval/, "a discarded bubble must not tick on");

  // An empty bubble showing a blinking cursor claims a reply has begun.
  const bubble = js.slice(js.indexOf("function ensureAgentBubble()"));
  assert.doesNotMatch(
    bubble.slice(0, 900),
    /body\.className = "body cursor"/,
    "the cursor belongs to text that exists"
  );
  // The case, not a fixed 500 characters of it — a comment added inside was
  // enough to push the line out of the window and fail this for nothing.
  assert.match(
    chunk.slice(0, chunk.indexOf('case "tool": {')),
    /classList\.toggle\("cursor", Boolean\(buffer\.trim\(\)\)\)/,
    "and not to an empty buffer"
  );

  // Decoration only: the words carry the state on their own.
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

/*
 * A turn can run a dozen tools, and listing them all pushed the answer off
 * the screen before it arrived. They fold behind one line of state.
 */
/*
 * "Working…" does not answer the question you actually have while waiting,
 * which is *what is it doing* — reading a file, searching, writing one. The
 * newest unfinished step is the answer, and it goes on the same line the list
 * unfolds from rather than costing a second one.
 */
test("the header names the step Kiro is on", () => {
  assert.match(js, /function updateStepsLabel\(bubble\)/);
  const update = js.slice(js.indexOf("function updateStepsLabel(bubble)"));
  const body = update.slice(0, update.indexOf("\n  /**"));
  assert.match(body, /steps\.length === 0/, "before any step it is still Working…");
  assert.match(
    body,
    /\.reverse\(\)\s*\n?\s*\.find\(\(t\) => t\.status !== "completed" && t\.status !== "failed"\)/,
    "the newest unfinished step is the one being worked on"
  );
  assert.match(body, /head\.title = step\.title/, "the line ellipsises, so keep the whole of it");

  const tool = js.slice(js.indexOf('case "tool": {'));
  const handler = tool.slice(0, tool.indexOf('case "permission"'));
  assert.match(handler, /updateStepsLabel\(bubble\)/, "every tool update refreshes it");
  assert.match(
    handler,
    /startThinking\(\)/,
    "a tool can arrive without a userMessage, so the header starts here too"
  );
});

/*
 * A finished turn is a single fact, so it reads as one sentence — "Completed
 * 2 steps in 7s". While the turn runs the halves are separate, because what
 * it is doing and how long it has been at it are two different things; once
 * it is over, splitting them left a label with a stray number after it.
 */
test("a finished turn reads as one sentence", () => {
  const stop = js.slice(js.indexOf("function stopThinking(bubble)"));
  const body = stop.slice(0, stop.indexOf("\n  /**"));
  assert.match(body, /`Completed \$\{steps\}\$\{took_\}`/);
  assert.match(body, /group\.time\.textContent = ""/, "the clock half is folded in");
  assert.doesNotMatch(js, /Worked for/, "that wording is gone for good");

  /*
   * A turn that ran no steps shows no header. There used to be a second shape
   * for that case — a line with the chevron slot standing empty, at a
   * different indent from the ordinary one — and two versions of the same
   * line read as a mistake.
   */
  assert.match(body, /if \(count === 0\) \{[\s\S]*?group\.steps\.hidden = true;[\s\S]*?return;/);
  assert.doesNotMatch(js, /classList\.add\("bare"\)/, "the second shape is gone");
  assert.doesNotMatch(css, /\.steps\.bare/);

  // A stored chat has no timing, so the sentence stops short rather than
  // claiming a duration it does not have.
  const restore = js
    .slice(js.indexOf("function restoreHistory(saved)"))
    .slice(0, js.slice(js.indexOf("function restoreHistory(saved)")).indexOf("\n  function "));
  assert.match(restore, /"Completed 1 step"/);
  assert.match(restore, /`Completed \$\{steps\.length\} steps`/);
  // Asserted as two facts rather than as one exact ternary: a third branch
  // was added for a turn that only reasoned, and pinning the spelling failed
  // for a reason that said nothing about whether the wording was right.
  assert.doesNotMatch(restore, /elapsedText|took/, "a stored chat claims no duration");
});

test("the steps fold away behind the header", () => {
  assert.match(js, /function buildSteps\(\)/);
  assert.match(css, /^\.steps-head \{/m);
  assert.match(css, /^\.steps-list \{/m);
  const build = js.slice(js.indexOf("function buildSteps()"));
  const body = build.slice(0, build.indexOf("\n  /**"));
  assert.match(body, /list\.hidden = true/, "closed to begin with");
  assert.match(body, /aria-expanded/, "and it has to say so");

  /*
   * The header must exist whenever a step ran — that is the log of what Kiro
   * did, and it is the one thing that must never go missing. It used to be
   * revealed as a side effect of `startThinking`, which does nothing once the
   * clock is already running, so what guaranteed the log was visible was a
   * call that had usually already happened.
   */
  const tool = js.slice(js.indexOf('case "tool": {'));
  const handler = tool.slice(0, tool.indexOf('case "permission"'));
  assert.match(handler, /bubble\.group\.steps\.hidden = false;/);
  assert.doesNotMatch(handler, /group\.open\(true\)/, "but it stays folded by default");

  // Nothing folds a list the user opened; that choice is theirs to undo.
  assert.match(body, /steps\.dataset\.pinned = "1"/);
  const stop = js.slice(js.indexOf("function stopThinking(bubble)"));
  const stopBody = stop.slice(0, stop.indexOf("\n  /**"));
  assert.doesNotMatch(stopBody, /group\.open\(/, "the turn ending must not close it either");
  assert.match(stopBody, /group\.steps\.hidden = false/, "and the log survives the turn");

  // A permission card inside a folded list is one the user cannot answer,
  // and the turn would hang waiting for them. Neither the pinned live card
  // nor the settled one in the transcript may go near `bubble.tools`.
  const card = js.slice(js.indexOf("function addPermissionCard(permission)"));
  const cardBody = card.slice(0, card.indexOf("\n  /** A card by request id"));
  assert.match(
    cardBody,
    /root\.insertBefore\(card, bubble\.body\)/,
    "the settled card sits above the reply, not in the steps list"
  );
  assert.doesNotMatch(cardBody, /bubble\.tools/, "and never inside the steps list");
});

/*
 * A permission card must not report an answer that reached nobody.
 *
 * Clicking used to disable the buttons and write "Selected: Allow" on the
 * spot, whatever became of the decision. A request that had already gone —
 * the turn ended, was stopped, or errored — is dropped by the provider in
 * silence, so a card sat in the transcript claiming an approval Kiro never
 * received. The extension answers now, and only then is anything written.
 */
test("a permission card writes down its answer only once it is acknowledged", () => {
  const card = js.slice(js.indexOf("function addPermissionCard(permission)"));
  const body = card.slice(0, card.indexOf("\n  function "));
  const click = body.slice(body.indexOf('button.addEventListener("click"'));
  assert.doesNotMatch(
    click,
    /Selected: \$\{option\.label\}/,
    "the click must not claim the decision landed"
  );
  assert.match(click, /status\.textContent = "Sending…";/, "it says it is in flight");

  // Both halves, or the card waits forever for a message nobody sends.
  assert.match(provider, /type: "permissionSettled", requestId, ok: false/, "refusals are told");
  assert.match(provider, /type: "permissionSettled", requestId, ok: true, optionId/);
  assert.match(js, /case "permissionSettled": \{/, "and the webview handles it");
  assert.match(js, /permission-stale/, "a dead request says so");
  assert.match(css, /^\.permission-stale \.permission-status \{/m);
});

/*
 * Two Stop paths disagreed. The webview's `stop` message cancelled pending
 * permissions; the `kiroChat.stop` command called `session.cancel()` alone, so
 * stopping from the Command Palette left a live card answering to nobody.
 */
test("stopping a turn cancels its questions, by either route", () => {
  const stop = provider.slice(provider.indexOf("  stop(): void {"));
  const body = stop.slice(0, stop.indexOf("\n  async "));
  assert.match(body, /this\.cancelPendingPermissions\(\);/, "Stop abandons the questions too");
  assert.match(body, /this\.session\.cancel\(\);/);
  // And the webview's case goes through it rather than round it.
  const message = provider.slice(provider.indexOf('case "stop":'));
  assert.match(message.slice(0, 400), /this\.stop\(\);/, "one path, not two");
});

/*
 * Dragging the panel between the sidebar and the bottom panel destroys the
 * webview. That used to answer Kiro "cancelled" on the user's behalf and say
 * so nowhere: the action quietly did not happen, and the rebuilt panel showed
 * no sign there had been a question. The request is still open, so it is
 * asked again.
 */
test("a pending permission survives the panel being rebuilt", () => {
  const dispose = provider.slice(provider.indexOf("view.onDidDispose(() => {"));
  const body = dispose.slice(0, dispose.indexOf("});"));
  assert.doesNotMatch(
    body,
    /cancelPendingPermissions/,
    "a layout change is not an answer to a permission request"
  );
  assert.match(provider, /private repostPermissions\(\): void \{/, "it is asked again instead");
  assert.match(provider, /this\.repostPermissions\(\);/);
  // Genuine teardown still cancels, or Kiro waits on a panel that is gone.
  const teardown = provider.slice(provider.indexOf("  dispose(): void {"));
  const teardownBody = teardown.slice(0, teardown.indexOf("\n  }"));
  assert.match(teardownBody, /cancelPendingPermissions/);
  assert.match(teardownBody, /keepPermissionsAlive/, "and no timer outlives it");
  // The request is kept beside its resolver so there is something to re-post.
  assert.match(provider, /request: \{ title: string; options:/, "the question is kept, not just the resolver");
  // And the same question arriving twice must not stack up two cards.
  assert.match(js, /if \(!already\) addPermissionCard\(asked\);/);
});

/*
 * The question is pinned; the answer is history.
 *
 * A live card used to sit in the transcript, which scrolls — and it scrolls
 * exactly when it matters, because Kiro goes on streaming while the turn is
 * blocked on you, so the thing waiting for an answer ends up somewhere above
 * the fold. It lives between the transcript and the message box now, the same
 * place and for the same reason as the keep-or-undo bar. Once answered it is
 * a record of what was asked, so it joins the conversation.
 */
test("a permission card waiting for an answer does not scroll away", () => {
  assert.match(provider, /id="permission-bar" class="permission-bar" hidden/);
  // Above the keep-or-undo bar: one blocks the turn, the other reports on a
  // turn that has finished.
  const bar = provider.indexOf('id="permission-bar"');
  const change = provider.indexOf('id="change-bar"');
  const input = provider.indexOf('id="input"');
  assert.ok(bar > -1 && bar < change && change < input, "pinned above the message box");
  assert.match(css, /^\.permission-bar \{/m);

  const card = js.slice(js.indexOf("function addPermissionCard(permission)"));
  const body = card.slice(0, card.indexOf("\n  /** A card by request id"));
  assert.match(body, /permissionBar\.appendChild\(card\);/, "a live card is pinned");
  assert.match(body, /permissionBar\.hidden = false;/);
  assert.match(js, /function retirePermissionCard\(card\)/, "and an answered one moves");
  assert.match(js, /retirePermissionCard\(card\);/);
  assert.match(
    js,
    /permissionBar\.hidden = permissionBar\.children\.length === 0;/,
    "the bar goes away when nothing is being asked"
  );
  // The digit shortcut answers what is pinned, not something scrolled past.
  const live = js.slice(js.indexOf("function livePermissionCard()"));
  assert.match(live.slice(0, 400), /permissionBar\.querySelectorAll/);
});

/*
 * Both gates, for anyone who wants them.
 *
 * The default is one gate — asking before an edit and then again after it is
 * twenty prompts in a ten-edit turn. But the two questions are not the same:
 * Kiro CLI writes files itself, so the review can only put a file back, while
 * the prompt is the only thing that can stop a write reaching disk. Which of
 * those matters is the user's call, not a rule.
 */
test("asking before an edit as well as reviewing it is available", () => {
  const manifestSetting = manifest.contributes.configuration.properties["kiroChat.askBeforeEdits"];
  assert.ok(manifestSetting, "the setting has to be declared");
  assert.equal(manifestSetting.default, false, "one gate stays the default");

  const session = fs.readFileSync(path.join(root, "src", "kiroSession.ts"), "utf8");
  const ask = session.slice(session.indexOf("private async askPermission"));
  const body = ask.slice(0, ask.indexOf("\n  private "));
  assert.match(body, /const askAnyway = config\.get<boolean>\("askBeforeEdits", false\);/);
  assert.match(
    body,
    /if \(!askAnyway && reviewWillOpen && isWriteLikeTool/,
    "and it has to actually suppress the skip"
  );
  // Reachable without the JSON editor, since that is the point — as the
  // Manual mode, which is the one this setting exists to make possible.
  assert.ok(js.includes('id: "manual"'), "Manual is what turns both gates on");
  assert.match(provider, /"askBeforeEdits",/, "and the panel may write it");
});

/*
 * A view closed for good must not leave Kiro waiting forever.
 *
 * `onDidDispose` cannot tell a drag from a close — both destroy the webview,
 * and only what happens next tells them apart. So the cancel is delayed
 * rather than skipped: a drag resolves a new view in milliseconds and calls
 * it off, and a close never does, so the timer eventually does exactly what
 * disposing used to do immediately.
 */
test("a permission left behind by a closed panel is cancelled in the end", () => {
  assert.match(provider, /const PERMISSION_GRACE_MS = 30_000;/, "the wait is named");
  assert.match(provider, /private schedulePermissionCancel\(\): void \{/);
  assert.match(provider, /private keepPermissionsAlive\(\): void \{/);

  // Nothing outstanding, nothing scheduled: closing an idle panel starts no
  // timer at all.
  const schedule = provider.slice(provider.indexOf("private schedulePermissionCancel"));
  const body = schedule.slice(0, schedule.indexOf("\n  /**"));
  assert.match(body, /if \(this\.pendingPermissions\.size === 0\) return;/);
  assert.match(body, /this\.cancelPendingPermissions\(\);/, "and it really does cancel");
  assert.match(body, /this\.output\.appendLine\(/, "said out loud — no panel is left to tell");

  // A view coming back is the observation that calls it off.
  const resolve = provider.slice(provider.indexOf("resolveWebviewView(view: vscode.WebviewView)"));
  assert.match(resolve.slice(0, 600), /this\.keepPermissionsAlive\(\);/);
  const dispose = provider.slice(provider.indexOf("view.onDidDispose(() => {"));
  assert.match(dispose.slice(0, dispose.indexOf("});")), /this\.schedulePermissionCancel\(\);/);
});

/*
 * The options render as "1  Allow", "2  Reject", which every terminal prompt
 * has taught people to read as "press that key". Nothing listened for them.
 */
test("the numbers on a permission card actually work", () => {
  assert.match(js, /function livePermissionCard\(\)/, "there has to be a card to answer");
  const keys = js.slice(js.indexOf('document.addEventListener("keydown"'));
  const body = keys.slice(0, keys.indexOf("\n  });"));
  assert.match(body, /\/\^\[1-9\]\$\/\.test\(event\.key\)/, "a digit answers the card");
  assert.match(body, /button\.click\(\);/);
  assert.match(body, /event\.preventDefault\(\);/, "so it is not also typed");
  /*
   * Only when the composer is empty. It keeps focus for most of a turn —
   * `setBusy` disables Send, not the textarea — so a digit while something is
   * being written is text, and the buttons are still there to click.
   */
  assert.match(body, /el\.tagName === "TEXTAREA" && String\(el\.value \|\| ""\)\.trim\(\) !== ""/);
});

/*
 * A permission lived only in the DOM, so reopening a chat left no trace that
 * Kiro had asked to do something or what was said back — the record most
 * worth keeping, for the one feature whose point is being asked first.
 */
test("a permission is kept in the chat's own record", () => {
  assert.match(js, /function recordPermission\(card, settled\)/);
  assert.match(js, /role: "permission",/, "it is its own kind of entry");
  const restore = js.slice(js.indexOf("function restoreHistory(saved)"));
  const body = restore.slice(0, restore.indexOf("\n  function "));
  assert.match(body, /item\.role === "permission"/, "and it comes back");
  // The same card with its buttons spent, not a second way of drawing one.
  assert.match(body, /settled: true/);
  assert.match(js, /if \(permission\.settled\) \{/);
  assert.match(css, /^\.permission-done \.permission-title \{/m);
});

/*
 * `kind.startsWith("allow") || index === 0` painted whatever came first as
 * the recommended action — so a refusal sent first got the primary treatment,
 * and both classes at once.
 */
test("only an allow may be the primary button", () => {
  const card = js.slice(js.indexOf("function addPermissionCard(permission)"));
  const body = card.slice(0, card.indexOf("\n  function "));
  assert.match(body, /const declaresAllow = options\.some/, "is there an allow at all?");
  assert.match(body, /if \(isReject\) button\.classList\.add\("reject"\);/, "reject decides first");
  assert.match(
    body,
    /else if \(kind\.startsWith\("allow"\) \|\| \(!declaresAllow && index === 0\)\)/,
    "and the first-option fallback may not overrule it"
  );
});

/*
 * "Reading chat.js — running" wrote the state in the same grey prose as the
 * name, so a step still going looked like one that had finished. Live and
 * restored rows go through one renderer, or the two drift.
 */
test("a tool row shows its state, without a column of ticks mid-turn", () => {
  assert.match(js, /function renderToolRow\(row, tool, phase = "live"\)/);
  assert.match(css, /^\.tool-icon \{/m);
  assert.match(css, /@keyframes tool-spin/);

  // No marks on finished steps: a tick beside every completed row is a column
  // of decoration saying the same thing over and over. Only the step still
  // running gets a glyph, and a failure is carried by the row's colour.
  const render = js.slice(js.indexOf('function renderToolRow(row, tool, phase = "live")'));
  const body = render.slice(0, render.indexOf("\n  function "));
  assert.doesNotMatch(body, /✓|✗|"·"/, "steps carry no marks of their own");
  assert.match(body, /icon\.textContent = ""/);
  assert.match(body, /if \(!done && !failed && live\) icon\.classList\.add\("spinning"\)/);
  assert.match(css, /\.tool\[data-status="failed"\] \{[^}]*errorForeground/);
  // The slot keeps its width, or a row jumps sideways as its step finishes.
  assert.match(css, /^\.tool-icon \{[^}]*width: 9px/m);

  const restore = js.slice(js.indexOf("function restoreHistory(saved)"));
  assert.match(
    restore.slice(0, restore.indexOf("\n  function ")),
    /renderToolRow\(row, tool, "restored"\)/,
    "a chat from last week is not still working"
  );
});

/*
 * VS Code does not hand a webview the editor's TextMate token colours, so an
 * exact match is not on offer. The theme's own colour keys for the same ideas
 * are, and colouring from those follows whatever theme is running rather than
 * hard-coding a palette that fights it.
 */
test("code blocks are coloured from the active theme", () => {
  assert.match(js, /function highlightCode\(code, lang\)/);
  assert.match(js, /highlightCode\(\s*\n?\s*code\.replace/, "the renderer has to use it");
  for (const token of ["comment", "string", "number", "const", "keyword", "fn"]) {
    assert.match(css, new RegExp(`^\\.tok-${token} \\{`, "m"), `.tok-${token} needs a colour`);
  }
  // Every colour comes from the theme, with a fallback only for a theme that
  // leaves the key undefined.
  const tokens = css.slice(css.indexOf(".tok-comment {"), css.indexOf(".tools {"));
  for (const line of tokens.split("\n")) {
    if (!/^\s*color:/.test(line)) continue;
    assert.match(line, /var\(--vscode-/, `a hard-coded token colour would fight the theme: ${line}`);
  }

  // The bare fallbacks are dark-theme values and would be unreadable on a
  // light one, so a light theme gets its own set.
  assert.match(css, /body\.vscode-light \.tok-string/);
  assert.match(css, /body\.vscode-light \.tok-keyword/);

  // `//` is floor division in Python and `#` is a colour in CSS, so the
  // comment style must follow the language rather than trying to be both.
  assert.match(js, /HASH_COMMENT_LANGS/);

  // Everything still goes through escapeHtml, or a reply could inject markup.
  const highlight = js.slice(js.indexOf("function highlightCode(code, lang)"));
  const fn = highlight.slice(0, highlight.indexOf("\n  function renderMarkdown"));
  assert.doesNotMatch(
    fn,
    /\$\{match\[0\]\}|\$\{code\.slice/,
    "raw source must never reach the output unescaped"
  );
  assert.match(fn, /escapeHtml\(code\.slice\(last, match\.index\)\)/);
  assert.match(fn, /const text = escapeHtml\(match\[0\]\)/);
});

/*
 * Both turns were plain full-width prose separated by a 10px label, and the
 * question was painted in the *muted* colour — so the user's own words were
 * the faintest thing on screen, and scrolling back gave the eye nothing to
 * catch on.
 */
test("your own message is a block, at full contrast", () => {
  const user = css.slice(css.indexOf(".msg.user {"));
  const rule = user.slice(0, user.indexOf("}"));
  assert.doesNotMatch(
    rule,
    /color: var\(--vscode-descriptionForeground\)/,
    "the question must not be dimmer than the answer"
  );
  assert.match(rule, /background:/, "it needs a surface to read as a block");

  /*
   * And sized to what was typed, pushed to the right. Stretched to the full
   * width a one-line question read as another paragraph of the conversation
   * rather than as the thing that started it.
   */
  assert.match(rule, /align-self: flex-end/);
  assert.match(rule, /width: fit-content/);
  // Never the whole width: a bubble reaching both margins is a paragraph
  // again, and the strip of ground down its left is what says who sent it.
  const max = rule.match(/max-width: (\d+)%/);
  assert.ok(max, "the bubble needs a maximum width");
  assert.ok(
    Number(max[1]) >= 70 && Number(max[1]) < 100,
    `expected most of the width but not all of it, got ${max[1]}%`
  );

  // A new exchange gets more air than the gap inside one.
  assert.match(css, /\.msg\.user:not\(:first-child\) \{[^}]*margin-top:/);

  const add = js.slice(js.indexOf("function addUserBubble(message)"));
  assert.doesNotMatch(
    add.slice(0, 500),
    /roleLabel\("You"\)/,
    "the block says whose turn it is, so the label is a wasted line"
  );
});

test("the menus are anchored inside a positioned parent", () => {
  // Otherwise they land over the message box, or spill out of a narrow sidebar.
  assert.match(css, /\.attach-wrap \{[^}]*position: relative/);
  assert.match(css, /\.composer \{[^}]*position: relative/);
  assert.match(provider, /<div class="attach-wrap">[\s\S]*?id="attach-menu"/);
});

/*
 * How the conversation runs is one menu, not a picker and a settings gear.
 *
 * Supervision lived behind a gear of its own, which put "how closely am I
 * watching Kiro" somewhere quite different from "how is Kiro approaching this
 * task" — two halves of one question, and one of them dressed as
 * configuration rather than a working choice.
 */
test("the mode picker carries the workflow, the supervision and what is sent", () => {
  assert.doesNotMatch(provider, /id="settings-btn"/, "the separate gear is gone");
  assert.doesNotMatch(js, /renderSettingsMenu/);
  assert.doesNotMatch(css, /\.settings-menu/);

  const render = js.slice(js.indexOf("function renderModeMenu()"));
  const body = render.slice(0, render.indexOf("\n  /**"));
  assert.match(body, /menuHeading\("Workflow"\)/);
  assert.match(body, /menuHeading\(\s*\n?\s*"When Kiro edits a file"/);
  assert.match(body, /menuHeading\("Sent with each message"\)/);
  assert.match(css, /^\.menu-head \{/m, "the groups need to be told apart");

  // The four write gates are one choice, not four booleans: named modes say
  // what the settings are about, where "reviewFileWrites" actively misled.
  assert.match(js, /const EDIT_MODES = \[/, "supervision is one choice");
  for (const id of ["manual", "review", "autopilot"]) {
    assert.ok(js.includes(`id: "${id}"`), `${id} belongs in the menu`);
  }
  // What rides along with a message is a separate matter, and stays a toggle.
  assert.match(js, /const MESSAGE_TOGGLES = \[/);
  for (const key of ["attachActiveFile", "sendSelection"]) {
    assert.ok(js.includes(`key: "${key}"`), `${key} belongs in the menu`);
  }

  // Both halves, or a row does nothing and says nothing.
  assert.match(js, /type: "setEditMode", mode: row\.dataset\.editMode/);
  assert.match(provider, /case "setEditMode": \{/);
  assert.match(js, /type: "setSetting",\s*\n?\s*key: row\.dataset\.setting/);
  assert.match(provider, /case "setSetting": \{/);
  assert.match(js, /case "settings":/, "and the answer comes back");
  assert.match(provider, /private postSettings\(\): void \{/);
});

/*
 * Two scopes, two different resets.
 *
 * `newSession` did `usage = {}`, so the plan figures you had just fetched
 * vanished for pressing "+" — they describe the account and were still true.
 * `loadSession` reset nothing at all, so "2.47 credits this chat" stayed on
 * the strip while you read a different conversation: a specific claim about
 * the chat in front of you, made about the one you just left.
 */
test("the session's numbers end with the session; the account's do not", () => {
  const session = fs.readFileSync(path.join(root, "src", "kiroSession.ts"), "utf8");
  for (const method of ["async newSession()", "async loadSession(sessionId: string)"]) {
    const at = session.indexOf(method);
    assert.ok(at > -1, `${method} should exist`);
    const body = session.slice(at, session.indexOf("\n  }", at));
    assert.match(
      body,
      /this\.usage = clearSessionUsage\(this\.usage\);/,
      `${method} must clear only what belonged to the conversation`
    );
    assert.match(body, /this\.events\.onUsage\(\{ \.\.\.this\.usage \}\);/, "and report what is left");
  }
  assert.doesNotMatch(session, /this\.usage = \{\};/, "nothing wipes both scopes any more");
});

/*
 * Session credits were fixed at two decimals and account credits were not
 * formatted at all, so a plan total arrived as "1234.5678901234 credits on
 * Pro" on a strip sized for a sidebar.
 */
test("every credit figure goes through one formatter", () => {
  assert.match(js, /function credits\(value\) \{/, "the webview needs its own, having no build step");
  assert.doesNotMatch(js, /sessionCredits\.toFixed\(2\)/, "and nothing formats itself");
  assert.doesNotMatch(js, /\+ usage\.accountCreditsUsed \+/, "nor goes unformatted");
  // Mirrored in usage.ts, which is where the extension side reads them.
  const usage = fs.readFileSync(path.join(root, "src", "usage.ts"), "utf8");
  assert.match(usage, /export function formatCredits\(/);
});

/*
 * The fill was only ever assigned, never emptied, so a new conversation's bar
 * flashed the last one's fullness until its first meter arrived.
 */
test("the context bar empties when there is no context to report", () => {
  const render = js.slice(js.indexOf("function renderUsage(next)"));
  const body = render.slice(0, render.indexOf("\n  function "));
  assert.match(body, /usageFill\.style\.width = "0%";/);
  assert.match(body, /usageFill\.classList\.remove\("warn"\);/);
});

/*
 * One flag, one writer. The click used to set `usageLoading` itself as well
 * as asking the extension, so it had decided the panel was loading before
 * anything was consulted.
 */
test("the usage spinner is put up by the extension, not by the click", () => {
  const panel = js.slice(js.indexOf("function renderUsagePanel()"));
  const body = panel.slice(0, panel.indexOf("\n  function "));
  const click = body.slice(body.indexOf('refresh.addEventListener("click"'));
  assert.match(click, /vscode\.postMessage\(\{ type: "refreshUsage" \}\)/, "it only asks");
  assert.doesNotMatch(click, /usageLoading = true/, "and does not answer itself");
  assert.match(js, /case "usageReportLoading":\s*\n\s*usageLoading = true;/);
  assert.match(provider, /this\.post\(\{ type: "usageReportLoading" \}\);/);
});

/*
 * A toggle is a switch, not a character.
 *
 * It was a "✓" / "○" in front of the label — a glyph pretending to be a
 * control. Nothing about it said it could be flipped, its two states were
 * different *shapes* rather than one thing moved, and it took whatever colour
 * the surrounding text happened to be.
 */
test("the message toggles are drawn switches", () => {
  const render = js.slice(js.indexOf("function menuRow(options)"));
  const body = render.slice(0, render.indexOf("\n  /*"));
  assert.match(body, /track\.className = "menu-switch";/, "a switch, drawn");
  assert.match(body, /track\.setAttribute\("aria-hidden", "true"\)/, "the row carries the state");
  // Code, not comments: the comment here names the glyph it replaced, and
  // reading that as code failed this on its own explanation.
  const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /✓|○/, "and no glyph standing in for a control");

  // The knob moves; it is not two different marks.
  assert.match(css, /^\.menu-switch \{[^}]*border-radius: 999px/m);
  assert.match(css, /^\.menu-switch::after \{[^}]*border-radius: 50%/m);
  assert.match(css, /\[aria-checked="true"\] > \.menu-switch::after \{[^}]*translateX/);
  assert.match(css, /\[aria-checked="true"\] > \.menu-switch \{[^}]*background: var\(--vscode-button-background\)/);

  // Sliding to the position is decoration; the position is the state.
  const reduced = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\n\s*\.menu-switch,/);
  assert.ok(reduced.length > 0);
});

/*
 * Picking a workflow is the errand, so the menu closes. Supervision and the
 * message toggles are things you might set two of, and staying open is what
 * shows the change landing — they are also the rows that wait to be told
 * rather than flipping themselves.
 */
test("only picking a workflow closes the mode menu", () => {
  const handler = js.slice(js.indexOf('modeMenu.addEventListener("click"'));
  const body = handler.slice(0, handler.indexOf("\n  });"));
  const workflow = body.slice(body.indexOf("if (row.dataset.modeId)"));
  assert.match(
    workflow.slice(0, 300),
    /setMenu\(modeMenu, modeBtn, false\);/,
    "a workflow is chosen and the menu is done"
  );
  const rest = body.slice(body.indexOf("if (row.dataset.editMode)"));
  assert.doesNotMatch(rest, /setMenu\(modeMenu, modeBtn, false\)/, "the others stay open");
  assert.doesNotMatch(rest, /editMode = /, "and none of them flips itself");
  assert.doesNotMatch(rest, /settings\[row\.dataset\.setting\] =(?!=)/);
});

/*
 * Review is the default and needs no announcing. Manual and Autopilot change
 * what happens to your files with nothing else on screen to say so, so they
 * ride on the button where they cannot be missed.
 */
test("the button says so when supervision is not the default", () => {
  const label = js.slice(js.indexOf("function modeButtonLabel()"));
  const body = label.slice(0, label.indexOf("\n  }"));
  assert.match(body, /editMode === "review"/, "the default is not announced");
  assert.match(body, /currentModeId === "plan"/, "and Plan changes nothing anyway");
  assert.match(body, /\$\{mode\.label\} · \$\{supervision\.label\}/);
  assert.match(js, /modeLabel\.textContent = modeButtonLabel\(\);/);
});

/*
 * `setSetting` is a write primitive taking a key from a message, so the key
 * is untrusted input. An allow-list keeps it to the five toggles the menu
 * offers rather than anything under `kiroChat`.
 */
test("the panel may only write the settings it shows", () => {
  assert.match(provider, /const PANEL_SETTINGS = \[/);
  const handler = provider.slice(provider.indexOf('case "setSetting": {'));
  const body = handler.slice(0, handler.indexOf("\n        }"));
  assert.match(
    body,
    /if \(!\(PANEL_SETTINGS as readonly string\[\]\)\.includes\(key\)\) break;/,
    "an unknown key is refused, not written"
  );
  assert.match(body, /message\.value === true/, "and only a boolean is written");
});

/*
 * The menu is a view of the settings, not a copy. A row flips because the
 * setting changed — never because it was clicked — so a write that failed
 * cannot leave a tick claiming a state the setting is not in. The same rule
 * the permission card follows.
 */
test("a settings row waits to be told before it changes", () => {
  const render = js.slice(js.indexOf("function renderSettingsMenu()"));
  const body = render.slice(0, render.indexOf("\n  function "));
  const click = body.slice(body.indexOf('row.addEventListener("click"'));
  // `=` and not `==`: the loose version matched the `===` in `const on = ...`
  // and only passed because that line used to sit above the listener.
  assert.doesNotMatch(click, /settings\[item\.key\] =(?!=)/, "the click must not set the value");
  assert.doesNotMatch(click, /editMode = /, "nor the mode it just asked for");
  assert.doesNotMatch(click, /renderSettingsMenu\(\)/, "nor redraw as though it had");

  // Changed anywhere — the settings editor, another window, the JSON — and
  // the menu has to follow, or it shows a state that is not in force.
  assert.match(provider, /vscode\.workspace\.onDidChangeConfiguration\(\(event\) => \{/);
  assert.match(provider, /if \(!event\.affectsConfiguration\("kiroChat"\)\) return;/);
  assert.match(provider, /this\.postSettings\(\);/);
});

test("the webview only loads files that exist under media", () => {
  const referenced = [...provider.matchAll(/media\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(referenced.length > 0, "the page should load its script and stylesheet");
  for (const file of referenced) {
    assert.ok(
      fs.existsSync(path.join(root, "media", file)),
      `media/${file} is referenced by the webview but missing`
    );
  }
});

test("Enter cannot start a second turn while Kiro is working", () => {
  const submit = js.slice(js.indexOf("function submit()"));
  assert.match(submit.slice(0, 200), /if \(busy\) return;/);
});

/**
 * Usage has two ways in: the view title bar, and the "Check account usage"
 * button in the model menu footer. The top bar used to carry a third that hit
 * the same command. Both survivors route through refreshUsage, so the handler
 * has to stay even though the top bar no longer posts to it.
 */
test("usage is offered by the view title bar and not duplicated in the top bar", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const titleMenu = pkg.contributes.menus["view/title"] ?? [];
  assert.ok(
    titleMenu.some((item) => item.command === "kiroChat.showUsage"),
    "kiroChat.showUsage must stay in the view/title menu"
  );

  assert.doesNotMatch(provider, /usage-btn/, "the top bar should not carry its own usage button");
  assert.doesNotMatch(js, /usageBtn/, "chat.js should not wire a top bar usage button");
  // `.linkish` used to be this button's private style and was checked here to
  // prove it went with it. The back link in the history list owns it now, so
  // its presence no longer says anything about the usage button.

  // The model menu footer still asks for a refresh, so the handler stays.
  assert.match(js, /type: "refreshUsage"/, "the model menu footer should still ask for usage");
  assert.match(provider, /case "refreshUsage"/, "the provider must still answer refreshUsage");
});

/*
 * The question is a bubble on the right; the answer is prose down the left.
 *
 * This reverses an earlier decision. Both roles ran the full width for a
 * while, on the reasoning that one reading axis suits a narrow sidebar — but
 * that made a one-line question read as just another paragraph, with only a
 * 10px label to say it was the thing that started the exchange. Sized to its
 * own text and set against the answer's alignment, it is findable at a glance
 * when scrolling back. `max-width: 100%` keeps a long question from becoming
 * a narrow column of wrapped text.
 */
test("the question is a bubble, the answer is a column", () => {
  const userRule = css.match(/^\.msg\.user \{[^}]*\}/m);
  assert.ok(userRule, ".msg.user should still be styled");
  assert.match(userRule[0], /align-self: flex-end/);
  assert.match(userRule[0], /width: fit-content/);

  // The answer keeps the full width: long prose in a narrow column wants it.
  const agentRule = css.match(/^\.msg\.agent \{[^}]*\}/m);
  assert.ok(agentRule);
  assert.doesNotMatch(agentRule[0], /flex-end|fit-content/);
});

/**
 * Kiro's turn has no bubble and no alignment of its own, so the label above it
 * is the only thing naming the author. Losing it makes the transcript
 * unreadable, and nothing else would catch that.
 */
test("Kiro's messages say who wrote them", () => {
  assert.match(js, /msg-role/, "chat.js should label each message with its author");
  assert.match(css, /^\.msg-role \{/m, "the role label needs a style");
  assert.match(js, /roleLabel\("Kiro"\)/);
});

/**
 * The setup screen used to leave the composer live, so you could type a
 * question and press Send into a Kiro that was not running. The message went
 * nowhere and nothing said why.
 */
test("the composer is dead while setup is on screen", () => {
  assert.match(js, /function setComposerEnabled/, "chat.js needs one place that locks the composer");
  const setup = js.slice(js.indexOf("function renderSetup"));
  assert.match(
    setup.slice(0, 600),
    /setComposerEnabled\(\s*false/,
    "showing setup must disable the composer"
  );
});

/**
 * Each step reports its own progress — waiting, done, failed — so the user can
 * see the panel noticing the install rather than wondering whether to click
 * something. A step rendered without state is a step frozen at "todo".
 */
test("setup steps carry their own state", () => {
  assert.match(js, /dataset\.state/, "chat.js should stamp each step with its state");
  assert.match(css, /\.step\[data-state=/, "the states need to look different");
});

/** The watcher is what makes the setup screen advance on its own. */
test("the provider drives the setup screen with the watcher", () => {
  assert.match(provider, /SetupWatcher/, "the provider should own a SetupWatcher");
  assert.match(provider, /case "signIn"/, "signing in must tell the watcher to retry");
  assert.match(js, /case "setupState"/, "the webview must react to watcher progress");
});

/**
 * The watcher is not the only way Kiro comes up: pressing Connect, or a
 * restart from the title bar, both connect without the watcher saying a word.
 * If only the watcher's "connected" message dismissed the setup screen, those
 * routes left the user staring at install instructions with a dead composer
 * while Kiro sat there connected and ready.
 */
test("a ready session dismisses the setup screen however it connected", () => {
  const handler = js.slice(js.indexOf('case "status":'));
  const body = handler.slice(0, handler.indexOf("break;"));
  assert.match(
    body,
    /leaveSetup\(\)/,
    "reaching ready must drop the setup screen, not just a watcher message"
  );
});

/**
 * Image attachments were shown as filenames because postAttachments stripped
 * the data before the webview ever saw it. Sending a data URI is the whole
 * fix, and dropping it again would silently put the filenames back.
 */
test("image attachments reach the webview as something it can draw", () => {
  assert.match(provider, /previewOf/, "the provider must build a preview for images");
  // The method, not a fixed 400 characters of it: a comment added inside was
  // enough to push `preview:` out of the window and fail this for nothing.
  const posted = provider.slice(provider.indexOf("private postAttachments"));
  assert.match(
    posted.slice(0, posted.indexOf("\n  private ")),
    /preview:/,
    "postAttachments must include the preview, not just the label"
  );
  assert.match(js, /function thumbnail/, "chat.js should render a thumbnail");
  assert.match(css, /^\.thumb \{/m, "the thumbnail needs a size");
});

/** A huge image is not worth pushing through postMessage to draw it small. */
test("an oversized image falls back to a text chip", () => {
  assert.match(provider, /MAX_PREVIEW_BYTES/, "there must be a ceiling on preview size");
  const preview = provider.slice(provider.indexOf("private previewOf"));
  assert.match(
    preview.slice(0, 500),
    /return undefined/,
    "over the ceiling, no preview is sent"
  );
});

/**
 * Kiro binds a session to a folder and confirms loadSession, so history can
 * genuinely resume. Losing the session id would quietly turn every past chat
 * read-only.
 */
test("past chats are stored with what is needed to reopen them", () => {
  assert.match(provider, /sessionId: this\.chatSessionId \?\? this\.session\.currentSessionId/);
  assert.match(provider, /HISTORY_KEY/, "history has to be stored somewhere durable");
  assert.match(js, /case "openChat"/, "the webview must react to a chat being opened");
});

/**
 * Starting a new chat used to throw the old one away. Now it is archived
 * first, which is the only reason history has anything in it.
 *
 * Three paths begin a chat — the + button, Try again on the setup screen, and
 * a panel rebuilt with nothing in it. Two of them used to skip the archiving
 * and the id rotation, so the conversation that followed was written into the
 * previous chat's record and upsert replaced it. They all go through one
 * helper now, and this checks none of them has drifted back out.
 */
test("starting a new chat keeps the old one", () => {
  const fresh = provider.slice(provider.indexOf("private beginFreshChat()"));
  const body = fresh.slice(0, 500);
  assert.match(body, /saveCurrentChat\(\)/, "the outgoing chat must be saved");
  assert.match(body, /this\.chatId = freshId\(\)/, "and the new one must get its own id");
  assert.match(body, /this\.transcript = \[\]/, "and start with an empty transcript");

  for (const [name, start] of [
    ["the + button", "async newSession()"],
    ["Try again on the setup screen", 'case "retry"'],
    ["a panel rebuilt blank", "if (this.everConnected) {"],
  ]) {
    const region = provider.slice(provider.indexOf(start));
    assert.match(
      region.slice(0, 500),
      /beginFreshChat\(\)/,
      `${name} must archive the chat it is replacing`
    );
  }
});

/*
 * Reading a past chat must not rewrite it.
 *
 * `openChat` posts the stored transcript down and only then awaits
 * `session/load`. The webview used to save its state — which reports the
 * transcript back — the instant it received it, and that round trip beats a
 * 30-second ACP request every time. So the record was re-saved while the load
 * was still in flight: its timestamp jumped to now, so a chat from last week
 * moved to Today merely for being opened, and its session id was overwritten
 * with whichever session was still running, which was the *previous* chat's.
 * Reopening it after that resumed the wrong conversation.
 */
test("opening a past chat does not report its transcript back", () => {
  const handler = js.slice(js.indexOf('case "openChat":'));
  const body = handler.slice(0, handler.indexOf("case \"chatReadOnly\""));
  assert.match(
    body,
    /saveState\(false\)/,
    "a transcript handed to us by the extension must not be sent back"
  );
  assert.doesNotMatch(
    body,
    /saveState\(\)/,
    "reporting it would re-save the record we were just given"
  );
  assert.match(
    js,
    /function saveState\(report\)/,
    "saveState has to be able to persist locally without reporting"
  );

  // And the provider pins the chat's own session before anything can report.
  const open = provider.slice(provider.indexOf("private async openChat("));
  const pin = open.indexOf("this.chatSessionId = record.sessionId");
  const post = open.search(/this\.post\(\{\s*type: "openChat"/);
  assert.ok(pin >= 0, "openChat must pin the session the record belongs to");
  assert.ok(post >= 0, "openChat must tell the webview about the chat");
  assert.ok(pin < post, "it must be pinned before the webview is told, not after");
});

/*
 * The keep-or-undo bar belongs to the turn that raised it. Opening a different
 * chat used to leave it pinned above the composer, offering to undo edits made
 * in a conversation that is no longer on screen.
 */
test("opening a past chat clears the other chat's pending changes", () => {
  const handler = js.slice(js.indexOf('case "openChat":'));
  const body = handler.slice(0, handler.indexOf("case \"chatReadOnly\""));
  assert.match(body, /pendingReview = null/);
  assert.match(body, /pendingChanges = null/);
  assert.match(body, /renderChangeBar\(\)/);
});

/*
 * Only the tail of a long chat is stored. Restoring it silently would show a
 * conversation that appears to begin in the middle.
 */
test("a chat stored as only its tail says so", () => {
  assert.match(js, /historyTruncated = message\.truncated === true/, "on open");
  assert.match(js, /truncated: historyTruncated/, "and when reporting back");
  const restore = js.slice(js.indexOf("function restoreHistory(saved)"));
  assert.match(
    restore.slice(0, 600),
    /if \(historyTruncated\)[\s\S]*history-trimmed/,
    "a trimmed transcript must say so where it is drawn"
  );
  assert.match(css, /^\.history-trimmed \{/m, "the note needs a rule");
  assert.match(provider, /truncated: this\.transcriptTruncated/, "and it must be stored");
});

/*
 * Every save serialises every chat, and the records hold whole transcripts.
 * Reading and writing the memento per message moved megabytes a turn.
 */
test("saving a chat is debounced, and reads the list at write time", () => {
  assert.match(provider, /private scheduleFlush\(\): void/);
  const flush = provider.slice(provider.indexOf("private flushChats(): void"));
  const body = flush.slice(0, flush.indexOf("\n  }"));
  // Holding the whole list in memory instead would let a second VS Code
  // window's saves be overwritten by this one's stale copy.
  assert.match(
    body,
    /upsertRecord\(this\.allChats\(\), record\)/,
    "the stored list must be re-read when the pending chat is written"
  );
  assert.doesNotMatch(provider, /private chats: ChatRecord\[\]/, "and never cached");

  const dispose = provider.slice(provider.indexOf("dispose(): void {"));
  assert.match(
    dispose.slice(0, 300),
    /flushChats\(\)/,
    "a debounced save must not be lost to the window closing"
  );
  // A list that leaves out the chat you are in reads as a bug.
  const list = provider.slice(provider.indexOf("private postHistory(): void"));
  assert.match(list.slice(0, 400), /flushChats\(\)/);
});

/*
 * The list's own affordances. Starting a chat is deliberately NOT one of them:
 * the title bar already has that button, and a second one in the list is a
 * duplicate control competing with the rows.
 */
test("the past-chats list can be searched and escaped", () => {
  assert.match(js, /type: "requestHistory"/, "the list must ask for current data");
  assert.match(provider, /case "requestHistory"/, "and the provider must answer");
  assert.match(js, /history-search/, "a list of repeated titles needs a filter");

  const escape = js.slice(js.indexOf('if (event.key !== "Escape") return;'));
  assert.match(
    escape.slice(0, 400),
    /closeHistory\(\)/,
    "Escape must leave the list, like every other overlay in the editor"
  );

  assert.match(js, /history-preview/, "identical titles need the newest line to tell them apart");
  assert.match(provider, /preview: previewOf\(/, "which the provider has to send");
  assert.match(css, /^\.history-preview \{/m);
  assert.match(css, /^\.history-search \{/m);

  // Deleting is one click. The × keeps out of the way until the row is
  // pointed at, so it is never under the cursor of someone aiming at the
  // chat beside it — and `visibility`, so the row does not resize on hover.
  assert.match(js, /act === "delete"/);
  assert.doesNotMatch(js, /confirmDelete/, "deleting was asked for direct, with no prompt");
  assert.doesNotMatch(js, /type: "newChat"/, "the title bar owns starting a chat");
  assert.doesNotMatch(provider, /case "newChat"/, "so the provider must not carry a dead case");
  const remove = css.slice(css.indexOf(".history-delete {"));
  assert.match(remove.slice(0, 500), /visibility: hidden/);
});

/*
 * The open chat used to paint as a solid selection block, which repaints the
 * preview and the timestamp in the selection foreground — the muted greys
 * that make them read as secondary have nothing to be muted against there.
 * A tint plus an accent bar keeps the row's own hierarchy.
 */
test("the row styling is a tint and an accent, not a solid block", () => {
  const current = css.slice(css.indexOf(".history-row.current {"));
  assert.doesNotMatch(
    current.slice(0, 200),
    /list-activeSelectionBackground/,
    "the solid selection block flattens the row's secondary text"
  );
  assert.match(css, /^\.history-row\.current::before \{/m, "the accent bar");
  // Hover and the delete button move, so they need a transition or they snap.
  const row = css.slice(css.indexOf(".history-row {"));
  assert.match(row.slice(0, 300), /transition:/);
});

/**
 * Reopening a chat Kiro cannot load still shows the transcript, but replying
 * would silently start a different conversation. The composer says so.
 */
test("a chat that cannot be resumed is read only, not silently broken", () => {
  assert.match(provider, /chatReadOnly/, "the provider must say when a chat cannot resume");
  const handler = js.slice(js.indexOf('case "chatReadOnly":'));
  assert.match(
    handler.slice(0, 400),
    /setComposerEnabled\(\s*false/,
    "a read-only chat must not accept a reply"
  );
});

/**
 * The usage report used to be posted into the conversation as note bubbles,
 * which pushed the chat around and — because it went through recordSimple —
 * got saved into the chat history as if the user had asked for it there. It
 * belongs in a panel you can open and close.
 */
test("the usage report is a panel, not a message in the chat", () => {
  assert.match(provider, /id="usage-panel"/, "there must be somewhere to put the report");
  assert.match(js, /usagePanel/, "chat.js should render the report into the panel");

  const report = js.slice(js.indexOf('case "usageReport"'));
  const body = report.slice(0, 500);
  assert.doesNotMatch(body, /addBubble/, "the report must not be added to the transcript");
  assert.doesNotMatch(body, /recordSimple/, "the report must never reach the saved history");
});

/** Opening it twice should close it; that is what makes it a toggle. */
test("the usage panel toggles", () => {
  assert.match(js, /function toggleUsagePanel/, "there must be one place that toggles it");
  assert.match(js, /case "toggleUsage"/, "the title bar command must reach the toggle");
  assert.match(provider, /toggleUsage/, "the provider must be able to ask for the toggle");
});

/**
 * The file you are looking at goes with your message, the way Copilot Chat
 * does it. Before this it was named in the prompt as prose and never attached,
 * so Kiro knew the filename and could not open it — and nothing on screen said
 * it was happening or let you stop it.
 */
test("the focused file is attached and shown as a chip", () => {
  assert.match(provider, /attachmentsForMessage/, "send must fold in the active file");
  assert.match(provider, /activeFile: this\.activeFile\(\)/, "the chip needs the file");
  assert.match(js, /chip-active/, "chat.js should draw a chip for it");
  assert.match(css, /^\.chip-active \{/m, "the chip needs a style");

  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.ok(
    pkg.contributes.configuration.properties["kiroChat.attachActiveFile"],
    "there must be a way to switch it off"
  );
});

/** Dismissing means "not this file", not "never again". */
test("switching files brings the chip back", () => {
  const handler = js.slice(js.indexOf('case "selection":'));
  assert.match(
    handler.slice(0, 700),
    /includeActiveFile = true/,
    "a different file must re-enable the chip"
  );
});

/**
 * kiroChat.sendSelection was declared in package.json and never read anywhere,
 * so the toggle silently did nothing.
 */
test("every declared setting is actually read by the code", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const sources = ["chatViewProvider.ts", "kiroSession.ts", "context.ts", "extension.ts", "lifecycle.ts"]
    .map((f) => fs.readFileSync(path.join(root, "src", f), "utf8"))
    .join("\n");

  for (const key of Object.keys(pkg.contributes.configuration.properties)) {
    const name = key.replace(/^kiroChat\./, "");
    assert.match(
      sources,
      new RegExp(`["']${name}["']`),
      `${key} is offered in settings but nothing reads it`
    );
  }
});

/**
 * A dropped file arrives under several format names at once, and which ones
 * are filled in depends on where the drag came from. Reading only one is how
 * a drop ends up looking as though it did nothing.
 */
test("a drop is read from every format the drag offered", () => {
  assert.match(js, /DROP_FORMATS/, "chat.js should try more than one format");
  for (const format of ["text/uri-list", "resourceurls", "text/plain"]) {
    assert.ok(js.includes(format), `${format} should be among the formats read`);
  }
  assert.match(provider, /parseDroppedPaths/, "the provider parses what arrived");
});

/**
 * A drop that yields nothing has to say so. Without it there is no way to tell
 * a drop that was not understood from one that never reached the panel, and
 * that difference decides where the fix belongs.
 */
test("a drop that yields nothing is logged with what was on offer", () => {
  const handler = provider.slice(provider.indexOf("private async handleDrop"));
  const body = handler.slice(0, 1400);
  assert.match(body, /formats offered/, "the log must name the formats that were available");
  assert.match(body, /appendLine/, "it has to reach the output channel");
});

/** The webview must report even an empty drop, or the log above never runs. */
test("the webview reports a drop even when it read nothing", () => {
  const drop = js.slice(js.indexOf('window.addEventListener("drop"'));
  const body = drop.slice(0, 1800);
  assert.match(body, /types:/, "the offered formats go up with the message");
  assert.doesNotMatch(
    body,
    /if \(values\.length > 0\) vscode\.postMessage/,
    "reporting must not be conditional on having understood the drop"
  );
});

/**
 * Dragging into the panel is unreliable and always was. VS Code's
 * WebviewElement runs
 *
 *   windowDidDragStart() -> element.style.pointerEvents = "none"
 *
 * for the duration of any drag anywhere in the window, so a plain drag never
 * reaches the panel and nothing inside the webview can change that.
 *
 * The `@kiro` participant used to be the answer, because the native chat box is
 * ordinary workbench DOM. It was removed in 0.24.0 as an undocumented second
 * entry point nobody used, which leaves the routes that do not depend on a drop
 * landing: the attach menu, the Explorer's context-menu command, and paste. At
 * least one of those has to stay reachable, or files cannot be attached at all.
 */
test("files can be attached without relying on a drop", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

  const commands = pkg.contributes.commands.map((c) => c.command);
  assert.ok(
    commands.includes("kiroChat.addFileToContext"),
    "the Explorer command is the route that does not involve dragging at all"
  );
  assert.ok(
    (pkg.contributes.menus["explorer/context"] ?? []).some(
      (item) => item.command === "kiroChat.addFileToContext"
    ),
    "and it has to actually appear in the Explorer's right-click menu"
  );

  for (const action of ["attachFiles", "attachFolders", "attachImage"]) {
    assert.match(
      provider,
      new RegExp(`data-act="${action}"`),
      `the attach menu must still offer ${action}`
    );
  }
});

/** The drop handler stays, since a Shift-drag can still reach the panel. */
test("the panel still listens for a drop even though one may never arrive", () => {
  assert.match(js, /addEventListener\("drop"/, "the drop listener should remain");
  assert.match(js, /addEventListener\("dragover"/, "and the dragover that shows the zone");
});

/**
 * Drag a file in, then focus that same file, and the chip row used to show it
 * twice — once as the attachment and once as "the file you are looking at".
 * The extension already dropped the duplicate before sending, so the second
 * chip was claiming something that did not happen.
 */
test("the file you are looking at is not shown twice when already attached", () => {
  assert.match(js, /function samePathish/, "the chips need to compare paths properly");
  const render = js.slice(js.indexOf("function renderChips"));
  assert.match(
    render.slice(0, 900),
    /activeAlreadyAttached/,
    "renderChips must skip the active file when it is already attached"
  );
});

/** Both the live chip and the dismissed "add it back" chip must respect it. */
test("neither form of the active-file chip duplicates an attachment", () => {
  // The whole function, not a fixed slice of it: counting inside the first
  // 2600 characters made this fail for a comment being added above the chips.
  const render = js.slice(js.indexOf("function renderChips"));
  const body = render.slice(0, render.indexOf("\n  function "));
  const guards = body.match(/!activeAlreadyAttached/g) ?? [];
  assert.equal(guards.length, 2, "both the live and the muted chip need the guard");
});

/*
 * Dismissing the file chip, then highlighting something in that same file.
 *
 * The selection chip stood in for the file chip whenever a selection was
 * being sent — including when the file had been dismissed and so was not
 * being sent at all. The file chip vanished, its × went with it, and all that
 * was left on screen was a chip whose tooltip read "Kiro gets <file> and the
 * highlighted lines" while no resource_link went out. The panel asserted
 * something it had itself decided not to do, and left no control to undo it.
 */
test("a dismissed file chip does not hide behind the selection chip", () => {
  const render = js.slice(js.indexOf("function renderChips()"));
  const body = render.slice(0, render.indexOf("\n  function "));

  assert.match(
    body,
    /const selectionCoversActiveFile = sendingSelection && includeActiveFile;/,
    "a file that is not going cannot be stood in for"
  );
  assert.match(body, /includeActiveFile = true;/, "and the muted chip adds it back");

  // And the tooltip has to say which of the two situations it is.
  const title = body.slice(body.indexOf("chip.title = includeActiveFile"), body.length);
  assert.ok(title.length > 0, "the selection chip's title must depend on it");
  assert.match(title.slice(0, 500), /and the highlighted lines/, "the file plus the lines");
  assert.match(
    title.slice(0, 500),
    /but not the rest of the file/,
    "or the lines alone, once the file has been dismissed"
  );
});

/*
 * "I add another file to add on the context" only ever held for one message.
 *
 * The row was emptied after every send, so the second message carried
 * strictly less than the first — and because the automatic file chip comes
 * back on its own the row still looked populated, so nothing on screen said
 * the rest had gone. Files and folders stay now. An image does not: its
 * base64 rides in the prompt itself, and a sticky one would re-send megabytes
 * every turn for a picture Kiro has already been shown.
 */
test("attached files outlive the message, and images do not", () => {
  const send = provider.slice(provider.indexOf("async send("));
  const body = send.slice(0, send.indexOf("\n  async sendFromEditor"));
  assert.match(
    body,
    /this\.attachments\s*\r?\n?\s*\.filter\(\(a\) => a\.kind !== "image"\)/,
    "files and folders survive the send; images are consumed by it"
  );
  assert.doesNotMatch(
    body,
    /this\.attachments = \[\];/,
    "which means the row is no longer emptied wholesale after a turn"
  );
  // Starting a different conversation is the other matter entirely.
  assert.match(provider, /this\.attachments = \[\];/, "a new chat still clears it");
});

/*
 * With chips left on the row, Enter on an empty box would have started a real
 * turn out of things already sent — credits spent on a message nobody wrote.
 * "Look at these" with no words is a genuine message, but only the once, so
 * what the guard asks is whether anything on the row is new.
 */
test("a blank composer cannot re-send chips that already went", () => {
  assert.match(provider, /carried: true/, "the provider marks what it has already sent");
  assert.match(provider, /carried: a\.carried === true/, "and passes the mark down");
  assert.match(
    js,
    /const somethingNew = attachments\.some\(\(a\) => !a\.carried\);/,
    "and the composer asks whether anything is new before sending nothing"
  );
  assert.match(js, /if \(!text && !somethingNew\) return;/);
  assert.match(
    provider,
    /if \(!trimmed && !this\.attachments\.some\(\(a\) => a\.carried !== true\)\) return;/,
    "the provider applies the same rule, for the paths that skip the webview"
  );
});

/*
 * Attachments outlive the message they were sent with, so the row needs a way
 * to be emptied. `clearAttachments` sat in the provider's switch for a long
 * time with nothing posting it — the dead half of a contract. Both halves, as
 * ever, or the control does nothing and says nothing about it.
 */
test("the chip row can be cleared, and both halves of that exist", () => {
  assert.match(js, /chips-clear/, "the control needs its class");
  assert.match(
    js,
    /vscode\.postMessage\(\{ type: "clearAttachments" \}\)/,
    "the webview has to post it"
  );
  assert.match(provider, /case "clearAttachments":/, "and the provider has to handle it");
  // A single chip already has an × beside it, so a second control for the
  // same job is noise. The row only offers this past one.
  const render = js.slice(js.indexOf("function renderChips()"));
  const body = render.slice(0, render.indexOf("\n  function "));
  assert.match(body, /if \(attachments\.length > 1\)/, "only worth it past one chip");
});

/*
 * The `background: none` test above catches only the fully plain buttons.
 * `.chip-muted` sets `background: transparent` and keeps a dashed border, so
 * it slipped straight through and painted solid primary blue under the
 * pointer — a fourth instance of a bug that has now shipped four times. The
 * rule is about the global `button:hover`, not about any particular way of
 * spelling "no background of my own", so ask it the right way round: every
 * element this file builds as a <button> that restyles its background has to
 * restyle its hover too.
 */
test("every button that restyles its background restyles its hover", () => {
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)];
  const hovered = new Set();
  const restyled = new Set();
  for (const [, rawSelector, declarations] of rules) {
    for (const selector of rawSelector.split(",").map((s) => s.trim())) {
      // A hover rule need not be bare `.name:hover` — `.permission-option`
      // guards its own with `:hover:not(:disabled)`, and that counts. What
      // does not count is a descendant rule, which styles something else, so
      // the class and the `:hover` have to sit in one compound selector.
      const hover = /^\.([\w-]+)[^\s,]*:hover/.exec(selector);
      if (hover) hovered.add(hover[1]);
      const plain = /^\.([\w-]+)$/.exec(selector);
      if (plain && /(^|[;\s])background(-color)?:/.test(declarations)) {
        restyled.add(plain[1]);
      }
    }
  }

  const missing = [];
  let found = 0;
  for (const [, list] of js.matchAll(
    /createElement\("button"\)[\s\S]{0,400}?\.className = "([^"]+)"/g
  )) {
    found += 1;
    const names = list.split(/\s+/).filter(Boolean);
    // Any one of the element's classes carrying a :hover is enough — the
    // question is what the element does, not what each class does alone.
    if (names.some((n) => restyled.has(n)) && !names.some((n) => hovered.has(n))) {
      missing.push(list);
    }
  }
  assert.ok(found >= 4, `expected several built buttons, found ${found}`);
  assert.deepEqual(
    missing,
    [],
    `these paint solid blue on hover, nothing outranking button:hover: ${missing.join(" | ")}`
  );
});




/**
 * Keep-or-undo lives above the message box, not in the transcript.
 *
 * It appears the moment the inline diff opens, so both routes are open at
 * once: decide each hunk in the diff, or take the whole file from here. Inside
 * the transcript it would scroll away exactly when it is needed, and it has to
 * stay put while the user reads the diff in another tab.
 */
test("keep or undo is pinned above the composer, outside the transcript", () => {
  assert.match(provider, /id="change-bar"/, "the bar needs its own element");
  // Before #chips, so it sits between the transcript and the message box.
  const bar = provider.indexOf('id="change-bar"');
  const chips = provider.indexOf('id="chips"');
  const messages = provider.indexOf('id="messages"');
  assert.ok(bar > messages && bar < chips, "the bar belongs between the transcript and the chips");

  assert.match(css, /^\.change-bar \{/m, "the bar needs a style");

  /*
   * Scoped to the renderer, not the whole file.
   *
   * This used to assert that `messagesEl.appendChild(card)` appeared nowhere
   * in chat.js at all, which was a proxy for "the change bar is not in the
   * transcript" and held only for as long as the change bar was the only card
   * in the panel. It stopped being true the moment a card that genuinely does
   * belong in the transcript arrived — a slash command's result — and failed
   * for a reason that had nothing to do with what it was protecting. The
   * question is where *this* bar is drawn, so ask it of this bar's renderer.
   */
  const renderer = sliceFrom(js, "function renderChangeBar()");
  assert.ok(renderer, "renderChangeBar must exist to be checked");
  assert.doesNotMatch(renderer, /messagesEl\./, "it must not go in the transcript");
  assert.match(renderer, /changeBar\./, "it belongs to the pinned bar");
});

/** It shows while the diff is open, not only after the turn has finished. */
test("the bar appears as soon as the review opens", () => {
  assert.match(provider, /onReviewActive/, "the provider must hear about an open review");
  assert.match(js, /case "reviewActive"/, "and the webview must show it");
  assert.match(
    reviewer,
    /onDidChangeActiveReview/,
    "the reviewer must announce when a review is on screen"
  );
});

/*
 * Every message the provider posts about changes needs a handler here.
 *
 * The webview half of the bar went missing once. Nothing failed loudly: the
 * extension went on announcing reviews and finished turns into a switch that
 * ignored them, so no card ever appeared and the only way to answer an edit
 * was to hunt down the diff tab. A posted message with no case is silent.
 */
test("the webview handles every change message the provider posts", () => {
  for (const type of ["reviewActive", "turnChanges", "changesUndone"]) {
    assert.match(
      provider,
      new RegExp(`type: "${type}"`),
      `the provider posts ${type}`
    );
    assert.match(js, new RegExp(`case "${type}"`), `so the webview must handle ${type}`);
  }
  assert.match(js, /function renderChangeBar\(/, "the bar has to be drawn somewhere");
});

/*
 * Every row the panel can offer must be a target the extension accepts.
 *
 * This is the test that was missing when "Add private project memory" shipped
 * making an ordinary committable `memory.md`. The old check only asserted that
 * a `case "openMemory"` existed — it did — while the case itself narrowed the
 * value by hand and turned "private" into "project". Checking that both halves
 * exist is not the same as checking they agree about what may be sent.
 */
test("the panel cannot offer a memory target the extension would not accept", () => {
  const { MEMORY_TARGETS } = require("../out/memory");
  const labels = js.slice(js.indexOf("const ADD_MEMORY_LABELS = {"));
  const block = labels.slice(0, labels.indexOf("};"));
  const offered = (block.match(/^\s*(\w+):/gm) || []).map((k) => k.trim().replace(":", ""));

  assert.ok(offered.length > 0, "the labels must be found, or this checks nothing");
  for (const scope of offered) {
    assert.ok(
      MEMORY_TARGETS.includes(scope),
      `the panel offers "${scope}" but the extension does not accept it`
    );
  }
});

/*
 * And the handler must route through that check rather than narrowing by hand.
 * The conditional it replaced was correct for exactly as long as there were
 * two targets, then quietly wrong — and a default that swallows an unknown
 * value cannot report that anything is wrong.
 */
test("the openMemory handler validates rather than narrows", () => {
  const at = provider.indexOf('case "openMemory"');
  const body = provider.slice(at, provider.indexOf('case "removeMemory"', at));
  assert.match(body, /memoryTarget\(/, "the target is validated");
  assert.doesNotMatch(
    body,
    /\?\s*"(project|private|global)"\s*:/,
    "and never rounded to a literal by hand"
  );
});

/*
 * Standing instructions are two halves like everything else here.
 */
test("the instructions box and the extension agree", () => {
  assert.match(provider, /instructionsRow/, "the provider sends the preview");
  assert.match(js, /case "openInstructions"/, "the command's message is handled");
  assert.match(js, /type: "setInstructions"/, "the box saves through a message");
  assert.match(provider, /case "setInstructions"/, "which the provider must handle");
  assert.match(provider, /id="instructions-panel"/, "and the panel needs its element");
  assert.match(css, /^\.instructions-panel \{/m, "and a style");
});

/*
 * The box never writes its own state.
 *
 * Saving posts and closes; the configuration watcher posts the text back. A
 * box that kept what it had just sent would show instructions the settings do
 * not hold if the write failed — the permission card's rule, applied to a
 * textarea.
 */
/*
 * Cancel and Save must not look alike.
 *
 * Cancel was given a class the stylesheet does not define, so the global
 * `button` rule painted it the same primary blue as Save — two identical
 * buttons, one of which throws the edit away. Only one of a pair may look
 * like the answer, and it has to be the one that keeps the work.
 */
test("cancel does not look like the recommended action", () => {
  assert.match(provider, /id="instructions-cancel" class="instructions-cancel"/);
  assert.match(css, /^\.instructions-cancel \{/m, "the class has to actually exist");
  assert.match(
    css,
    /\.instructions-cancel \{[^}]*button-secondaryBackground/,
    "and paint itself as secondary"
  );
  assert.match(css, /^\.instructions-cancel:hover \{/m, "including on hover");
});

test("saving instructions asks rather than assumes", () => {
  const fn = js.slice(js.indexOf("function saveInstructions("));
  const body = fn.slice(0, fn.indexOf("\n  }"));
  assert.match(body, /postMessage/, "it asks the extension");
  assert.doesNotMatch(body, /instructions\s*=/, "and never sets the local copy itself");
});

/*
 * Enter must not submit. This is a list of instructions typed over several
 * lines, and the composer's Enter-to-send habit would throw away the rest.
 */
test("Enter makes a new line in the instructions box", () => {
  const fn = js.slice(js.indexOf('instructionsText.addEventListener("keydown"'));
  const body = fn.slice(0, fn.indexOf("\n  });"));
  assert.match(body, /ctrlKey \|\| event\.metaKey/, "only Ctrl+Enter saves");
  assert.match(body, /Escape/, "and Escape closes");
});

/*
 * Instructions ride in every message, so the block goes outside the workflow
 * block rather than between it and the request — that block ends "The user's
 * request follows", and splitting the two makes it untrue.
 */
test("instructions wrap the workflow block, never split it", () => {
  const at = provider.indexOf("const blocks = applyInstructions(");
  assert.ok(at > 0, "instructions must be applied when a message is built");
  const call = provider.slice(at, provider.indexOf(";", at));
  assert.match(call, /applyInstructions\(\s*applyChatMode\(/, "outside, not inside");
});

/*
 * Neither dropdown may call itself a listbox.
 *
 * Both did, and neither held options. The mode menu carries group headings,
 * notes, one-of rows, switches and a file row with two buttons in it; the
 * model menu carries an empty-state note and a footer with a "Check account
 * usage" *button* buried inside. A listbox admits none of that, so a screen
 * reader was told to expect a list of options and handed something else.
 *
 * The fix is no container role rather than a different one: listbox, menu and
 * radiogroup all promise arrow-key navigation that is not implemented, and
 * declaring one puts a reader into a mode where Tab — the navigation that
 * does work, because every row is a real button — stops. Claiming a state we
 * are not in is the mistake this codebase keeps paying for.
 */
test("the dropdowns do not claim to be listboxes", () => {
  for (const id of ["mode-menu", "model-menu"]) {
    const tag = provider.slice(provider.indexOf(`id="${id}"`));
    const openTag = tag.slice(0, tag.indexOf(">"));
    assert.doesNotMatch(openTag, /role=/, `#${id} must not declare a container role`);
  }
  assert.doesNotMatch(
    provider,
    /aria-haspopup="listbox"/,
    "and neither button may announce a listbox popup"
  );
});

/*
 * A row that is one of a group says so with `aria-current`, which is valid on
 * any element. `role="option"` and `aria-selected` mean something only inside
 * a listbox, and there is no longer one to be inside.
 */
test("a chosen row is marked current, not selected", () => {
  /*
   * Scoped to the two menus this is about, not the whole file.
   *
   * It used to assert that `role="option"` appeared nowhere in chat.js at all,
   * which was a proxy for "these dropdowns are not listboxes" and held only
   * while they were the only menus in the panel. The slash menu is a listbox
   * and the objection here does not reach it: the reason these two refuse a
   * container role is that it promises arrow-key navigation they do not
   * implement and puts a screen reader into a mode where Tab stops working —
   * and Tab is their navigation. Focus never enters the slash menu at all, the
   * arrows really are its navigation, and `aria-activedescendant` is only
   * meaningful pointing at an option inside a listbox. Same principle, opposite
   * conclusion, because the facts are opposite.
   */
  for (const name of ["function renderModelMenu()", "function renderModeMenu()"]) {
    const menu = sliceFrom(js, name);
    assert.ok(menu, `${name} should be findable`);
    assert.doesNotMatch(
      menu,
      /setAttribute\(\s*"role"\s*,\s*"option"\s*\)/,
      `no row in ${name} is an option`
    );
    assert.doesNotMatch(
      menu,
      /setAttribute\(\s*"aria-selected"/,
      `and none in ${name} claims listbox selection`
    );
  }
  assert.match(
    js,
    /setAttribute\(\s*"aria-current"\s*,\s*"true"\s*\)/,
    "the chosen row says it is the current one"
  );
});

/*
 * The switch keeps its role and its `aria-checked` — valid on a button, and
 * the CSS draws `.menu-switch` from that same attribute, so the visible state
 * and the announced state cannot drift apart.
 */
test("a toggle is still a switch, drawn from what it announces", () => {
  assert.match(js, /setAttribute\("role", "switch"\)/, "a toggle announces itself as one");
  assert.match(js, /setAttribute\("aria-checked"/, "with a state");
  assert.match(css, /\[aria-checked="true"\] > \.menu-switch \{/, "which is what paints it");
});

/*
 * The memory rows are two halves like everything else here.
 *
 * The provider posts the counts and answers the clicks; the webview draws the
 * rows and asks for the counts. A posted message with no case is silent, and
 * a row posting a type nothing handles is a control that does nothing — both
 * failures look identical from the panel, which is why they are pinned here.
 */
test("the webview and the provider agree about memory", () => {
  assert.match(provider, /type: "memory"/, "the provider posts the memory counts");
  assert.match(js, /case "memory"/, "so the webview must handle them");

  for (const type of ["requestMemory", "openMemory", "removeMemory"]) {
    assert.match(js, new RegExp(`type: "${type}"`), `the webview posts ${type}`);
    assert.match(provider, new RegExp(`case "${type}"`), `so the provider must handle ${type}`);
  }
});

/*
 * The counts are read when the menu opens, not watched.
 *
 * The global steering folder is outside every workspace root, so a file
 * watcher covers the project half and misses the other — one scope current
 * and one stale is worse than neither, because nothing on screen says which
 * is which.
 */
test("opening the mode menu asks for the memory counts", () => {
  const handler = js.slice(js.indexOf("modeBtn.addEventListener"));
  const body = handler.slice(0, handler.indexOf("});"));
  assert.match(body, /requestMemory/, "the counts are fetched as the menu opens");
});

/*
 * The group draws rows and nothing else.
 *
 * An empty state was tried and removed: a lone "Add project memory" row
 * already says there is none, and a line of prose above saying so is the menu
 * explaining itself twice. It also had to be gated on whether the folders had
 * been read yet, or it asserted "nothing yet" in the moment before the counts
 * arrived — a whole failure mode that only existed to support the sentence.
 */
test("the memory group has no empty-state prose", () => {
  const menu = js.slice(js.indexOf("function renderModeMenu("));
  const at = menu.indexOf('"What Kiro always knows"');
  assert.ok(at > 0, "the group must be found, or this checks nothing");
  // To the end of renderModeMenu: the memory group is the last thing in it.
  const body = menu.slice(at, menu.indexOf("\r\n  }"));
  assert.doesNotMatch(body, /menu-note/, "no note is drawn under the memory rows");
  assert.doesNotMatch(body, /Nothing yet/, "and no empty-state sentence");
});

/*
 * An "add memory" row is an action and not a state. It must not wear the
 * selection highlight (which means "this one of the group is chosen") or a
 * switch (which means "this is on"), because it is neither.
 */
test("the add-memory rows are actions, not settings", () => {
  const menu = js.slice(js.indexOf("function renderModeMenu("));
  const group = menu.slice(menu.indexOf("for (const item of memory.add)"));
  const rows = group.slice(0, group.indexOf("modeMenu.appendChild(row)"));
  assert.doesNotMatch(rows, /role: "switch"/, "an add row is not a toggle");
  // The option keys the row actually passes, rather than a substring search:
  // "description:" contains "on:", so grepping for that passes either way.
  const keys = (rows.match(/^\s*(\w+):/gm) || []).map((k) => k.trim());
  assert.ok(keys.length > 0, "the row must pass options, or this checks nothing");
  assert.ok(!keys.includes("on:"), "and it is not one of a chosen group");
});

/*
 * A memory file row holds two buttons — open, and remove — so it cannot be a
 * `menuRow`, which returns a `<button>`: a button cannot contain another one.
 * Nesting them renders as one button in some engines and two in others, and
 * the × stops being separately clickable.
 */
test("a memory file row is not itself a button", () => {
  const fn = js.slice(js.indexOf("function memoryFileRow("));
  const body = fn.slice(0, fn.indexOf("\n  }"));
  assert.match(body, /createElement\("div"\)/, "the row is a div");
  assert.doesNotMatch(
    body,
    /const row = document\.createElement\("button"\)/,
    "the row must not be a button, because it contains two"
  );
  assert.match(body, /memoryAct = "open"/, "one button opens the file");
  assert.match(body, /memoryAct = "remove"/, "the other removes it");
});

/*
 * Removing is answered by the extension, never by the panel.
 *
 * A row that struck itself out on click would be claiming an outcome it
 * cannot know — the confirmation may be cancelled, the path may be refused,
 * the delete may fail. This is the permission card's rule: say nothing until
 * the extension has answered, then redraw from what it reports.
 */
test("the panel does not decide a removal for itself", () => {
  const handler = js.slice(js.indexOf('modeMenu.addEventListener("click"'));
  const body = handler.slice(0, handler.indexOf("\n  });"));
  const remove = body.slice(body.indexOf('=== "remove"'));
  const untilReturn = remove.slice(0, remove.indexOf("return;"));
  assert.match(untilReturn, /postMessage/, "it asks the extension");
  assert.doesNotMatch(untilReturn, /\.remove\(\)|removeChild|renderModeMenu/, "and draws nothing");
});

/*
 * The path is checked against the folders at the moment of the click. A path
 * in a webview message is not a licence to delete a file: the panel could be
 * stale, and a message is not proof of anything.
 */
test("a removal is refused unless the path is really a memory file", () => {
  const fn = provider.slice(provider.indexOf("private async removeMemory("));
  const body = fn.slice(0, fn.indexOf("\n  }"));
  assert.match(body, /isListedMemory/, "the path has to be checked against the listing");
  const guard = body.indexOf("isListedMemory");
  const del = body.indexOf("fs.delete");
  assert.ok(guard < del, "and checked before anything is deleted");
});

/*
 * The exclude entry is written before the file is ever shown.
 *
 * The gap between creating a private memory file and hiding it from git is a
 * gap in which `git add .` commits the very thing the row promised to hold
 * back. Ordering is the whole protection here, and nothing about it is
 * visible from the outside.
 */
test("a private memory file is hidden from git before it is opened", () => {
  const fn = provider.slice(provider.indexOf("async openMemory("));
  const body = fn.slice(0, fn.indexOf("\n  }"));
  const excluded = body.indexOf("excludeFromGit");
  const opened = body.indexOf("this.openPath");
  assert.ok(excluded > 0, "a private file must be excluded from git");
  assert.ok(opened > 0, "and then opened");
  assert.ok(excluded < opened, "excluded first, or git can see it in between");
});

/*
 * --git-common-dir, not --git-dir and not a `.git` joined onto the root. In a
 * worktree `.git` is a file and the worktree's own gitdir has no info/; git
 * reads the common directory's exclude. Getting this wrong works on the
 * machine it was written on and silently leaves the file committable.
 */
test("the exclude file is found through git, not by guessing at .git", () => {
  assert.match(provider, /"--git-common-dir"/, "the common dir is the one git reads");
  assert.doesNotMatch(
    provider,
    /path\.join\([^)]*"\.git", "info"/,
    "the path must never be assembled by hand"
  );
});

/*
 * The row says whether git really cannot see the file, rather than assuming
 * it. A file that is already tracked is not ignored by any rule, and that is
 * precisely the case where the reassuring label would be false.
 */
test("a private row's claim is checked against git, not assumed", () => {
  assert.match(provider, /check-ignore/, "git is asked whether the file is ignored");
  assert.match(provider, /git can see this/, "and the row says so when it is not");
});

/*
 * It goes to the recycle bin. A menu is a careless place, this row sits under
 * rows that merely open a file, and "I meant the other memory.md" must not be
 * answered with "it is gone".
 */
test("a removed memory file is recoverable", () => {
  assert.match(
    provider,
    /fs\.delete\(vscode\.Uri\.file\(target\), \{ useTrash: true \}\)/,
    "removal must use the recycle bin, not an unlink"
  );
});

/*
 * Kiro reads AGENTS.md as memory too. A panel reporting "none yet" while Kiro
 * is reading one is the exact confusion this feature exists to remove.
 */
test("AGENTS.md is reported as memory even though the button never writes one", () => {
  assert.match(provider, /AGENTS.md/, "the provider has to look for it");
});

/** From the bar, Keep and Reject drive the open review rather than the turn. */
test("the bar drives the open review when there is one", () => {
  assert.match(provider, /acceptActiveReview\(\)/);
  assert.match(provider, /rejectActiveReview\(\)/);
  assert.match(reviewer, /async acceptActive\(\)/);
  assert.match(reviewer, /async rejectActive\(\)/);
});

/** Clicking either twice would act on decisions already consumed. */
test("the bar's buttons cannot be fired twice", () => {
  const render = js.slice(js.indexOf("function renderChangeBar"));
  const body = render.slice(0, 2600);
  assert.match(body, /keep\.disabled = true/);
  assert.match(body, /undo\.disabled = true/);
});

/*
 * The CSP nonce has to be unpredictable, because that is its entire job.
 *
 * It was built from Math.random(), which is seeded per process and recoverable
 * from a handful of samples — so the one value standing between the page and an
 * injected <script> was guessable. The page is otherwise locked down
 * (default-src 'none', no inline handlers), and this closes the gap rather than
 * relying on that.
 */
test("the CSP nonce comes from a cryptographic source", () => {
  const body = provider.slice(provider.indexOf("function nonce("));
  const head = body.slice(0, 400);
  assert.match(head, /randomBytes\(/, "the nonce should be generated with crypto.randomBytes");
  assert.doesNotMatch(head, /Math\.random/, "Math.random is not unpredictable");
  assert.match(
    provider,
    /from "node:crypto"/,
    "randomBytes has to actually be imported"
  );
});

/** A nonce short enough to guess is no better than a predictable one. */
test("the nonce carries enough entropy to be worth having", () => {
  const body = provider.slice(provider.indexOf("function nonce("), provider.indexOf("function nonce(") + 400);
  const bytes = body.match(/randomBytes\((\d+)\)/);
  assert.ok(bytes, "the byte count should be explicit");
  assert.ok(
    Number(bytes[1]) >= 16,
    `${bytes[1]} bytes is too few for a nonce; 16 is the usual floor`
  );
});

// ---------------------------------------------------------------
// Kiro's own slash commands
// ---------------------------------------------------------------

/**
 * Both halves, as ever.
 *
 * A posted message with no matching case is silent: the change bar was lost
 * from chat.js once and nothing failed loudly, because the provider went on
 * posting into a switch with no cases for it. Every message type carrying this
 * feature needs an end at each side.
 */
test("every slash command message is both posted and handled", () => {
  for (const type of ["commands", "commandRunning", "commandResult", "rewindTurns", "rewound"]) {
    assert.match(provider, new RegExp(`type: "${type}"`), `the provider must post ${type}`);
    assert.match(js, new RegExp(`case "${type}"`), `the webview must handle ${type}`);
  }
  // And the other direction: what the composer sends must be answered.
  for (const type of ["runCommand", "listRewind", "rewindTo"]) {
    assert.match(js, new RegExp(`type: "${type}"`), `the webview must send ${type}`);
    assert.match(provider, new RegExp(`case "${type}"`), `the provider must handle ${type}`);
  }
});

/**
 * The list is Kiro's, not ours.
 *
 * Hard-coding the commands would go stale on the next kiro-cli release, and
 * silently: a name that no longer exists is rejected by `commands/execute` as
 * a parse error, which is not a thing to show someone who picked it off a
 * menu. `_kiro.dev/commands/available` was already being dropped on the floor.
 */
test("the command list comes from Kiro's own announcement", () => {
  const session = fs.readFileSync(path.join(root, "src", "kiroSession.ts"), "utf8");
  assert.match(session, /commands\/available/, "the notification must be read");
  assert.match(
    session,
    /bareMethod\(method\) === "commands\/available"/,
    "and compared with the vendor prefix stripped, as every Kiro notification must be"
  );
  assert.match(session, /onCommands/, "the session must pass the list on");
  assert.match(provider, /postCommands/, "the provider must hand it to the webview");
});

/**
 * A panel rebuilt mid-conversation never hears the announcement, which fires
 * once per session. Without a replay on `ready` the menu is empty until the
 * next new chat — and dragging the panel between the sidebar and the bottom
 * panel is the ordinary way to get there.
 */
test("the command list survives the panel being rebuilt", () => {
  const ready = sliceFrom(provider, "private async onWebviewReady");
  assert.match(ready, /postCommands/, "ready must re-post the commands");
});

/**
 * The webview decides whether to open a menu; the extension decides whether to
 * run anything. The name is checked against the live session either way, so a
 * `runCommand` that did not come from the composer cannot reach `execute`.
 */
test("the extension checks the command name against the live list", () => {
  const handler = provider.slice(provider.indexOf('case "runCommand"'));
  const scoped = handler.slice(0, handler.indexOf('case "listRewind"'));
  assert.match(scoped, /availableCommands\.find/, "the name must be looked up");
  assert.match(scoped, /if \(!known\) break/, "and an unknown one must go no further");
});

/** The menu needs an element, a style, and a home inside the composer. */
test("the slash menu is a real anchored popup", () => {
  assert.match(provider, /id="slash-menu"/, "the menu needs its own element");
  assert.match(css, /^\.slash-menu \{/m, "and a style");
  // Anchored inside .composer, which is the positioned parent, so it cannot
  // spill out of a narrow sidebar.
  const menu = provider.indexOf('id="slash-menu"');
  const composer = provider.indexOf('id="composer"');
  const row = provider.indexOf('class="composer-row"');
  assert.ok(menu > composer && menu < row, "it belongs inside the composer");
});

/**
 * A row is a button, and the global `button` style paints one primary blue on
 * hover — `button:hover` is (0,1,1) and beats any single class. `.slash-item`
 * says so itself rather than leaning on `.popup button:hover`, because a
 * descendant rule does not travel with the element.
 */
test("a slash menu row cancels the global button hover on its own", () => {
  assert.match(css, /^\.slash-item \{/m);
  assert.match(css, /^\.slash-item:hover/m, "it must cancel button:hover itself");
});

/**
 * Enter with the menu open picks a command. It must not also reach `submit()`,
 * or choosing one would send the half-typed name as a message at the same time.
 */
test("the menu owns Enter while it is open", () => {
  const handler = sliceFrom(js, 'inputEl.addEventListener("keydown"');
  assert.match(handler, /!slashMenu\.hidden/, "the menu must be consulted first");
  assert.match(handler, /acceptSlash/, "Enter picks the highlighted row");
  const guard = handler.indexOf("!slashMenu.hidden");
  // The call, not the mention of it: the comment above the guard names
  // `submit()` too, and searching for that found the documentation.
  const submit = handler.indexOf("submit();");
  assert.ok(guard > -1 && submit > guard, "the menu is checked before submit is reached");
});

/**
 * A command is not a message. It goes to Kiro's command endpoint, so it must
 * not also start a turn.
 */
test("a slash command is routed away from the message path", () => {
  const submit = sliceFrom(js, "function submit()");
  assert.match(submit, /parseSlash\(text\)/, "submit must recognise a command");
  const slash = submit.indexOf("parseSlash(text)");
  const send = submit.indexOf('type: "send"');
  assert.ok(slash > -1 && send > slash, "the command check comes before the send");
});

/**
 * The two parsers — `parseSlashInput` in src, `parseSlash` here — must agree
 * that a leading slash is only a command when the name is one Kiro has.
 * Otherwise "/usr/bin/env is on my PATH" is eaten instead of sent.
 */
test("the webview parser also requires a name Kiro has", () => {
  const parser = sliceFrom(js, "function parseSlash(text)");
  assert.match(parser, /slashCommands\.find/, "it must check the known list");
  assert.match(parser, /if \(!known\) return null/, "and give up when there is no match");
});

function loadTrim() {
  const source = sliceFrom(js, "function trimHistoryToTurns(items, keep)");
  assert.ok(source, "trimHistoryToTurns should be findable");
  return new Function(source + "\nreturn trimHistoryToTurns;")();
}

/**
 * After a rewind Kiro has forgotten everything past the chosen turn. A
 * transcript still showing those messages is the same lie as a permission card
 * claiming an answer nobody received.
 *
 * Counted in *user messages*, because the panel's entries and Kiro's log
 * indices are two different numberings — but "the first N things I said" is
 * the same span in both.
 */
test("a rewind trims the transcript to the turns Kiro kept", () => {
  const trim = loadTrim();
  const chat = [
    { role: "user", text: "one" },
    { role: "agent", text: "1" },
    { role: "user", text: "two" },
    { role: "permission", title: "write a file" },
    { role: "agent", text: "2" },
    { role: "user", text: "three" },
    { role: "agent", text: "3" },
  ];
  assert.deepEqual(
    trim(chat, 2).map((m) => m.text || m.title),
    ["one", "1", "two", "write a file", "2"],
    "the kept turn keeps its reply, its steps and its permissions"
  );
  assert.equal(trim(chat, 3).length, 7, "keeping every turn removes nothing");
  assert.equal(trim(chat, 1).length, 2);
});

/**
 * A transcript holding fewer user messages than Kiro kept is one whose head
 * has been trimmed from storage. There is nothing to remove, and removing
 * anything would be guessing.
 */
test("a transcript shorter than the rewind asks for is left alone", () => {
  const trim = loadTrim();
  const chat = [{ role: "user", text: "only one" }, { role: "agent", text: "a" }];
  assert.equal(trim(chat, 5).length, 2);
  assert.equal(trim([], 3).length, 0);
});

/**
 * Rewinding forks: the conversation afterwards has a *different* session id.
 * Leaving `chatSessionId` on the old one would resume the un-rewound original
 * next time the chat was opened — the wrong-session bug `openChat` guards
 * against from the other end.
 */
test("a rewind repoints the chat at the session Kiro forked", () => {
  const rewind = sliceFrom(provider, "private async rewindTo(");
  assert.match(rewind, /this\.chatSessionId = forked/, "the record must follow the fork");
  assert.match(rewind, /saveCurrentChat/, "and be written down");

  const session = fs.readFileSync(path.join(root, "src", "kiroSession.ts"), "utf8");
  const method = sliceFrom(session, "async rewindTo(logIndex: number)");
  assert.match(method, /loadSession\(forked\)/, "the forked session must be loaded");
});

/**
 * `/clear` wipes Kiro's memory of the conversation and `/model` changes the
 * model the button names. A panel that goes on showing either is telling the
 * user something untrue.
 */
test("a command that changes what the panel shows is believed", () => {
  const runner = sliceFrom(provider, "private async runSlashCommand(");
  assert.match(runner, /name === "clear"/, "clear must be recognised");
  assert.match(runner, /type: "cleared"/, "and empty the transcript");
  assert.match(runner, /noteModelChanged/, "model updates the button");
});

/**
 * A command result is recorded, so reopening the chat shows that `/compact`
 * was run rather than a gap where the conversation appears to shrink for no
 * reason — and it is drawn by the same renderer, not a second one.
 */
test("a command result joins the chat's record", () => {
  assert.match(js, /recordCommand\(/, "results must be recorded");
  assert.match(js, /role: "command"/, "under their own role");
  const restore = sliceFrom(js, "function restoreHistory(saved)");
  assert.match(restore, /item\.role === "command"/, "and restored");
  assert.match(restore, /addCommandCard\(item\.label/, "through the one card renderer");
});

/**
 * A command's answer is terminal output, not markdown.
 *
 * `/help` returns 51 lines whose columns are held apart by runs of spaces.
 * Every one fell through the markdown renderer to the paragraph branch — 51
 * `<p>`s with a margin between each — and HTML collapsed the spaces, so every
 * command name ran straight into its description. `/tools`, `/model`,
 * `/agent` and `/context` are all the same shape.
 */
function loadCommandOutput() {
  // The whole renderer, because the prose branch calls into `renderMarkdown`.
  const from = js.indexOf("function escapeHtml");
  const to = js.indexOf("async function copyText");
  assert.ok(from > -1 && to > from, "the renderer should be findable");
  return new Function(
    js.slice(from, to) +
      sliceFrom(js, "function renderCommandOutput(text)") +
      "\nreturn renderCommandOutput;"
  )();
}

test("multi-line command output keeps the alignment Kiro wrote", () => {
  const render = loadCommandOutput();
  const help = "Available Commands:\n\n  /agent      Select or list available agents\n";
  const html = render(help);
  assert.match(html, /<pre>/, "a listing must be preformatted");
  assert.match(html, /command-out/, "and live in its own scrolling box");
  assert.ok(html.includes("  /agent      Select"), "the runs of spaces must survive");
  assert.doesNotMatch(html, /<p>/, "it must not be broken into paragraphs");
});

/**
 * One-line answers are sentences, and a sentence reads worse in a monospace
 * block than in prose. The split is on a newline because every aligned
 * listing has one and no one-line answer does.
 */
test("a one-line answer is still prose", () => {
  const html = loadCommandOutput()("Conversation too short to compact.");
  assert.doesNotMatch(html, /<pre>/);
  assert.match(html, /Conversation too short/);
});

/**
 * And the card has to actually use it.
 *
 * The two tests above drive `renderCommandOutput` directly, so they went on
 * passing with `addCommandCard` switched back to `renderMarkdown` — the exact
 * bug they exist to prevent, sitting one line away from what they measured.
 * Found by putting that bug back and watching nothing fail.
 */
test("the command card renders through the terminal-output path", () => {
  const card = sliceFrom(js, "function addCommandCard(label, text, ok)");
  assert.match(card, /body\.innerHTML = renderCommandOutput\(text\)/);
  assert.doesNotMatch(card, /renderMarkdown/, "not straight to markdown");
});

/** Terminal output scrolls in its own box, never the whole conversation. */
test("preformatted output scrolls inside its own box", () => {
  assert.match(css, /^\.command-out \{/m);
  const rule = sliceFrom(css, ".command-out {");
  assert.match(rule, /overflow-x:\s*auto/, "the box scrolls, not the sidebar");
});

/**
 * `/help` advertises commands this panel will not run, so someone will type
 * one. The panel used to be sent only the offerable list, so it did not
 * recognise `/quit` at all — which meant the message path took it and the word
 * "/quit" was sent to the model as a prompt nobody wrote, and charged for.
 */
test("a command the panel cannot run explains itself instead of becoming a prompt", () => {
  assert.match(
    provider,
    /offered: offered\.has\(command\.name\)/,
    "the whole list must go down, flagged"
  );
  assert.match(provider, /runnable: isRunnable\(command\)/);
  assert.match(provider, /reason: isRunnable\(command\) \? "" : reasonNotOffered/);

  const run = sliceFrom(js, "function runSlash(name, value)");
  assert.match(run, /command\.runnable === false/, "the webview must recognise it");
  assert.match(run, /addCommandCard\(/, "and answer with a card");
  const explain = run.indexOf("command.runnable === false");
  const post = run.indexOf('type: "runCommand"');
  assert.ok(explain > -1 && post > explain, "it must not reach the command endpoint");
});

/** But it is still kept out of the menu, which only offers what will run. */
test("the menu offers only the commands that run here", () => {
  const match = sliceFrom(js, "function matchSlash(query)");
  assert.match(match, /filter\(\(c\) => c\.offered\)/, "the menu filters to the offered ones");
});

/**
 * Kiro's `/help` is a 70-column table that needs sideways scrolling on every
 * line of a sidebar. The same information arrives structured in
 * `commands/available` — the menu's own source — so the panel lays it out to
 * fit rather than showing the dump, and names the commands it will not run
 * instead of leaving them silently missing.
 */
test("/help is answered from the command list, not the text dump", () => {
  const run = sliceFrom(js, "function runSlash(name, value)");
  assert.match(run, /name === "help" && !value/, "help is answered locally");
  assert.match(run, /addHelpCard\(\)/);

  const card = sliceFrom(js, "function addHelpCard()");
  assert.match(card, /c\.offered/, "it lists what can be run");
  assert.match(card, /c\.runnable === false/, "and what cannot, with the reason");
  assert.match(card, /acceptSlash\(command\)/, "a row behaves as the menu row does");
});

/**
 * The unavailable rows are divs, so they take the shared layout without a
 * hover tint implying they do something. Only the button carries the hover,
 * with a bare `.help-row:hover` — `button:hover` is (0,1,1) and outranks any
 * single class.
 */
test("only the clickable help rows look clickable", () => {
  assert.match(css, /^\.help-line \{/m, "layout is shared");
  assert.match(css, /^\.help-row:hover \{/m, "the button cancels the global hover");
  assert.match(js, /"help-line help-row"/, "the runnable rows are buttons");
  assert.match(js, /"help-line help-blocked"/, "the rest are not");
});

/** Every reason is a real sentence, not a placeholder. */
test("every excluded command has a reason worth reading", () => {
  const { NOT_IN_PANEL, reasonNotOffered } = require("../out/slashCommands");
  for (const name of NOT_IN_PANEL) {
    const reason = reasonNotOffered(name);
    assert.ok(reason.length > 20, `${name} needs a real explanation`);
    assert.match(reason, /\.$/, `${name}'s reason should read as a sentence`);
  }
});

/**
 * One "Running…" card at a time.
 *
 * The provider's message handler is async and not serialised, so two commands
 * started in quick succession can both post `commandRunning` before either
 * answers. The first card then said "Running…" for the rest of the session:
 * its result arrived, found the pointer already moved to the second card, and
 * appended a third. The user saw one command twice, one of them spinning
 * forever. Found by replaying that exact order against the real page.
 */
test("overlapping commands leave no card spinning forever", () => {
  const source = sliceFrom(js, 'case "commandRunning"');
  assert.match(
    source,
    /if \(runningCommand\) runningCommand\.remove\(\)/,
    "a new running card must retire the previous one"
  );
});

/**
 * `submit()` refuses to send while a turn runs, but the menu answered Enter
 * itself and went straight to `runSlash` — so mid-turn, with Send disabled,
 * Enter on the menu fired a command that Kiro then refused. The panel was
 * offering something it knew would fail. `setBusy` disables Send and not the
 * textarea, so the box holds focus for most of a turn and this was easy to
 * reach by accident.
 */
test("no command is offered or sent while a turn is running", () => {
  const menu = sliceFrom(js, "function updateSlashMenu()");
  assert.match(menu, /if \(busy\) return closeSlashMenu\(\)/, "the menu must not open");

  const run = sliceFrom(js, "function runSlash(name, value)");
  assert.match(run, /if \(busy\) \{/, "and nothing may reach the endpoint");
  const guard = run.indexOf("if (busy) {");
  const post = run.indexOf('type: "runCommand"');
  assert.ok(guard > -1 && post > guard, "the guard comes first");
});

/**
 * A visible control that goes quiet when clicked looks broken. The menu can
 * simply not appear, but a `/help` card stays on screen across a turn and its
 * rows are real buttons, so that route says why instead.
 */
test("a help row clicked mid-turn explains itself", () => {
  const run = sliceFrom(js, "function runSlash(name, value)");
  const busy = run.slice(run.indexOf("if (busy) {"));
  assert.match(busy.slice(0, 400), /addCommandCard\(/, "it must answer, not go quiet");
  assert.match(busy.slice(0, 400), /still working/, "and say what is in the way");
});

/**
 * The arrows move a highlight while focus stays in the textarea, so without
 * `aria-activedescendant` a screen reader is told nothing at all.
 *
 * This is why the menu declares a role where the mode and model menus refuse
 * to: their reasoning is that a container role promises arrow navigation they
 * do not implement, over a mixture of controls no single role admits. Both are
 * the other way round here.
 */
test("the slash menu reports its state where the focus actually is", () => {
  assert.match(provider, /id="slash-menu"[^>]*role="listbox"/, "the list says what it is");
  const input = provider.slice(provider.indexOf('id="input"'));
  const tag = input.slice(0, input.indexOf(">"));
  assert.match(tag, /aria-controls="slash-menu"/, "the box owns the menu");
  assert.match(tag, /aria-autocomplete="list"/);

  /*
   * And no `aria-expanded`, on the element or from script.
   *
   * The textbox role does not support that state — making it valid needs
   * `role="combobox"` on this element, which would have the message composer
   * announce as a picker, and lose "multi-line", for the whole session in
   * exchange for the moment a menu is open. `aria-activedescendant` is legal
   * on a textbox and carries the part that matters: which row is current, and
   * by going away, that the list has closed.
   */
  assert.doesNotMatch(tag, /aria-expanded/, "not a state a textbox supports");
  assert.doesNotMatch(tag, /role="combobox"/, "and the box stays a text box");
  assert.doesNotMatch(
    sliceFrom(js, "function renderSlashMenu()"),
    /aria-expanded/,
    "nor may script add it"
  );

  const render = sliceFrom(js, "function renderSlashMenu()");
  assert.match(render, /role", "option"/, "each row is an option");
  assert.match(render, /aria-selected/, "and says whether it is the one selected");
  assert.match(render, /aria-activedescendant/, "the box points at the highlighted row");

  // Left set, it would go on naming a row that no longer exists.
  const close = sliceFrom(js, "function closeSlashMenu()");
  assert.match(close, /removeAttribute\("aria-activedescendant"\)/);
});

/**
 * The page is one TypeScript template literal, so a backtick anywhere in it —
 * including inside an HTML comment — ends the string. One in a comment about
 * `aria-activedescendant` broke the build.
 */
test("the page markup contains no backticks", () => {
  const start = provider.indexOf("<!DOCTYPE html>");
  const end = provider.indexOf("</html>`", start);
  assert.ok(start > -1 && end > start, "the template should be findable");
  const markup = provider.slice(start, end);
  assert.ok(!markup.includes("`"), "a backtick here ends the template literal");
});

/*
 * The composer's parser and matcher, driven directly.
 *
 * These rules used to be tested against `parseSlashInput` and `matchCommands`
 * in `src/slashCommands.ts` — which nothing called. The code that actually
 * runs is `parseSlash` and `matchSlash` in chat.js, so the tests could have
 * gone on passing with the shipped behaviour broken; and once the composer had
 * to recognise `/quit` in order to explain it, the two deliberately disagreed.
 * The src copies are gone and the rules are asserted where they run, against
 * the same fixture Kiro really sent.
 */
const { isRunnable, offerable, parseAvailableCommands } = require("../out/slashCommands");

/** The list exactly as the provider posts it: whole, with the two flags. */
function webviewCommands() {
  const payload = JSON.parse(
    fs.readFileSync(path.join(root, "test", "fixtures", "kiro-commands.json"), "utf8")
  );
  const parsed = parseAvailableCommands(payload);
  const offered = new Set(offerable(parsed).map((c) => c.name));
  return parsed.map((c) => ({
    ...c,
    offered: offered.has(c.name),
    runnable: isRunnable(c),
    reason: isRunnable(c) ? "" : "because.",
  }));
}

function loadFromChatJs(name, marker, commands) {
  const source = sliceFrom(js, marker);
  assert.ok(source, `${marker} should be findable`);
  return new Function("slashCommands", `${source}\nreturn ${name};`)(commands);
}

const parseSlash = (commands) => loadFromChatJs("parseSlash", "function parseSlash(text)", commands);
const matchSlash = (commands) => loadFromChatJs("matchSlash", "function matchSlash(query)", commands);

/**
 * The load-bearing half of the parser.
 *
 * A leading slash is only a command when the name is one Kiro actually has.
 * Without the known-list check, an ordinary sentence that happens to open with
 * a path would be swallowed by the composer instead of sent — the user's words
 * eaten because of one character.
 */
test("only a name Kiro has is treated as a command", () => {
  const parse = parseSlash(webviewCommands());
  assert.equal(parse("/compact").name, "compact");
  assert.equal(parse("/usr/bin/env is on my PATH"), null);
  assert.equal(parse("/nonsense"), null);
  assert.equal(parse("what does /compact do?"), null);
  assert.equal(parse(""), null);
});

/**
 * `/quit` *is* recognised, and this is the difference from the old src copy:
 * the composer has to know the name to answer "that closes the Kiro CLI".
 * Failing to recognise it is what sent the word to the model as a prompt.
 */
test("a command the panel cannot run is still recognised, so it can be explained", () => {
  const parse = parseSlash(webviewCommands());
  const quit = parse("/quit");
  assert.ok(quit, "it must not fall through to the message path");
  assert.equal(quit.name, "quit");
  assert.equal(quit.command.runnable, false, "and be known to be unrunnable");
});

test("whatever follows the name is the argument", () => {
  const parse = parseSlash(webviewCommands());
  assert.equal(parse("/model claude-haiku-4.5").value, "claude-haiku-4.5");
  assert.equal(parse("  /context add src/  ").value, "add src/");
  assert.equal(parse("/COMPACT").name, "compact", "the name is matched case-insensitively");
});

/**
 * Typing "e" then pressing Enter runs whatever is at the top, so the top has to
 * be the one whose name starts that way.
 */
test("a prefix hit outranks one buried in the middle of a name", () => {
  const match = matchSlash(webviewCommands());
  const hits = match("e").map((c) => c.name);
  assert.equal(hits[0], "effort", "the only name starting with e");
  assert.ok(hits.indexOf("effort") < hits.indexOf("model"), "model merely contains it");
});

test("a name hit outranks a description hit", () => {
  const match = matchSlash(webviewCommands());
  const hits = match("com").map((c) => c.name);
  assert.equal(hits[0], "compact");
  assert.ok(hits.includes("help"), "help's description mentions commands");
  assert.ok(hits.indexOf("compact") < hits.indexOf("help"));
});

/** The menu never offers what it cannot run, however it is spelled. */
test("the matcher never offers an unrunnable or hidden command", () => {
  const match = matchSlash(webviewCommands());
  for (const query of ["", "q", "quit", "chat", "stats", "voice"]) {
    for (const hit of match(query)) {
      assert.ok(hit.offered, `${hit.name} was offered for "${query}"`);
    }
  }
  assert.deepEqual(match("quit"), [], "nothing matches a command that cannot run");
});

/**
 * Every message the provider posts has somewhere to land.
 *
 * This is the guard that would have found `thought` without a probe. The
 * existing version of it covered only the slash-command messages, so a
 * `type: "thought"` posted since the panel was written went into the webview's
 * switch and vanished — silently, which is the whole problem with a missing
 * case. Nobody noticed because kiro-cli 2.20.2 never sends one.
 *
 * Both directions, because both have been broken this way.
 */
test("no message is posted into a switch that cannot answer it", () => {
  const posted = new Set([...provider.matchAll(/type: "([a-zA-Z]+)"/g)].map((m) => m[1]));
  const handled = new Set([...js.matchAll(/case "([a-zA-Z]+)":/g)].map((m) => m[1]));
  const orphans = [...posted].filter((t) => !handled.has(t)).sort();
  assert.deepEqual(orphans, [], `the provider posts these and the webview drops them: ${orphans}`);

  const sent = new Set([...js.matchAll(/type: "([a-zA-Z]+)"/g)].map((m) => m[1]));
  const answered = new Set([...provider.matchAll(/case "([a-zA-Z]+)":/g)].map((m) => m[1]));
  const unanswered = [...sent].filter((t) => !answered.has(t)).sort();
  assert.deepEqual(unanswered, [], `the webview sends these and the provider drops them: ${unanswered}`);
});

/**
 * Kiro reasoning out loud goes in the steps list, which already opens while
 * the turn runs and folds when it ends. A second collapsible block beside the
 * answer would be a second thing to keep in step.
 */
test("a thought is shown, kept and restored", () => {
  assert.match(js, /case "thought":/, "the webview must have a case for it");
  assert.match(js, /function appendThought\(text\)/);

  const append = sliceFrom(js, "function appendThought(text)");
  assert.match(append, /bubble\.tools\.prepend/, "before the tool rows: reason, then act");
  assert.match(append, /textContent \+=/, "chunks accumulate rather than replace");
  assert.doesNotMatch(append, /innerHTML|renderMarkdown/, "the model's working is not markdown");

  // A turn that only reasoned still has something to unfold, live and stored.
  const stop = sliceFrom(js, "function stopThinking(bubble)");
  assert.match(stop, /if \(!target\.thought\) \{/, "a thought keeps the header alive");
  const restore = sliceFrom(js, "function restoreHistory(saved)");
  assert.match(restore, /item\.thought/, "and it is rebuilt when a chat is reopened");
  assert.match(js, /thought: thought \|\| ""/, "which means it has to be stored");

  assert.match(css, /^\.thought \{/m, "it needs a style of its own");
});
