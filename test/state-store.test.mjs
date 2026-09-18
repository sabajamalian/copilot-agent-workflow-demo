import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStateStore } from "../plugins/agent-workflow-demo/extensions/agent-workflow/state-store.mjs";

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), "workflow-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("atomically persists minimal state and enforces a single writer", async t => {
  const directory = await workspace(t);
  const store = await openStateStore(directory);
  assert.equal(await store.load(), null);
  await store.save({ phase: "paused", runId: "example" });
  assert.deepEqual(await store.load(), { phase: "paused", runId: "example" });
  await assert.rejects(openStateStore(directory), /Another workflow controller/);
  await store.close();
  const reopened = await openStateStore(directory);
  assert.equal((await reopened.load()).phase, "paused");
  await reopened.close();
});

test("corrupt state is reported, never overwritten as successful", async t => {
  const directory = await workspace(t);
  const store = await openStateStore(directory);
  await writeFile(join(directory, "files/agent-workflow-demo/state.json"), "broken");
  await assert.rejects(store.load(), SyntaxError);
  await store.close();
});

test("rejects missing workspace and symlinked state directories", async t => {
  await assert.rejects(openStateStore(undefined), /workspacePath/);
  const directory = await workspace(t);
  const other = await workspace(t);
  await symlink(other, join(directory, "files"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(openStateStore(directory), /Unsafe workflow state path/);
});

test("rejects symlinked state files without touching their target", async t => {
  const directory = await workspace(t);
  const store = await openStateStore(directory);
  const other = join(directory, "unrelated");
  await writeFile(other, "keep");
  await symlink(other, join(directory, "files/agent-workflow-demo/state.json"));
  await assert.rejects(store.save({ phase: "ready" }), /Unsafe workflow state path/);
  assert.equal(await readFile(other, "utf8"), "keep");
  await store.close();
});

test("invalid writer locks are not removed", async t => {
  const directory = await workspace(t);
  await mkdir(join(directory, "files/agent-workflow-demo"), { recursive: true });
  await writeFile(join(directory, "files/agent-workflow-demo/writer.lock"), '{"pid":-1}');
  await assert.rejects(openStateStore(directory), /Invalid workflow writer lock/);
});
