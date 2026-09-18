import { randomUUID } from "node:crypto";

export const STAGES = ["workflow-plan", "workflow-implement", "workflow-test", "workflow-review"];
export const MAX_TRANSITIONS = STAGES.length - 1;
export const MAX_RUN_MS = 15 * 60 * 1000;
const ACTIVE = new Set(["running", "dispatching"]);
const PHASES = new Set(["ready", "running", "dispatching", "paused", "completed"]);

export function validateState(state, sessionId) {
  if (!state || state.version !== 1 || state.sessionId !== sessionId ||
      !PHASES.has(state.phase) || !Number.isInteger(state.index) ||
      state.index < 0 || state.index >= STAGES.length ||
      !Number.isInteger(state.transitions) || state.transitions < 0 ||
      state.transitions > MAX_TRANSITIONS || typeof state.reason !== "string" ||
      !Array.isArray(state.agents) || state.agents.some(id => typeof id !== "string") ||
      (state.phase !== "ready" && (state.agents.length !== STAGES.length ||
        typeof state.runId !== "string" || typeof state.token !== "string" ||
        !Number.isFinite(state.startedAt)))) {
    throw new Error("Invalid workflow state. Preserve the file and use the documented recovery procedure.");
  }
  return state;
}

export function resolveAgents(list) {
  if (!Array.isArray(list?.agents)) throw new Error("agent.list did not return an agents array.");
  return STAGES.map(name => {
    // Plugin IDs are namespaced. Match the authored name, select the returned ID.
    const matches = list.agents.filter(agent =>
      agent.name === name || agent.id === name || agent.id?.endsWith(`:${name}`));
    if (matches.length !== 1 || typeof matches[0].id !== "string" || !matches[0].id) {
      throw new Error(`Expected exactly one ${name} agent; found ${matches.length}. Remove duplicate installations.`);
    }
    if (matches[0].tools && !matches[0].tools.includes("workflow_complete")) {
      throw new Error(`${name} does not declare workflow_complete.`);
    }
    return matches[0].id;
  });
}

export class WorkflowController {
  constructor({ sessionId, runtime, store, now = Date.now, uuid = randomUUID,
    schedule = fn => setImmediate(fn) }) {
    this.sessionId = sessionId;
    this.runtime = runtime;
    this.store = store;
    this.now = now;
    this.uuid = uuid;
    this.schedule = schedule;
    this.state = this.fresh();
    this.queue = Promise.resolve();
    this.epoch = 0;
    this.receipt = false;
    this.normalStop = false;
    this.entered = false;
    this.expectedPrompt = null;
    this.selecting = null;
    this.seen = new Set();
    this.fault = null;
  }

  fresh() {
    return { version: 1, sessionId: this.sessionId, phase: "ready", index: 0,
      transitions: 0, reason: "not-started", agents: [] };
  }

  serial(fn) {
    const job = this.queue.then(fn);
    // Keep the queue usable after errors, while returning the rejection to its caller.
    this.queue = job.catch(() => {});
    return job;
  }

  async init() {
    const saved = await this.store.load();
    if (saved) {
      this.state = validateState(saved, this.sessionId);
      if (ACTIVE.has(this.state.phase)) {
        this.state.phase = "paused";
        this.state.reason = "interrupted-reload";
        this.state.token = this.uuid();
        await this.save();
      }
    }
  }

  async save() {
    try {
      await this.store.save(this.state);
    } catch (error) {
      this.fault = "state-write-failed";
      this.epoch++;
      this.state.phase = "paused";
      throw error;
    }
  }

  status() {
    return { ...this.state, stage: STAGES[this.state.index],
      receiptRecorded: this.receipt, normalStopObserved: this.normalStop,
      fault: this.fault };
  }

  context() {
    return `Workflow run ${this.state.runId}; stage ${STAGES[this.state.index]}; completion token ${this.state.token}.
Work only on this stage and the original user task in this conversation.
Call workflow_complete with runId, stage, token, outcome ("completed" or "blocked"), and concise evidence.
Then finish your turn normally. Do not call task_complete, switch agents, send follow-ups, or delegate.
Never commit, push, merge, publish, deploy, install software, or change permissions.
If anything is blocked or a validation fails, report outcome "blocked".`;
  }

  assertLive() {
    if (this.fault) throw new Error(`Workflow unavailable: ${this.fault}. Reload after fixing the reported error.`);
    if (this.state.phase !== "running") throw new Error(`Workflow is ${this.state.phase}; reset and explicitly start again.`);
    if (this.now() - this.state.startedAt >= MAX_RUN_MS) throw new Error("Workflow time budget expired.");
  }

  async currentMatches() {
    const result = await this.runtime.current();
    return result?.agent?.id === this.state.agents[this.state.index];
  }

  async pause(reason) {
    this.epoch++;
    this.receipt = false;
    this.normalStop = false;
    this.entered = false;
    this.expectedPrompt = null;
    if (ACTIVE.has(this.state.phase)) {
      this.state.phase = "paused";
      this.state.reason = reason;
      await this.save();
      await this.runtime.log(`Workflow paused: ${reason}. Stop current work if needed; WORKFLOW RESET permits a fresh start.`, "warning");
    }
  }

  interrupt(reason) {
    // Invalidate in-flight RPC checks immediately, before queued work gets a turn.
    this.epoch++;
    return this.serial(() => this.pause(reason));
  }

  prompt(prompt) {
    const internal = this.expectedPrompt !== null && prompt === this.expectedPrompt;
    if (!internal) this.epoch++;
    return this.serial(async () => {
      if (internal && prompt === this.expectedPrompt && this.state.phase === "running") {
        this.expectedPrompt = null;
        this.entered = true;
        return { additionalContext: this.context() };
      }
      await this.pause("user-intervention");
      if (prompt.trim() === "WORKFLOW RESET") {
        this.state = this.fresh();
        await this.save();
        this.fault = null;
        return { additionalContext: "Workflow reset. Acknowledge only. Do not start work." };
      }
      if (!/^WORKFLOW START: \S/.test(prompt)) {
        if (prompt.startsWith("WORKFLOW ")) {
          return { additionalContext: "No workflow transition authorized. Report workflow_status only." };
        }
        return;
      }
      if (this.state.phase !== "ready") throw new Error("Use WORKFLOW RESET before starting a new run.");
      if (this.fault) throw new Error(`Workflow unavailable: ${this.fault}.`);
      const epoch = this.epoch;
      const agents = resolveAgents(await this.runtime.list());
      const current = await this.runtime.current();
      if (epoch !== this.epoch) throw new Error("Start interrupted.");
      if (current?.agent?.id !== agents[0]) throw new Error("Select workflow-plan before WORKFLOW START.");
      this.state = { ...this.fresh(), phase: "running", agents, runId: this.uuid(),
        token: this.uuid(), startedAt: this.now(), reason: "stage-active" };
      this.entered = true;
      await this.save();
      await this.runtime.log(`Workflow started: ${STAGES[0]} (run ${this.state.runId}).`);
      return { additionalContext: this.context() };
    });
  }

  complete(args, invocation) {
    return this.serial(async () => {
      this.assertLive();
      if (invocation.sessionId !== this.sessionId || !this.entered ||
          args.runId !== this.state.runId || args.stage !== STAGES[this.state.index] ||
          args.token !== this.state.token) throw new Error("Completion does not match this session, run, or stage.");
      if (!["completed", "blocked"].includes(args.outcome) ||
          typeof args.evidence !== "string" || !args.evidence.trim() || args.evidence.length > 2000) {
        throw new Error("Completion needs an outcome and 1 to 2000 characters of evidence.");
      }
      const epoch = this.epoch;
      if (!await this.currentMatches() || epoch !== this.epoch) throw new Error("Selected agent changed; completion rejected.");
      if (args.outcome === "blocked") {
        await this.pause("stage-blocked");
        return "Blocked stage recorded. No next agent will run.";
      }
      this.receipt = true;
      return "Completion recorded. Finish normally. The controller still requires a normal stop and non-aborted session idle.";
    });
  }

  stopped(input) {
    return this.serial(async () => {
      if (this.state.phase !== "running") return;
      if (!this.entered || !this.receipt || input.stopHookActive || input.stop_hook_active ||
          input.stopReason !== "end_turn") {
        await this.pause(!this.receipt ? "missing-completion" : "unsupported-stop");
        return;
      }
      const epoch = this.epoch;
      if (!await this.currentMatches() || epoch !== this.epoch) {
        await this.pause("agent-changed");
        return;
      }
      this.normalStop = true;
    });
  }

  selected(name) {
    if (this.selecting === name) {
      this.selecting = null;
      return Promise.resolve();
    }
    return this.interrupt("manual-agent-change");
  }

  idle(event) {
    if (event.agentId || this.seen.has(event.id)) return Promise.resolve();
    this.seen.add(event.id);
    if (this.seen.size > 128) this.seen.delete(this.seen.values().next().value);
    if (event.data?.aborted) return this.interrupt("aborted");
    return this.serial(async () => {
      if (this.state.phase !== "running" || !this.entered) return;
      if (!this.receipt || !this.normalStop) {
        await this.pause("idle-without-completion-and-stop");
        return;
      }
      // Claim once, before scheduling. A second idle cannot dispatch this stage again.
      this.state.phase = "dispatching";
      await this.save();
      const epoch = this.epoch;
      this.schedule(() => {
        void this.serial(() => this.advance(epoch)).catch(error => this.fail(error));
      });
    });
  }

  async advance(epoch) {
    if (epoch !== this.epoch || this.state.phase !== "dispatching") return;
    if (this.now() - this.state.startedAt >= MAX_RUN_MS) {
      await this.pause("time-budget");
      return;
    }
    if (!await this.currentMatches() || epoch !== this.epoch) {
      await this.pause("agent-changed");
      return;
    }
    if (this.state.index === STAGES.length - 1) {
      this.state.phase = "completed";
      this.state.reason = "all-stages-completed";
      this.receipt = false;
      this.normalStop = false;
      await this.save();
      await this.runtime.log("Workflow completed: plan -> implement -> test -> review. Review the diff yourself; nothing was committed or published.");
      return;
    }
    if (this.state.transitions >= MAX_TRANSITIONS) {
      await this.pause("transition-budget");
      return;
    }
    const previous = STAGES[this.state.index];
    const next = this.state.agents[this.state.index + 1];
    this.selecting = next;
    await this.runtime.select(next);
    if (epoch !== this.epoch) { await this.pause("interrupted-dispatch"); return; }
    const selected = await this.runtime.current();
    if (selected?.agent?.id !== next || epoch !== this.epoch) {
      await this.pause("selection-not-confirmed");
      return;
    }
    this.state.index++;
    this.state.transitions++;
    this.state.token = this.uuid();
    this.state.phase = "running";
    this.state.reason = "stage-active";
    this.receipt = false;
    this.normalStop = false;
    this.entered = false;
    this.expectedPrompt = `WORKFLOW CONTINUE ${this.state.runId} ${this.state.token}\n${this.context()}`;
    await this.save();
    await this.runtime.log(`Workflow transition: ${previous} -> ${STAGES[this.state.index]}.`);
    if (epoch !== this.epoch) { await this.pause("interrupted-dispatch"); return; }
    // Never await send here: it can re-enter the prompt hook and wait on this queue.
    // Persisted intent plus no retries gives at-most-once dispatch after a crash.
    Promise.resolve(this.runtime.send(this.expectedPrompt)).catch(error => this.fail(error));
  }

  fail(error) {
    this.epoch++;
    return this.serial(() => this.recordFailure(error));
  }

  async recordFailure(error) {
    this.fault = error instanceof Error ? error.message : String(error);
    this.state.phase = this.state.runId ? "paused" : "ready";
    this.state.reason = "controller-error";
    this.receipt = false;
    this.normalStop = false;
    this.expectedPrompt = null;
    try { await this.save(); }
    catch (storageError) { console.error(`Workflow state error: ${storageError.message}`); }
    try { await this.runtime.log(`Workflow error: ${this.fault}. No automatic retry.`, "error"); }
    catch (logError) { console.error(`Workflow notification error: ${logError.message}`); }
  }
}
