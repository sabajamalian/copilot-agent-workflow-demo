import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";

async function ordinary(path, directory = false) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) {
    throw new Error(`Unsafe workflow state path: ${path}`);
  }
}

export async function openStateStore(workspacePath) {
  if (!workspacePath || !isAbsolute(workspacePath)) {
    throw new Error("The runtime must expose an absolute session.workspacePath.");
  }
  await ordinary(workspacePath, true);
  const files = join(workspacePath, "files");
  const directory = join(files, "agent-workflow-demo");
  for (const path of [files, directory]) {
    await mkdir(path, { mode: 0o700 }).catch(error => {
      if (error.code !== "EEXIST") throw error;
    });
    await ordinary(path, true);
  }
  const lockPath = join(directory, "writer.lock");
  const lockValue = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  const acquire = () => open(lockPath, "wx", 0o600);
  let lock;
  try { lock = await acquire(); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    await ordinary(lockPath);
    const owner = JSON.parse(await readFile(lockPath, "utf8"));
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error("Invalid workflow writer lock.");
    try {
      process.kill(owner.pid, 0);
      throw new Error("Another workflow controller owns this session. Remove duplicate installations.");
    } catch (probeError) {
      if (probeError.code !== "ESRCH") throw probeError;
    }
    throw new Error("Stale workflow writer lock. Start a new session, or verify no controller remains before removing only writer.lock.");
  }
  await lock.writeFile(lockValue);
  await lock.close();
  const file = join(directory, "state.json");
  return {
    async load() {
      try {
        await ordinary(file);
        return JSON.parse(await readFile(file, "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
    async save(state) {
      await ordinary(directory, true);
      try { await ordinary(file); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      const temporary = join(directory, `state.${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
        await handle.sync();
      } finally { await handle.close(); }
      try { await rename(temporary, file); }
      catch (error) {
        await unlink(temporary);
        throw error;
      }
    },
    async close() {
      await ordinary(lockPath);
      if (await readFile(lockPath, "utf8") !== lockValue) throw new Error("Workflow writer lock changed.");
      await unlink(lockPath);
    },
  };
}
