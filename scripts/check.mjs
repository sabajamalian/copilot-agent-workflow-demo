import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STAGES } from "../plugins/agent-workflow-demo/extensions/agent-workflow/controller.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const json = async path => JSON.parse(await readFile(join(root, path), "utf8"));
const packageInfo = await json("package.json");
const plugin = await json("plugins/agent-workflow-demo/plugin.json");
const marketplace = await json(".github/plugin/marketplace.json");
assert.equal(plugin.name, "agent-workflow-demo");
assert.equal(plugin.version, packageInfo.version);
assert.equal(marketplace.plugins[0].version, plugin.version);
assert.equal(marketplace.plugins[0].source, "./plugins/agent-workflow-demo");
assert.deepEqual(plugin.extensions, ["extensions"]);
assert.equal(plugin.agents, "agents");
assert.equal(plugin.$schema, undefined, "This is deliberately a legacy manifest.");
for (const stage of STAGES) {
  const source = await readFile(join(root, `plugins/agent-workflow-demo/agents/${stage}.agent.md`), "utf8");
  assert.ok(source.startsWith(`---\nname: ${stage}\n`));
  assert.match(source, /disable-model-invocation: true/);
  assert.match(source, /tools: \[.*"workflow_complete"/);
  assert.doesNotMatch(source, /^handoffs:/m);
  const toolLine = source.split("\n").find(line => line.startsWith("tools:"));
  const tools = JSON.parse(toolLine.slice(6));
  assert.ok(!tools.includes("*") && !tools.includes("agent"));
  if (stage === "workflow-plan" || stage === "workflow-review") assert.ok(!tools.includes("execute"));
  if (stage !== "workflow-implement") assert.ok(!tools.includes("edit"));
}
async function syntax(directory) {
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await syntax(path);
    else if (path.endsWith(".mjs")) execFileSync(process.execPath, ["--check", join(root, path)], { stdio: "pipe" });
  }
}
for (const directory of ["plugins", "scripts", "test", "examples"]) await syntax(directory);
console.log("PASS: version alignment, marketplace paths, agent restrictions, legacy extension layout, JavaScript syntax.");
