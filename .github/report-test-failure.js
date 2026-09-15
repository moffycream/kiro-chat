// A run's log needs a GitHub sign-in to read; its annotations do not. When the
// tests fail, this lifts the failing part of the output into one annotation so
// the reason is on the run's summary page for anyone who can see the repo.
const fs = require("node:fs");

const lines = fs.readFileSync("test-output.txt", "utf8").split(/\r?\n/);
const wanted = new Set();
lines.forEach((line, index) => {
  if (/not ok|error|Error|✖|fail \d|failing/.test(line)) {
    for (let i = Math.max(0, index - 2); i <= Math.min(lines.length - 1, index + 12); i++) wanted.add(i);
  }
});
let picked = [...wanted].sort((a, b) => a - b).map((i) => lines[i]);
if (picked.length === 0) picked = lines.slice(-60);

const text = picked.join("\n").slice(0, 60000);
const escaped = text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
console.log(`::error title=npm test failed::${escaped}`);
