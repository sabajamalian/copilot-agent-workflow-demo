# Automatic custom-agent workflows in the GitHub Copilot app

Start in `workflow-plan`. An extension selects `workflow-implement`, `workflow-test`,
and `workflow-review` in the **same desktop session**, then sends each next turn.
There are no handoff buttons and no prompt asking the model to switch agents.

**Experimental integration.** The controller uses the installed Copilot SDK's
experimental `session.rpc.agent` APIs. GitHub documents plugins, custom agents,
extensions, and stop hooks separately. This repository supplies the orchestration.
It isn't a native declarative workflow feature or a supported enterprise control.
Check the [validation record](docs/validation.md) before relying on it.

I built this example around the part of agentic engineering I want teams to
inspect: the process that connects implementation, tests, and review. Generating
a patch is one step. Knowing which step completed, which evidence exists, and
when automation must stop is the engineering work.

## What the demo does

| Stage | Agent | Responsibility | Tools |
| --- | --- | --- | --- |
| Plan | `workflow-plan` | Inspect files, define scope and acceptance criteria | Read/search, workflow tools |
| Implement | `workflow-implement` | Make the planned change and focused tests | Read/search/edit/shell, workflow tools |
| Test | `workflow-test` | Run existing validation commands and report actual outcomes | Read/search/shell, workflow tools; no edit tool |
| Review | `workflow-review` | Inspect implementation and evidence; report blocking issues | Read/search, workflow tools |

The stage order and limits are defined in
[`controller.mjs`](plugins/agent-workflow-demo/extensions/agent-workflow/controller.mjs).
There are at most three automatic transitions and no automatic retries. A failing
test or review pauses the run. A human decides what to fix and when to start again.
The agents never have delegation tools or publishing tools in their allowlists.
Shell access in implementation and testing remains powerful; these roles aren't
a filesystem sandbox.

## Prerequisites

- A signed-in GitHub Copilot desktop app with access to custom agents and extensions.
  Your organization's policies must allow this plugin and its hook registration.
- Git and Node.js 22 or newer for the local installer, offline tests, and example.
  No `npm install` or SDK package installation is needed.
- A trusted development repository. Read extension code before approving it:
  extensions run as local Node processes with your operating-system access.
- A runtime exposing `joinSession`, `session.workspacePath`, `session.send`,
  `session.log`, `session.on`, and `session.rpc.agent.list/getCurrent/select`.
  The integration also needs main-agent `onAgentStop` and `session.idle` events.

The installer and offline CI cover macOS, Windows, and Linux. Use a supported
desktop build for your OS. This project does **not** promise a Linux desktop app,
a minimum desktop release, compatibility with every Copilot client, or that an
SDK method's presence proves the whole event lifecycle works.

## Quick start: install the plugin

**Choose this path OR the repository-local path below. Don't install both.**
The plugin carries the controller and all four agents, so it works in different
development repositories without copying files into each one.

1. Open **Customize > Plugins** in the GitHub Copilot app.
2. Open marketplace settings next to the marketplace dropdown. Add:
   `sabajamalian/copilot-agent-workflow-demo`.
3. Select the `agent-workflow-demos` marketplace and install
   `agent-workflow-demo`.
4. Start a new local project session. Review and approve the extension's request
   to **register hooks** if prompted. Keep ordinary tool permissions enabled.
5. Select **workflow-plan** in the prompt-box agent picker, or use `/agent`.
   Ask: `Call workflow_status. Do not start a run.`

Expected status is `phase: "ready"`, `fault: null`, and the four discovered agent
IDs. For plugin installs the tested IDs are:

```text
agent-workflow-demo:workflow-plan
agent-workflow-demo:workflow-implement
agent-workflow-demo:workflow-test
agent-workflow-demo:workflow-review
```

The controller matches the authored agents and uses each runtime-returned **ID**.
It doesn't guess a namespace separator or select the next agent by display text.

If you use the Copilot CLI to manage the same Copilot configuration, these
commands install the same marketplace/plugin:

```sh
copilot plugin marketplace add sabajamalian/copilot-agent-workflow-demo
copilot plugin install agent-workflow-demo@agent-workflow-demos
copilot plugin list --json
```

Check that the desktop app and your terminal CLI use the same user/configuration.
A custom `COPILOT_HOME`, remote environment, or different machine can separate
them. The **desktop Installed view and live `workflow_status` result** are the
checks that matter. CLI installation alone doesn't prove desktop loading.

### Try a concrete change

Clone this repository and add it as a project in the desktop app:

```sh
git clone https://github.com/sabajamalian/copilot-agent-workflow-demo.git
cd copilot-agent-workflow-demo
npm run demo:test
```

In a new session, select `workflow-plan`. Send this as a **new message**, with
the exact `WORKFLOW START: ` prefix:

```text
WORKFLOW START: In examples/slug.mjs, make slug replace each run of characters other than ASCII letters and digits with one hyphen and trim boundary hyphens. Punctuation-only input should return an empty string. Preserve TypeError for non-string input. Add focused cases in examples/slug.test.mjs. Validate with node --test examples/slug.test.mjs. Change no other files.
```

The baseline example already passes its existing tests. The requested punctuation
behavior is deliberately absent so the workflow has a small real change to make.
The planning and implementation results stay in the conversation for the next
agent. You should see timeline messages like:

```text
Workflow started: workflow-plan (run <id>).
Workflow transition: workflow-plan -> workflow-implement.
Workflow transition: workflow-implement -> workflow-test.
Workflow transition: workflow-test -> workflow-review.
Workflow completed: plan -> implement -> test -> review.
```

These are controller messages, not model-generated claims of switching agents.
Permission prompts can still pause progress. Review and approve only the
operations you intend. **Review the final diff yourself.** Nothing should be
committed, pushed, merged, published, or deployed by the demo.

## Alternative: install into one repository

Use this if marketplace installation is unavailable or you want to inspect and
modify the extension locally. It uses only Node built-ins and Git.

**First create/open the target desktop session, then install into its actual
working directory.** Desktop worktree sessions are separate checkouts. Installing
only in a project's primary clone won't add ignored/uncommitted files to another
worktree. The plugin path above avoids this issue.

From this clone, with the target set to the current session's repository root:

```sh
node scripts/install.mjs install --target "/path/to/target-session-worktree"
node scripts/install.mjs doctor --target "/path/to/target-session-worktree"
```

For Windows PowerShell, for example:

```powershell
node .\scripts\install.mjs install --target "C:\work\my-project-session"
node .\scripts\install.mjs doctor --target "C:\work\my-project-session"
```

For a desktop session working directly in this clone:

```sh
node scripts/install.mjs install --target .
node scripts/install.mjs doctor --target .
```

The installer creates:

```text
.github/agents/workflow-{plan,implement,test,review}.agent.md
.github/extensions/agent-workflow/{extension,adapter,controller,state-store}.mjs
.github/agent-workflow-demo.install.json
```

The final file tracks owned paths and hashes for updates and uninstall. The
installer refuses non-Git roots, symlinks, unmanaged collisions, altered/missing
owned files, and unsafe manifests. It preserves unrelated agents, files, and
settings. Repeating the install is safe; `update` is an alias.

After installing, start a new session in that same worktree, or ask the current
agent to call `extensions_reload`. Extension loading refreshes agent definitions
when the runtime exposes `agent.reload`. If the picker remains stale, restart
the session. Then select `workflow-plan` and request `workflow_status`.

Local IDs are `workflow-plan`, `workflow-implement`, `workflow-test`, and
`workflow-review`. Do not copy the SDK into the repository: the app injects it.

The demo repository ignores its generated local install. In another repository,
decide whether to check the generated components and ownership manifest into
source control for teammates or ignore them as per-developer files. Do not
commit session state. Every developer still needs a compatible app and must
approve local extension loading.

### Add it to a different project

For the plugin path, open the other project in the app and check that the plugin
is enabled there. Select `workflow-plan` and send a small task with explicit
acceptance criteria and existing validation commands.

For the local path, run the installer from this clone while pointing `--target`
at the other project's **session worktree**, as shown above. The source path is
resolved relative to the installer itself, so it can also be invoked by an
absolute script path from another working directory. Never paste your personal
machine paths into shared configuration.

## Start, pause, reset, and inspect

| Action | What to do | Behavior |
| --- | --- | --- |
| Start | Select `workflow-plan`; send `WORKFLOW START: <task>` | Creates a new run only from the ready state |
| Inspect | Ask for `workflow_status` | Read-only tool; a **new user message** also pauses active chaining |
| Stop active work | Use the app's Stop control | Cancellation invalidates pending transitions |
| Pause chaining | Send `WORKFLOW PAUSE` | Invalidates completion; doesn't kill an already-running tool |
| Reset | Send `WORKFLOW RESET` | Clears workflow metadata; doesn't revert your code |
| Start again | Reset, select `workflow-plan`, send a new start message | New run and new completion tokens |

Every new external message pauses active chaining, including a status question or
an answer to a clarification request. This deliberately favors human intervention
over unattended continuation. A direct `workflow_status` tool invocation doesn't
change state.

Switching agents manually, aborting, a runtime/tool failure, missing completion,
an unrecognized stop reason, or a failed test/review prevents the next transition.
Reloading or resuming an unfinished session pauses it. There is no automatic
resume or replay of a send whose outcome is unknown. Inspect the code and
conversation, then reset and explicitly start again.

## How the controller decides to advance

The contract is implemented in
[`controller.mjs`](plugins/agent-workflow-demo/extensions/agent-workflow/controller.mjs)
and wired to the runtime in
[`adapter.mjs`](plugins/agent-workflow-demo/extensions/agent-workflow/adapter.mjs).

1. The prompt hook accepts an exact start prefix only while `workflow-plan` is
   selected. It discovers all stage IDs and creates a session-bound run and token.
2. The current agent calls `workflow_complete` with matching **session, run,
   stage, token**, an outcome, and evidence. Stale or mismatched calls fail.
   A `blocked` outcome pauses. Evidence is the agent's report, not an independent
   proof that the code is correct.
3. The main-agent stop hook must observe `end_turn`, with no recursive stop-hook
   flag. It records that fact and returns. It doesn't block or send anything.
4. A non-aborted `session.idle` event claims the pending transition once. An idle
   event or assistant response on its own cannot complete a stage.
5. A scheduled callback rechecks the selected agent and run generation, persists
   dispatch intent, selects the next ID through `session.rpc.agent.select`,
   verifies selection, and sends the next turn.

`session.send` runs outside awaited stop hooks and is **not awaited by the
serialized controller queue**. Sending can re-enter the user-prompt hook.
Awaiting that send from the same queue would deadlock.

The adapter observes `subagent.selected`/`subagent.deselected` for changes to the
main selected custom agent. It ignores events with a child `agentId`.
`subagent.completed` is a delegated-agent event and is not a workflow trigger.
In the tested runtime, `onSessionEnd(reason: "complete")` occurs after each
normal turn, before `session.idle`; it is not treated as a cancellation.

The controller stores dispatch intent before sending and never retries an
uncertain send. This provides **at-most-once dispatch**, including across reloads,
rather than a promise of exactly-once execution. The SDK has no atomic
compare-and-select-and-send operation. Intervention checks reduce that race;
Stop is still necessary to cancel work already accepted by the runtime.

The source sets a 15-minute run age limit, checked at completion/transition
boundaries. It doesn't preempt a long tool call or model turn. Use the app's
normal budgets and Stop control for execution and cost limits.

### Why no `handoffs` property?

The workflow uses SDK selection and sends. Public stop hooks' `block`/`reason`
behavior continues the **same** agent. It doesn't select a next agent.
No agent in this repository depends on a `handoffs` property. See
[GitHub's hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference).

## Permissions, privacy, and trust

- No auto-approve permission handler is installed by the extension. Hook
  registration, edits, shell execution, and other requests use the host's normal
  gates. Managed policy still applies.
- The extension doesn't request secrets, environment credentials, network calls,
  new accounts, deployments, or access changes.
- The controller persists version, session/run IDs, agent IDs, stage, token, time,
  phase, transition count, and a reason code. It stores no task prompt or evidence.
  State lives under the runtime-provided session workspace:
  `files/agent-workflow-demo/state.json`, with a single-writer lock and atomic writes.
  Files use owner-only modes where the OS supports them.
- Prompts, tool arguments, evidence, and timeline messages still belong to normal
  Copilot session history and its retention policies. Don't put secrets in evidence.
- Tokens prevent accidental stale completion. They are visible to the active
  agent and are **not** an authorization boundary against malicious local code.
- Plan and review have no shell/edit tools. Testing has no edit tool, but shell
  commands and project tests can write files or run code. Inspect the repository
  and retain permission checks.
- Instructions prohibit publishing. A small hook also rejects common literal
  `git commit`, `git push`, `gh pr merge`, `gh release create`, and `npm publish`
  shell commands. This is a demonstration guard, not a general command sandbox.
  Use CI, branch protection, repository permissions, and organization policy for
  required delivery controls.

Automatic turns consume normal model usage. The extension starts no factories
and delegates no agents. It leaves model choice to the user's runtime settings.

## Update and uninstall

For the plugin:

```sh
copilot plugin marketplace update agent-workflow-demos
copilot plugin update agent-workflow-demo@agent-workflow-demos
copilot plugin uninstall agent-workflow-demo@agent-workflow-demos
copilot plugin marketplace remove agent-workflow-demos
```

Use only the commands you need; uninstall is not part of an update. These actions
are also available through the app's plugin management UI. Stop active workflow
work before changing the installation, then restart the session. Local
directory-sourced marketplace plugins load live from their source path, so
source edits take effect on restart. Don't assume auto-update applies to SDK or
server sessions.

For repository-local copies, update this source clone deliberately, then run:

```sh
git pull --ff-only
node scripts/install.mjs update --target "/path/to/target-session-worktree"
node scripts/install.mjs doctor --target "/path/to/target-session-worktree"
```

To uninstall those copies:

```sh
node scripts/install.mjs uninstall --target "/path/to/target-session-worktree"
```

Uninstall removes only hash-verified owned files and the install manifest. It
leaves unrelated files and empty directories. It does not erase session history
or controller state. Modified files are preserved and produce an error instead
of being overwritten. Back up your customization, reconcile it against the
installed version, then retry.

An interrupted installer retains
`.github/.agent-workflow-demo.transaction.json` and recovery data with original
bytes. Further mutations stop. Read the reported paths and reconcile the exact
files before removing recovery data; never delete `.github` or a session folder
to recover an installation.

## Troubleshooting

| Symptom | Check or recovery |
| --- | --- |
| Agents missing from picker | Confirm target worktree, enabled plugin, and agent files; restart or reload |
| `workflow_status` unavailable | Inspect extension status/log with `extensions_manage`; approve hook registration; check app/CLI configuration matches |
| Missing SDK method or workspace | Runtime incompatible; update to a compatible build or stop using this demo |
| Expected exactly one agent | Missing or duplicate installation; keep one distribution path and restart |
| Tool-name collision or writer lock | A second controller may be loaded; stop work and remove the duplicate, not unrelated extensions |
| `missing-completion` | Agent ended without calling the completion tool; inspect its work, reset, start again |
| `unsupported-stop` | Unexpected stop reason or another stop hook continued the agent; chaining stays paused |
| `stage-blocked` / `tool-failed` / `tool-unsuccessful` | Read the failed/denied command or review evidence; no automatic repair is attempted |
| `manual-agent-change` / `user-intervention` | Human control intentionally stopped chaining |
| `interrupted-reload` | Unfinished state was found; inspect existing edits before reset/restart |
| Invalid state JSON or disk error | Stop the extension, preserve the reported file for diagnosis, fix storage; use a new session for clean state |
| Stale writer lock after a crash | Verify the old process is gone before recovery; a new session has separate state |
| Installer refuses changed files | Preserve changes; reconcile the specific owned files rather than forcing overwrite |
| Nothing happens after planning | Confirm an explicit receipt, `end_turn`, and session idle. Background shells/agents defer session idle |

`node scripts/install.mjs doctor` checks the **local-copy** installation and
ownership hashes. It doesn't authenticate Copilot, test inference, or inspect a
globally installed plugin. For the plugin, use the Installed view, live status,
and an actual small run.

## Team and enterprise rollout

Publishing this repository doesn't install it on anybody's computer. Teams can
share the marketplace URL and installation instructions, or review and vendor
the repository-local components into their development repositories.

Enterprise administrators can distribute plugins through
[enterprise-managed settings](https://docs.github.com/en/copilot/reference/enterprise-administrators/enterprise-managed-settings).
GitHub's support table includes the desktop app for `enabledPlugins` and
`extraKnownMarketplaces`. Follow the documented
[setup and access requirements](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-enterprise/use-managed-settings/get-started),
including the designated `.github-private/copilot/managed-settings.json`
repository and applicable enterprise/team configuration.

This **illustrative template** uses placeholders, not a configuration to paste
unchanged:

```json
{
  "enabledPlugins": {
    "PLUGIN-NAME@MARKETPLACE-NAME": true
  },
  "extraKnownMarketplaces": {
    "MARKETPLACE-NAME": {
      "source": {
        "source": "github",
        "repo": "OWNER/REPO",
        "ref": "REVIEWED-TAG-OR-COMMIT"
      },
      "autoUpdate": false
    }
  }
}
```

For this project, the plugin key is
`agent-workflow-demo@agent-workflow-demos` and the source repository is
`sabajamalian/copilot-agent-workflow-demo`. Pin a reviewed revision. Pilot the
runtime and policy combination on developer machines before rollout.
Enterprise distribution and local workflow execution are separate concerns.
Installing the plugin doesn't enforce completion, require review, approve
commands, or replace protected-branch checks.

## Customize the workflow

Edit canonical files in `plugins/agent-workflow-demo`, not generated local
copies. Add or reorder a stage in `STAGES`, supply its agent profile, update the
explicit tool allowlist, and update tests and installer layout validation.
Keep workflow tools available to every stage. Avoid granting delegation or
publishing tools as a shortcut.

The fixed finite pipeline is intentional. A repair loop needs an explicit
state-machine design, budget, evidence contract, and tests for every exit. Don't
add an unconditional `send` from an idle listener.

Repository layout:

```text
plugins/agent-workflow-demo/    Versioned plugin: agents and extension source
.github/plugin/marketplace.json Marketplace catalog
scripts/install.mjs           Safe repository-local install/update/uninstall/doctor
scripts/check.mjs             Manifest, tool allowlist, and syntax checks
scripts/smoke.mjs             Opt-in real-runtime probe and live sample
test/                         Offline controller, adapter, storage, installer tests
examples/                     Small baseline task for a live run
.github/workflows/check.yml    Cross-platform offline CI
```

## Validate it yourself

```sh
npm run check
npm test
npm run demo:test
```

The offline suite uses `node:test`. It covers success, incomplete/blocked stages,
wrong agents/tokens/sessions, duplicate events, aborts, errors, manual switches,
intervention during selection, persistence/reload, bounds, and installer safety.
Mocks exercise the controller contract; they don't prove desktop behavior.

The optional SDK smoke probe uses your **installed** SDK and CLI. It creates an
isolated Copilot home and Git fixture, installs the real marketplace plugin,
loads its extension process, and exercises actual agent selection:

```sh
node scripts/smoke.mjs --sdk "/path/to/installed/copilot-sdk" --cli "/path/to/copilot"
```

Add `--run` to spend Copilot usage on the complete sample chain:

```sh
node scripts/smoke.mjs --sdk "/path/to/installed/copilot-sdk" --cli "/path/to/copilot" --run
```

Ask `extensions_manage` for its authoring guide to locate your installed SDK.
The smoke harness approves only this plugin's hook registration, workflow tools,
fixture reads, edits to the two sample files, and the exact sample test command
(optionally preceded by `cd` to the fixture). It rejects managed-human-required
or sandbox-bypass requests. These test-only approvals aren't shipped in the
extension. Use `--keep` to retain a successful fixture. Failed fixtures are
retained for diagnosis. The smoke timeout is three minutes.

The SDK probe runs the real CLI runtime and extension in a headless session.
The [validation record](docs/validation.md) distinguishes that from the desktop
app's loading check and from an end-to-end desktop UI run.

## Sources and compatibility references

- [Customize the GitHub Copilot app](https://docs.github.com/en/copilot/how-tos/github-copilot-app/customize-github-copilot-app): plugin installation and the agent picker.
- [CLI plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference): legacy manifest `agents` and `extensions` fields, commands, marketplace layout.
- [Create a marketplace](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-marketplace): paths are relative to repository root.
- [About plugins](https://docs.github.com/en/copilot/concepts/agents/about-plugins): Agent Plugins 1.0 versus legacy format. This demo deliberately uses legacy format; its `extensions` field is a path list, not the 1.0 namespace object.
- [Custom agent configuration](https://docs.github.com/en/copilot/reference/custom-agents-configuration): profiles and tool aliases.
- [Hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference): stop-hook behavior.
- [Copilot SDK](https://github.com/github/copilot-sdk): public SDK project. Exact compatibility was checked against the installed SDK's `docs/extensions.md`, `docs/agent-author.md`, `types.d.ts`, and generated RPC/event declarations. No bundled implementation or SDK files are redistributed here.

MIT licensed. See [contribution notes](CONTRIBUTING.md).
