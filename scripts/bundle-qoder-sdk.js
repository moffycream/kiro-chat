// Bundles Qoder's Agent SDK into one ES module the extension loads with
// import(). It is an ES module that reads import.meta.url, so it cannot go
// through tsc's CommonJS output, and the .vsix ships no node_modules. The SDK
// is a dev dependency for that reason: only this bundle reaches users.
// Its install script downloads a Qoder CLI the panel never uses (the user's
// own qodercli is always passed in), so installs set QODER_SKIP_DOWNLOAD=1.
const path = require("node:path");
const fs = require("node:fs");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const sdkDir = path.join(root, "node_modules", "@qoder-ai", "qoder-agent-sdk");
const outDir = path.join(root, "out", "vendor");
fs.mkdirSync(outDir, { recursive: true });

esbuild.buildSync({
  entryPoints: [path.join(sdkDir, "dist", "index.js")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  minify: true,
  legalComments: "eof",
  outfile: path.join(outDir, "qoder-agent-sdk.mjs"),
  logLevel: "warning",
});
// The SDK is not open source; its terms travel with the copy.
fs.copyFileSync(path.join(sdkDir, "LICENSE"), path.join(outDir, "qoder-agent-sdk.LICENSE"));
