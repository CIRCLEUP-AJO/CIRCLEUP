// Review the OpenAPI document and fixtures before acknowledging source changes.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const root = path.resolve(__dirname, "..");
const target = path.join(root, "docs/api/v1/openapi.json");
const doc = JSON.parse(fs.readFileSync(target, "utf8"));
for (const file of Object.keys(doc["x-source-sha256"])) {
  const source = fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
  doc["x-source-sha256"][file] = createHash("sha256").update(source).digest("hex");
}
fs.writeFileSync(target, JSON.stringify(doc, null, 2) + "\n");
