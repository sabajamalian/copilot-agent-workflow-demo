import { WorkflowController, resolveAgents } from "./controller.mjs";
import { openStateStore } from "./state-store.mjs";

const parameters = {
  type: "object",
  properties: {
    runId: { type: "string" }, stage: { type: "string" }, token: { type: "string" },
    outcome: { type: "string", enum: ["completed", "blocked"] },
    evidence: { type: "string", minLength: 1, maxLength: 2000 },
  },
  required: ["runId", "stage", "token", "outcome", "evidence"],
  additionalProperties: false,
};

export function createAdapter() {
  let controller;
  let session;
  let store;
  let startupError;
  const ready = () => {
    if (startupError) throw startupError;
    if (!controller) throw new Error("Workflow controller is still initializing. Retry workflow_status after it loads.");
    return controller;
  };
  const report = async error => {
    if (controller) await controller.fail(error);
    else {
      startupError = error;
      console.error(`Workflow startup error: ${error.message}`);
      if (session) await session.log(`Workflow unavailable: ${error.message}`, { level: "error" });
    }
  };
  const hook = fn => async (input, invocation) => {
    if (!controller || invocation.sessionId !== session.sessionId) return;
    try { return await fn(input); }
    catch (error) {
      await report(error);
      return { additionalContext: `Workflow failed: ${error.message}. Do not continue workflow work.` };
    }
  };
  const tool = fn => async (args, invocation) => {
    try { return JSON.stringify(await fn(ready(), args, invocation)); }
    catch (error) {
      await report(error);
      return { resultType: "failure", textResultForLlm: `Workflow error: ${error.message}` };
    }
  };
  const config = {
    tools: [
      {
        name: "workflow_status",
        description: "Inspect this explicit opt-in workflow and live agent IDs. Does not start a run.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        handler: tool(async current => ({
          ...current.status(), discoveredAgents: resolveAgents(await session.rpc.agent.list()),
          controls: "Select workflow-plan. WORKFLOW RESET clears a paused/completed run. WORKFLOW START: <task> starts. Any other new message pauses active chaining.",
        })),
      },
      {
        name: "workflow_complete",
        description: "Record explicit evidence for the current workflow stage. Completion alone never starts the next agent.",
        parameters,
        handler: tool((current, args, invocation) => current.complete(args, invocation)),
      },
    ],
    hooks: {
      onUserPromptSubmitted: hook(input => controller.prompt(input.prompt)),
      onAgentStop: hook(async input => { await controller.stopped(input); }),
      onErrorOccurred: hook(async () => { await controller.interrupt("runtime-error"); }),
      onPostToolUseFailure: hook(async () => { await controller.interrupt("tool-failed"); }),
      onSessionEnd: hook(async input => {
        // The tested runtime emits "complete" after each normal turn, before session.idle.
        if (input.reason !== "complete") await controller.interrupt("session-ended");
      }),
      onPreToolUse: hook(async input => {
        if (!["running", "dispatching"].includes(controller.state.phase)) return;
        if (controller.receipt && !["workflow_status", "workflow_complete"].includes(input.toolName)) {
          await controller.interrupt("work-after-completion");
        }
        // Shell access is deliberately absent from plan/review; aliases aren't a sandbox.
        const command = input.toolArgs?.command ?? "";
        if (typeof command === "string" &&
            /\b(git\s+(push|commit)|gh\s+(pr\s+merge|release\s+create)|npm\s+publish)\b/i.test(command)) {
          await controller.interrupt("publishing-command-denied");
          return { permissionDecision: "deny", permissionDecisionReason: "This demo never commits, pushes, merges, or publishes." };
        }
      }),
    },
  };

  return {
    config,
    async attach(joined) {
      session = joined;
      try {
        for (const method of ["list", "getCurrent", "select"]) {
          if (typeof session.rpc?.agent?.[method] !== "function") throw new Error(`Missing SDK agent.${method}.`);
        }
        if (typeof session.send !== "function" || typeof session.on !== "function" ||
            typeof session.log !== "function") throw new Error("Missing SDK send/on/log capability.");
        if (typeof session.rpc.agent.reload === "function") await session.rpc.agent.reload();
        store = await openStateStore(session.workspacePath);
        const candidate = new WorkflowController({
          sessionId: session.sessionId, store,
          runtime: {
            list: () => session.rpc.agent.list(),
            current: () => session.rpc.agent.getCurrent(),
            select: name => session.rpc.agent.select({ name }),
            send: prompt => session.send({ prompt, source: "agent-workflow-demo", mode: "enqueue" }),
            log: (message, level = "info") => session.log(message, { level }),
          },
        });
        await candidate.init();
        controller = candidate;
        const event = fn => data => {
          if (data.agentId) return;
          void fn(data).catch(report);
        };
        session.on("session.idle", event(data => controller.idle(data)));
        session.on("abort", event(() => controller.interrupt("aborted")));
        session.on("session.error", event(() => controller.interrupt("runtime-error")));
        session.on("tool.execution_complete", event(data => data.data.success === false
          ? controller.interrupt("tool-unsuccessful") : Promise.resolve()));
        session.on("subagent.selected", event(data => controller.selected(data.data.agentName)));
        session.on("subagent.deselected", event(() => controller.interrupt("manual-agent-change")));
        await session.log("Agent workflow loaded (experimental). No run starts until workflow-plan receives WORKFLOW START: <task>.");
      } catch (error) { await report(error); }
    },
    async close() {
      if (controller) await controller.interrupt("extension-stopped");
      if (store) await store.close();
    },
  };
}
