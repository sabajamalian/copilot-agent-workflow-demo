import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { resolveAgents } from "../plugins/agent-workflow-demo/extensions/agent-workflow/controller.mjs";

const { values } = parseArgs({ options: {
  sdk: { type: "string" }, cli: { type: "string", default: "copilot" },
  run: { type: "boolean", default: false }, keep: { type: "boolean", default: false },
} });
if (!values.sdk) throw new Error("Usage: node scripts/smoke.mjs --sdk <installed-copilot-sdk-directory> [--cli <executable>] [--run] [--keep]");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = await realpath(await mkdtemp(join(tmpdir(), "agent-workflow-smoke-")));
const home = join(fixture, "home"), target = join(fixture, "project");
await mkdir(home); await mkdir(target);
await cp(join(root, "examples"), join(target, "examples"), { recursive: true });
execFileSync("git", ["init", "--quiet", target]);
const env = { ...process.env, COPILOT_HOME: home };
execFileSync(values.cli, ["plugin", "marketplace", "add", root], { env, stdio: "pipe" });
execFileSync(values.cli, ["plugin", "install", "agent-workflow-demo@agent-workflow-demos"], { env, stdio: "pipe" });
const { CopilotClient } = await import(pathToFileURL(join(resolve(values.sdk), "index.js")).href);
const client = new CopilotClient({
  connection: { kind: "stdio", path: values.cli },
  baseDirectory: home, workingDirectory: target, logLevel: "error",
});
const within = path => {
  if (typeof path !== "string") return false;
  const rel = relative(target, resolve(target, path));
  return rel === "" || (!isAbsolute(rel) && !rel.startsWith(`..${sep}`) && rel !== "..");
};
let session, success = false;
try {
  session = await client.createSession({
    workingDirectory: target, enableConfigDiscovery: true, requestExtensions: true,
    skipCustomInstructions: true,
    onPermissionRequest: request => {
      let allow = false;
      if (!request.managedApprovalRequired && !request.requestSandboxBypass) {
        if (request.kind === "extension-permission-access") {
          allow = request.extensionName === "plugin:agent-workflow-demo:agent-workflow" &&
            request.capabilities?.every(capability => capability === "register hooks");
        }
        if (values.run && request.kind === "custom-tool") {
          allow = ["workflow_status", "workflow_complete"].includes(request.toolName);
        }
        if (values.run && request.kind === "read") allow = within(request.path);
        if (values.run && request.kind === "write") {
          allow = ["examples/slug.mjs", "examples/slug.test.mjs"].some(path =>
            resolve(target, request.fileName) === join(target, path));
        }
        if (values.run && request.kind === "shell") {
          const testCommand = "node --test examples/slug.test.mjs";
          const allowed = [testCommand, ...[target, `"${target}"`, `'${target}'`]
            .map(path => `cd ${path} && ${testCommand}`)];
          allow = allowed.includes(request.fullCommandText.trim()) &&
            !request.hasWriteFileRedirection && !request.possibleUrls?.length;
        }
      }
      if (!allow) console.error(`Smoke denied permission: ${request.kind}`);
      return allow ? { kind: "approve-once" } : { kind: "reject", feedback: "Outside this smoke test's exact allowlist." };
    },
  });
  session.on(event => {
    if (event.type === "session.info" && event.data.message?.startsWith("Workflow")) console.log(event.data.message);
    if (event.type === "subagent.selected") console.log(`Selected: ${event.data.agentName}`);
    if (event.type === "session.error") console.error(`Runtime error: ${event.data.message}`);
  });
  await session.rpc.extensions.reload();
  const extensions = (await session.rpc.extensions.list()).extensions;
  assert.equal(extensions.find(item => item.id === "plugin:agent-workflow-demo:agent-workflow")?.status, "running");
  const ids = resolveAgents(await session.rpc.agent.list());
  for (const id of ids) {
    await session.rpc.agent.select({ name: id });
    assert.equal((await session.rpc.agent.getCurrent()).agent?.id, id);
  }
  await session.rpc.agent.select({ name: ids[0] });
  console.log("PASS: marketplace install, extension startup, four agent IDs, SDK selection. No inference yet.");
  if (values.run) {
    const prompt = "WORKFLOW START: In examples/slug.mjs, make slug replace each run of non-ASCII-letter-or-digit characters with one hyphen and trim boundary hyphens. Punctuation-only input should return an empty string. Preserve TypeError for non-string input. Add focused cases in examples/slug.test.mjs. The only validation command is exactly: node --test examples/slug.test.mjs . Do not change any other file. Each stage must call workflow_complete and finish normally.";
    await session.send({ prompt });
    const statePath = join(session.workspacePath, "files/agent-workflow-demo/state.json");
    const deadline = Date.now() + 180000;
    let state;
    while (Date.now() < deadline) {
      try { state = JSON.parse(await readFile(statePath, "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (state?.phase === "completed") break;
      if (state?.phase === "paused") throw new Error(`Live workflow paused: ${state.reason}`);
      await sleep(200);
    }
    assert.equal(state?.phase, "completed", "Live chain did not complete within the smoke deadline");
    assert.equal(state.transitions, 3);
    const { slug } = await import(pathToFileURL(join(target, "examples/slug.mjs")).href);
    assert.equal(slug(" Hello, Pipeline! "), "hello-pipeline");
    assert.equal(slug("!!!"), "");
    assert.equal(slug("A___B"), "a-b");
    assert.throws(() => slug(null), TypeError);
    execFileSync(process.execPath, ["--test", "examples/slug.test.mjs"], { cwd: target, stdio: "pipe" });
    console.log("PASS: live four-stage chain, three automatic transitions, independent behavior assertions and tests.");
  }
  success = true;
} finally {
  if (session) {
    if (!success) await session.abort().catch(error => console.error(`Abort failed: ${error.message}`));
    await session.disconnect();
  }
  await client.stop();
  if (success && !values.keep) await rm(fixture, { recursive: true, force: true });
  else console.error(`Smoke fixture retained for diagnosis: ${fixture}`);
}
