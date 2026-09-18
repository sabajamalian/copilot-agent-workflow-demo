import test from "node:test";
import assert from "node:assert/strict";
import { WorkflowController, STAGES, MAX_RUN_MS, resolveAgents } from "../plugins/agent-workflow-demo/extensions/agent-workflow/controller.mjs";

function fixture({ saved = null, time = 1000 } = {}) {
  const sends = [], logs = [], scheduled = [], writes = [];
  const agents = STAGES.map(name => ({ name, id: `plugin:${name}`, tools: ["workflow_complete"] }));
  let current = agents[0], serial = 0;
  const store = {
    load: async () => saved,
    save: async state => { writes.push(structuredClone(state)); },
  };
  const runtime = {
    list: async () => ({ agents }),
    current: async () => ({ agent: current }),
    select: async id => { current = agents.find(agent => agent.id === id); await workflow.selected(id); },
    send: async prompt => { sends.push(prompt); await workflow.prompt(prompt); },
    log: async (...message) => { logs.push(message); },
  };
  const workflow = new WorkflowController({
    sessionId: "session-one", runtime, store,
    now: () => time, uuid: () => `token-${++serial}`, schedule: fn => scheduled.push(fn),
  });
  return {
    workflow, runtime, store, agents, sends, logs, scheduled, writes,
    setCurrent: value => { current = value; },
    tick: milliseconds => { time += milliseconds; },
    async drain() {
      for (const next of scheduled.splice(0)) next();
      await workflow.queue;
      await new Promise(resolve => setImmediate(resolve));
      await workflow.queue;
    },
    async start() { await workflow.init(); await workflow.prompt("WORKFLOW START: inspect this small task"); },
    args(overrides = {}) {
      return { runId: workflow.state.runId, stage: STAGES[workflow.state.index],
        token: workflow.state.token, outcome: "completed", evidence: "Checked the required behavior.",
        ...overrides };
    },
    async complete(overrides = {}) {
      return workflow.complete(this.args(overrides), { sessionId: "session-one" });
    },
    async finish(id = `idle-${workflow.state.index}`) {
      await this.complete();
      await workflow.stopped({ stopReason: "end_turn", stopHookActive: false });
      await workflow.idle({ id, data: {} });
      await this.drain();
    },
  };
}

test("finite success path selects the returned plugin ID and sends exactly three follow-ups", async () => {
  const f = fixture(); await f.start();
  for (let index = 0; index < STAGES.length; index++) {
    assert.equal(f.workflow.status().stage, STAGES[index]);
    await f.finish();
  }
  assert.equal(f.workflow.state.phase, "completed");
  assert.equal(f.workflow.state.transitions, 3);
  assert.equal(f.sends.length, 3);
  assert.ok(f.writes.some(state => state.phase === "dispatching"));
  assert.ok(f.logs.at(-1)[0].startsWith("Workflow completed:"));
});

test("does not start from ordinary conversation, an arbitrary response, or idle", async () => {
  const f = fixture(); await f.workflow.init();
  await f.workflow.prompt("Please implement a thing.");
  await f.workflow.stopped({ stopReason: "end_turn" });
  await f.workflow.idle({ id: "1", data: {} }); await f.drain();
  assert.equal(f.workflow.state.phase, "ready");
  assert.equal(f.sends.length, 0);
});

test("refuses non-target agents, missing agents, and duplicate installations", async () => {
  const f = fixture(); f.setCurrent(null);
  await assert.rejects(f.start(), /Select workflow-plan/);
  assert.throws(() => resolveAgents({ agents: [] }), /exactly one/);
  assert.throws(() => resolveAgents({ agents: [...f.agents, f.agents[0]] }), /found 2/);
  f.agents[1].tools = ["read"];
  assert.throws(() => resolveAgents({ agents: f.agents }), /does not declare/);
});

test("requires exact active session/run/stage/token and nonempty evidence", async () => {
  const f = fixture(); await f.start();
  for (const override of [{ runId: "old" }, { stage: "workflow-test" }, { token: "old" }, { evidence: "" }]) {
    await assert.rejects(f.complete(override));
  }
  await assert.rejects(f.workflow.complete(f.args(), { sessionId: "other" }));
  assert.equal(f.workflow.receipt, false);
  await f.complete();
  await f.complete();
  assert.equal(f.workflow.receipt, true);
});

test("idle and natural stop without an explicit receipt pause", async () => {
  for (const operation of ["stop", "idle"]) {
    const f = fixture(); await f.start();
    if (operation === "stop") await f.workflow.stopped({ stopReason: "end_turn" });
    else await f.workflow.idle({ id: operation, data: {} });
    await f.drain();
    assert.equal(f.workflow.state.phase, "paused");
    assert.equal(f.sends.length, 0);
  }
});

test("completion plus idle without a natural stop cannot advance", async () => {
  const f = fixture(); await f.start(); await f.complete();
  await f.workflow.idle({ id: "1", data: {} }); await f.drain();
  assert.equal(f.workflow.state.phase, "paused");
  assert.equal(f.sends.length, 0);
});

test("duplicate idle events and duplicate stop hooks dispatch only once", async () => {
  const f = fixture(); await f.start(); await f.complete();
  await f.workflow.stopped({ stopReason: "end_turn" });
  await f.workflow.stopped({ stopReason: "end_turn" });
  await Promise.all([1, 1, 2].map(id => f.workflow.idle({ id: String(id), data: {} })));
  await f.drain();
  assert.equal(f.sends.length, 1);
  assert.equal(f.workflow.state.index, 1);
  await f.workflow.idle({ id: "1", data: {} }); await f.drain();
  assert.equal(f.sends.length, 1);
});

test("abort, error, and manual switch between stop and deferred dispatch cancel transition", async () => {
  for (const reason of ["aborted", "runtime-error", "manual-agent-change"]) {
    const f = fixture(); await f.start(); await f.complete();
    await f.workflow.stopped({ stopReason: "end_turn" });
    await f.workflow.idle({ id: "1", data: {} });
    await f.workflow.interrupt(reason); await f.drain();
    assert.equal(f.workflow.state.reason, reason);
    assert.equal(f.sends.length, 0);
  }
});

test("aborted idle and subagent idle never advance", async () => {
  const f = fixture(); await f.start(); await f.complete();
  await f.workflow.stopped({ stopReason: "end_turn" });
  await f.workflow.idle({ id: "sub", agentId: "child", data: {} });
  assert.equal(f.workflow.state.phase, "running");
  await f.workflow.idle({ id: "abort", data: { aborted: true } }); await f.drain();
  assert.equal(f.workflow.state.reason, "aborted");
  assert.equal(f.sends.length, 0);
});

test("manual switch away and back pauses; getCurrent is also checked", async () => {
  const f = fixture(); await f.start();
  await f.workflow.selected("unrelated");
  await f.workflow.selected(f.agents[0].id);
  assert.equal(f.workflow.state.phase, "paused");
  const g = fixture(); await g.start(); g.setCurrent(g.agents[1]);
  await assert.rejects(g.complete(), /Selected agent changed/);
});

test("user conversation, forged continuation and pause text invalidate active completion", async () => {
  for (const text of ["What time is it?", "WORKFLOW CONTINUE old", "WORKFLOW PAUSE", "WORKFLOW STATUS"]) {
    const f = fixture(); await f.start(); await f.complete();
    await f.workflow.prompt(text);
    assert.equal(f.workflow.state.phase, "paused");
    assert.equal(f.workflow.receipt, false);
  }
});

test("unknown stop reasons and recursive stop hooks pause rather than loop", async () => {
  for (const input of [{}, { stopReason: "error" }, { stopReason: "end_turn", stopHookActive: true },
    { stopReason: "end_turn", stop_hook_active: true }]) {
    const f = fixture(); await f.start(); await f.complete();
    await f.workflow.stopped(input);
    await f.workflow.idle({ id: "1", data: {} }); await f.drain();
    assert.equal(f.workflow.state.phase, "paused");
    assert.equal(f.sends.length, 0);
  }
});

test("blocked result stops the pipeline", async () => {
  const f = fixture(); await f.start(); await f.complete({ outcome: "blocked" });
  assert.equal(f.workflow.state.reason, "stage-blocked");
});

test("reload always pauses running or dispatching state and rotates token", async () => {
  const original = fixture(); await original.start();
  for (const phase of ["running", "dispatching"]) {
    const saved = { ...original.workflow.state, phase, token: "old-completion" };
    const resumed = fixture({ saved }); await resumed.workflow.init();
    assert.equal(resumed.workflow.state.reason, "interrupted-reload");
    assert.notEqual(resumed.workflow.state.token, "old-completion");
    await resumed.workflow.idle({ id: "late", data: {} }); await resumed.drain();
    assert.equal(resumed.sends.length, 0);
    await resumed.workflow.prompt("WORKFLOW RESET");
    await resumed.workflow.prompt("WORKFLOW START: a fresh task");
    assert.equal(resumed.workflow.state.phase, "running");
  }
});

test("corrupt or cross-session persistence fails closed", async () => {
  for (const saved of [{}, { version: 1, sessionId: "other" }]) {
    await assert.rejects(fixture({ saved }).workflow.init(), /Invalid workflow state/);
  }
});

test("deadline and transition caps stop sending", async () => {
  const f = fixture(); await f.start(); await f.complete();
  await f.workflow.stopped({ stopReason: "end_turn" });
  f.tick(MAX_RUN_MS);
  await f.workflow.idle({ id: "1", data: {} }); await f.drain();
  assert.equal(f.workflow.state.reason, "time-budget");
  const g = fixture(); await g.start(); g.workflow.state.transitions = 3;
  await g.finish();
  assert.equal(g.workflow.state.reason, "transition-budget");
  assert.equal(g.sends.length, 0);
});

test("send can re-enter the prompt hook without deadlock; rejected send is never retried", async () => {
  const f = fixture(); await f.start(); await f.finish();
  assert.equal(f.workflow.entered, true);
  const g = fixture(); await g.start();
  g.runtime.send = async () => { throw new Error("transport unavailable"); };
  await g.finish(); await g.workflow.queue;
  assert.equal(g.workflow.state.phase, "paused");
  assert.match(g.workflow.fault, /transport unavailable/);
  await g.workflow.idle({ id: "retry", data: {} }); await g.drain();
  assert.equal(g.workflow.state.transitions, 1);
});

test("selection failure and state write failure surface and stop", async () => {
  const f = fixture(); await f.start();
  f.runtime.select = async () => { throw new Error("select unavailable"); };
  await f.finish(); await f.workflow.queue;
  assert.equal(f.workflow.state.phase, "paused");
  assert.match(f.workflow.fault, /select unavailable/);
  const g = fixture(); await g.start();
  g.store.save = async () => { throw new Error("disk full"); };
  await assert.rejects(g.workflow.interrupt("pause"), /disk full/);
  assert.equal(g.workflow.state.phase, "paused");
  assert.equal(g.workflow.fault, "state-write-failed");
});

test("intervention during agent selection prevents send", async () => {
  const f = fixture(); await f.start();
  f.runtime.select = async () => { void f.workflow.prompt("Unrelated new request"); };
  await f.finish();
  assert.equal(f.sends.length, 0);
  assert.equal(f.workflow.state.phase, "paused");
});

test("errors before start preserve a valid ready state and explicit reset clears recoverable faults", async () => {
  const f = fixture(); await f.workflow.init();
  await f.workflow.fail(new Error("Agent discovery unavailable"));
  const resumed = fixture({ saved: f.writes.at(-1) });
  await resumed.workflow.init();
  assert.equal(resumed.workflow.state.phase, "ready");
  await f.workflow.prompt("WORKFLOW RESET");
  assert.equal(f.workflow.fault, null);
  await f.workflow.prompt("WORKFLOW START: a fresh task");
  assert.equal(f.workflow.state.phase, "running");
});
