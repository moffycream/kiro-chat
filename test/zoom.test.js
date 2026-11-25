// The chat panel's own text zoom.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { clampZoom, stepZoom, ZOOM_MIN, ZOOM_MAX } = require("../out/zoom");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const pkg = JSON.parse(read("package.json"));

test("a stored zoom level is clamped and anything unreadable is 100%", () => {
  assert.equal(clampZoom(1.3), 1.3);
  assert.equal(clampZoom(9), ZOOM_MAX);
  assert.equal(clampZoom(0.1), ZOOM_MIN);
  for (const nothing of [undefined, null, "1.5", NaN, Infinity]) {
    assert.equal(clampZoom(nothing), 1, String(nothing));
  }
});

test("steps are a tenth, rounded, and stop at the ends", () => {
  let level = 1;
  for (let i = 0; i < 3; i++) level = stepZoom(level, "in");
  // Three float additions of 0.1 are 1.3000000000000003 unrounded.
  assert.equal(level, 1.3);
  assert.equal(stepZoom(ZOOM_MAX, "in"), ZOOM_MAX);
  assert.equal(stepZoom(ZOOM_MIN, "out"), ZOOM_MIN);
  assert.equal(stepZoom(1.7, "reset"), 1);
  assert.equal(stepZoom(undefined, "out"), 0.9);
});

test("the setting's declared range matches the module's", () => {
  const setting = pkg.contributes.configuration.properties["kiroChat.zoom"];
  assert.equal(setting.type, "number");
  assert.equal(setting.default, 1);
  assert.equal(setting.minimum, ZOOM_MIN);
  assert.equal(setting.maximum, ZOOM_MAX);
});

test("zoom keys only act while the chat panel has focus", () => {
  // Unscoped, Ctrl+= / Ctrl+- would stop zooming the VS Code window anywhere.
  const zoomKeys = pkg.contributes.keybindings.filter((k) => /^kiroChat\.(zoomIn|zoomOut|resetZoom)$/.test(k.command));
  assert.ok(zoomKeys.length >= 3);
  for (const k of zoomKeys) assert.equal(k.when, "focusedView == kiroChat.view", k.key);
  const viewIds = pkg.contributes.views
    ? Object.values(pkg.contributes.views).flat().map((v) => v.id)
    : [];
  assert.ok(viewIds.includes("kiroChat.view"), "the when-clause names a real view");
});

test("every zoom command is contributed and registered", () => {
  const extension = read("src/extension.ts");
  for (const id of ["kiroChat.zoomIn", "kiroChat.zoomOut", "kiroChat.resetZoom"]) {
    assert.ok(pkg.contributes.commands.some((c) => c.command === id), id);
    assert.ok(extension.includes(`registerCommand("${id}"`), id);
  }
});

test("both halves of the zoom contract exist", () => {
  const chat = read("media/chat.js");
  const provider = read("src/chatViewProvider.ts");
  // extension → webview: the level rides on `settings` and is applied there.
  assert.match(provider, /zoom: clampZoom\(config\.get<number>\("zoom"\)\)/);
  const settingsCase = chat.slice(chat.indexOf('case "settings":'));
  assert.match(settingsCase.slice(0, settingsCase.indexOf("\n      case ")), /applyZoom\(message\.zoom\)/);
  // webview → extension: Ctrl+wheel posts `zoom`, and the provider handles it.
  assert.match(chat, /type: "zoom", direction:/);
  assert.match(provider, /case "zoom": \{/);
  // And the factor actually reaches the base font size every em hangs off.
  assert.match(read("media/chat.css"), /font-size: calc\(var\(--vscode-font-size\) \* var\(--chat-zoom, 1\)\)/);
});

test("away from 100% the status row shows the level, and clicking it resets", () => {
  const chat = read("media/chat.js");
  const provider = read("src/chatViewProvider.ts");
  assert.match(provider, /<button type="button" id="zoom-reset" class="zoom-reset" hidden><\/button>/);
  const apply = chat.slice(chat.indexOf("function applyZoom"), chat.indexOf("function saveState"));
  assert.match(apply, /chip\.hidden = percent === 100;/);
  assert.match(apply, /chip\.textContent = `\$\{percent\}%`;/);
  assert.match(apply, /addEventListener\("click", \(\) => \{\s*vscode\.postMessage\(\{ type: "zoom", direction: "reset" \}\);/);
});
