# Validation record

This file separates observed integration behavior from the offline safety tests.
Commands below are maintained in `package.json` and `scripts/smoke.mjs`.

## Environment and scope

Checked on 2026-09-18 using macOS, Node.js v22.22.2, and Copilot CLI reporting
`1.0.84-5`. The SDK was read from the installed GitHub Copilot desktop app.
The extension subprocess log reported a bundled runtime payload labeled
`1.0.84-4`; this is an observation, not a promised minimum compatible version.
No proprietary runtime code or SDK files were copied into this repository.

## Observed live

- A local-directory marketplace installed `agent-workflow-demo@agent-workflow-demos`.
- The legacy manifest's `extensions: ["extensions"]` discovered the immediate
  child `agent-workflow/extension.mjs`. Pointing at the child itself did not.
- Plugin agents had IDs such as `agent-workflow-demo:workflow-plan`.
  `agent.list`, `agent.select`, and `agent.getCurrent` returned those IDs.
- The plugin extension requested hook registration approval and loaded after
  that exact permission was granted. Denial prevented loading.
- The model could see `workflow_status` and `workflow_complete` under the
  custom-agent tool allowlists.
- A repository-local install loaded in the actual desktop build session.
  Calling `workflow_status` returned `phase: "ready"`, no fault, and all four
  local agent IDs. No workflow was started in that build session.
- The live runtime emitted `agentStop` with `stopReason: "end_turn"`, followed
  by `sessionEnd(reason: "complete")`. The latter is a per-turn notification;
  treating it as cancellation incorrectly stopped chaining. The adapter and
  regression test preserve that ordering.
- A deliberately narrow smoke permission rule rejected a test command prefixed
  with `cd`. The implementation agent reported `blocked`; no test/review
  transition occurred. The harness now accepts that exact fixture-directory
  prefix as well as the bare sample test command.

- The real plugin completed the full sample chain through the SDK harness:
  `workflow-plan -> workflow-implement -> workflow-test -> workflow-review`.
  The persisted final state was `completed` with three automatic transitions.
  The harness independently checked punctuation, boundary trimming, underscore
  runs, and TypeError behavior, then ran the sample tests. All passed.

The full-chain run used the runtime-selected model, which reported
`claude-sonnet-5`; the agents specify no model override. The smoke harness's
actual terminal result was:

```text
Workflow transition: workflow-plan -> workflow-implement.
Workflow transition: workflow-implement -> workflow-test.
Workflow transition: workflow-test -> workflow-review.
Workflow completed: plan -> implement -> test -> review. Review the diff yourself; nothing was committed or published.
PASS: live four-stage chain, three automatic transitions, independent behavior assertions and tests.
```

Offline commands `npm run check`, `npm test`, and `npm run demo:test` passed on
the authoring machine. The final installer portability run discovered 83
workflow/installer tests: 82 passed and the Windows-only CLI-path test was
skipped on macOS. Both baseline example tests passed. The repository's
**Checks** workflow records the
cross-platform results for the published commit; consult that run for its
authoritative status rather than treating a local run as CI evidence.

## Reproduction

```sh
npm run check
npm test
npm run demo:test
node scripts/smoke.mjs --sdk "/path/to/installed/copilot-sdk" --cli "/path/to/copilot"
node scripts/smoke.mjs --sdk "/path/to/installed/copilot-sdk" --cli "/path/to/copilot" --run
```

The first smoke command checks loading and selection without inference.
The second uses real model turns, extension processes, hooks, and SDK dispatch.
It independently asserts the changed sample behavior and runs the sample tests.
It doesn't simulate controller events.

## Limits of the evidence

Offline tests use a fake runtime around the real controller and adapter. They
verify the state machine and installer, not service availability or UI behavior.
Headless SDK execution uses the actual runtime but doesn't prove the desktop
picker visually updates throughout a run. The desktop loading/status check
proves a narrower integration surface.

Other clients, app builds, managed policy configurations, model choices, and
permission decisions may behave differently. Windows/Linux offline CI isn't
evidence of a live desktop workflow on those platforms.
