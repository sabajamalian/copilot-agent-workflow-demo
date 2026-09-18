import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdapter } from "../plugins/agent-workflow-demo/extensions/agent-workflow/adapter.mjs";
import { STAGES } from "../plugins/agent-workflow-demo/extensions/agent-workflow/controller.mjs";

async function setup(t) {
  const workspacePath = await mkdtemp(join(tmpdir(), "workflow-adapter-"));
  const events = new EventEmitter(), logs = [];
  const agents = STAGES.map(name => ({ name, id: name, tools: ["workflow_complete"] }));
  const adapter = createAdapter();
  const session = {
    sessionId: "adapter-session", workspacePath,
    log: async message => { logs.push(message); },
    send: async () => {},
    on: (name, fn) => events.on(name, fn),
    rpc: { agent: {
      list: async () => ({ agents }), getCurrent: async () => ({ agent: agents[0] }),
      select: async () => {},
    } },
  };
  t.after(async () => { await adapter.close(); await rm(workspacePath, { recursive: true, force: true }); });
  const invocation = { sessionId: session.sessionId };
  return { adapter, session, logs, invocation, events };
}

test("adapter fails closed when SDK capabilities are missing", async t => {
  const f = await setup(t);
  delete f.session.rpc.agent.select;
  await f.adapter.attach(f.session);
  const result = await f.adapter.config.tools[0].handler({}, f.invocation);
  assert.equal(result.resultType, "failure");
  assert.match(result.textResultForLlm, /Missing SDK agent.select/);
});

test("read-only status checks runtime agent list without starting a run", async t => {
  const f = await setup(t); await f.adapter.attach(f.session);
  const result = JSON.parse(await f.adapter.config.tools[0].handler({}, f.invocation));
  assert.equal(result.phase, "ready");
  assert.deepEqual(result.discoveredAgents, STAGES);
  assert.equal(f.adapter.config.onPermissionRequest, undefined);
});

test("normal stop hook returns void and never blocks or sends a follow-up itself", async t => {
  const f = await setup(t); await f.adapter.attach(f.session);
  const hook = f.adapter.config.hooks;
  await hook.onUserPromptSubmitted({ prompt: "WORKFLOW START: a task" }, f.invocation);
  const state = JSON.parse(await f.adapter.config.tools[0].handler({}, f.invocation));
  await f.adapter.config.tools[1].handler({
    runId: state.runId, stage: state.stage, token: state.token, outcome: "completed", evidence: "Plan is in conversation.",
  }, f.invocation);
  assert.equal(await hook.onAgentStop({ stopReason: "end_turn" }, f.invocation), undefined);
  await hook.onSessionEnd({ reason: "complete" }, f.invocation);
  const after = JSON.parse(await f.adapter.config.tools[0].handler({}, f.invocation));
  assert.equal(after.phase, "running");
  assert.equal(after.normalStopObserved, true);
  await hook.onSessionEnd({ reason: "abort" }, f.invocation);
  assert.equal(JSON.parse(await f.adapter.config.tools[0].handler({}, f.invocation)).phase, "paused");
});

test("publishing guard denies obvious publish commands without granting any permissions", async t => {
  const f = await setup(t); await f.adapter.attach(f.session);
  await f.adapter.config.hooks.onUserPromptSubmitted({ prompt: "WORKFLOW START: a task" }, f.invocation);
  const result = await f.adapter.config.hooks.onPreToolUse({
    toolName: "bash", toolArgs: { command: "git push origin main" },
  }, f.invocation);
  assert.equal(result.permissionDecision, "deny");
});

test("adapter preserves corrupt on-disk state for diagnosis", async t => {
  const f = await setup(t);
  const directory = join(f.session.workspacePath, "files/agent-workflow-demo");
  await mkdir(directory, { recursive: true });
  const file = join(directory, "state.json");
  await writeFile(file, "{broken");
  await f.adapter.attach(f.session);
  const result = await f.adapter.config.tools[0].handler({}, f.invocation);
  assert.equal(result.resultType, "failure");
  assert.equal(await readFile(file, "utf8"), "{broken");
});

test("denied or rejected tools pause even when failure hooks do not fire", async t => {
  const f = await setup(t); await f.adapter.attach(f.session);
  await f.adapter.config.hooks.onUserPromptSubmitted({ prompt: "WORKFLOW START: a task" }, f.invocation);
  f.events.emit("tool.execution_complete", { data: { success: false, error: { code: "rejected" } } });
  await new Promise(resolve => setImmediate(resolve));
  // Status may arrive before asynchronous persistence completes, but the phase is already paused.
  const result = JSON.parse(await f.adapter.config.tools[0].handler({}, f.invocation));
  assert.equal(result.phase, "paused");
  assert.equal(result.reason, "tool-unsuccessful");
});
