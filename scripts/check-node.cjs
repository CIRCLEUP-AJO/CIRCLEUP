#!/usr/bin/env node
const { execFileSync } = require("node:child_process");

const nodeVersion = process.versions.node;
const [nodeMajor, nodeMinor] = nodeVersion.split(".").map(Number);
const nodeSupported =
  (nodeMajor === 18 && nodeMinor >= 18) ||
  [22, 24].includes(nodeMajor);

let npmVersion = "unavailable";
try {
  npmVersion = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
} catch {
  // The actionable version message below covers a missing npm executable.
}
const npmMajor = Number(npmVersion.split(".")[0]);
const expectedNpmMajor = nodeMajor === 18 ? 9 : nodeMajor === 22 ? 10 : nodeMajor === 24 ? 11 : undefined;
const npmSupported = npmMajor === expectedNpmMajor;

if (!nodeSupported || !npmSupported) {
  console.error(
    `Unsupported toolchain: Node.js ${nodeVersion}, npm ${npmVersion}. ` +
    "Supported tuples: Node.js 18.18+ with npm 9.x, Node.js 22.x with npm 10.x, or Node.js 24.x with npm 11.x. Install a supported Node.js/npm pair.",
  );
  process.exit(1);
}

console.log(`Supported Node.js ${nodeVersion} and npm ${npmVersion}.`);