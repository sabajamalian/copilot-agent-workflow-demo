#!/usr/bin/env node
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const PLUGIN_NAME = 'agent-workflow-demo';
export const MANIFEST_PATH = `.github/${PLUGIN_NAME}.install.json`;
export const TRANSACTION_PATH = `.github/.${PLUGIN_NAME}.transaction.json`;
export const CANONICAL_SOURCE = fileURLToPath(new URL('../plugins/agent-workflow-demo/', import.meta.url));
const AGENTS = ['workflow-plan', 'workflow-implement', 'workflow-test', 'workflow-review'];
const AGENT_DIR = '.github/agents';
const EXTENSION_DIR = '.github/extensions/agent-workflow';
const REQUIRED_PATHS = [
  ...AGENTS.map((name) => `${AGENT_DIR}/${name}.agent.md`),
  ...['extension', 'controller', 'state-store', 'adapter'].map((name) => `${EXTENSION_DIR}/${name}.mjs`),
];
const RUNTIME_NOTICE = 'Disk checks cannot prove Copilot CLI authentication, extension loading, or runtime SDK features. In the app, use the live workflow_status tool to check runtime support.';
const HASH = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 10000;

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function assertNodeVersion(version = process.versions.node) {
  if (!/^\d+\.\d+\.\d+/.test(version) || Number(version.split('.')[0]) < 22) {
    throw new Error(`Node.js >=22 is required (found ${version}).`);
  }
}

function fail(message) {
  throw new Error(message);
}

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function containsPath(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function resolveInput(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    fail(`${label} must be a nonempty filesystem path.`);
  }
  const root = path.isAbsolute(value) ? path.parse(value).root : '';
  let prefix = root || process.cwd();
  const parts = value.slice(root.length).split(process.platform === 'win32' ? /[\\/]/ : /\//);
  // Inspect components before resolving "..", which could otherwise hide a symlink.
  for (const part of parts.filter(Boolean)) {
    prefix = path.resolve(prefix, part);
    await assertSafePath(prefix);
  }
  return path.resolve(value);
}

async function statOrNull(filename) {
  try {
    return await fs.lstat(filename);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function assertSafePath(filename) {
  const absolute = path.resolve(filename);
  const root = path.parse(absolute).root;
  const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (let i = 0; i < parts.length; i += 1) {
    current = path.join(current, parts[i]);
    const stat = await statOrNull(current);
    if (!stat) return;
    if (stat.isSymbolicLink()) fail(`Refusing symlink path component: ${current}`);
    if (i < parts.length - 1 && !stat.isDirectory()) {
      fail(`Expected a directory at path component: ${current}`);
    }
  }
}

async function snapshot(filename, { limit = Infinity } = {}) {
  await assertSafePath(filename);
  const stat = await statOrNull(filename);
  if (!stat) return null;
  if (!stat.isFile()) fail(`Expected a regular file: ${filename}`);
  if (stat.size > limit) fail(`File exceeds the allowed size: ${filename}`);
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) {
      fail(`File changed while being read: ${filename}`);
    }
    const data = await handle.readFile();
    const after = await handle.stat();
    if (data.length > limit || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      fail(`File changed while being read: ${filename}`);
    }
    return { data, hash: sha256(data), mode: stat.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

async function requiredSnapshot(filename) {
  const result = await snapshot(filename);
  if (!result) fail(`Required file is missing: ${filename}`);
  return result;
}

function portablePart(part) {
  return /^[A-Za-z0-9_.-]+$/.test(part)
    && part !== '.' && part !== '..' && !part.endsWith('.')
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    && part.length <= 200;
}

function validateOwnedPath(relative) {
  if (typeof relative !== 'string' || relative.length > 2000
    || !relative.split('/').every(portablePart)) {
    fail(`Unsafe owned file path: ${JSON.stringify(relative)}`);
  }
  const isAgent = AGENTS.some((name) => relative === `${AGENT_DIR}/${name}.agent.md`);
  if (!isAgent && !relative.startsWith(`${EXTENSION_DIR}/`)) {
    fail(`Manifest file is outside the installer-owned layout: ${relative}`);
  }
}

function validatePaths(paths) {
  if (paths.length > MAX_FILES) fail(`Owned layout exceeds the ${MAX_FILES}-file limit.`);
  const exactPaths = new Set(paths);
  const seen = new Set();
  for (const relative of paths) {
    validateOwnedPath(relative);
    const key = relative.toLowerCase();
    if (seen.has(key)) fail(`Duplicate or case-colliding owned file path: ${relative}`);
    seen.add(key);
  }
  for (const key of seen) {
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      if (seen.has(parts.slice(0, i).join('/'))) fail(`File/directory conflict in owned layout: ${key}`);
    }
  }
  for (const required of REQUIRED_PATHS) {
    if (!exactPaths.has(required)) fail(`Required file is absent from the owned layout: ${required}`);
  }
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function parseManifest(data) {
  let manifest;
  try {
    manifest = JSON.parse(data.toString('utf8'));
  } catch {
    fail('Invalid install manifest JSON. No files were changed.');
  }
  if (!exactKeys(manifest, ['schemaVersion', 'plugin', 'version', 'files'])
    || manifest.schemaVersion !== 1 || manifest.plugin !== PLUGIN_NAME
    || typeof manifest.version !== 'string' || !VERSION.test(manifest.version)
    || !Array.isArray(manifest.files)) {
    fail('Invalid or unsupported install manifest. No files were changed.');
  }
  for (const entry of manifest.files) {
    if (!exactKeys(entry, ['path', 'sha256']) || typeof entry.sha256 !== 'string' || !HASH.test(entry.sha256)) {
      fail('Invalid file entry in install manifest. No files were changed.');
    }
  }
  validatePaths(manifest.files.map((entry) => entry.path));
  return manifest;
}

async function validateTarget(input) {
  const target = await resolveInput(input, 'Target');
  await assertSafePath(target);
  const stat = await statOrNull(target);
  if (!stat?.isDirectory()) fail(`Target must be an existing Git repository directory: ${target}`);
  await assertSafePath(path.join(target, '.git'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  let root;
  try {
    const { stdout } = await run('git', ['-c', 'core.fsmonitor=false', '-C', target, 'rev-parse', '--show-toplevel'], {
      env, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true,
    });
    root = path.resolve(stdout.trim());
  } catch (error) {
    fail(`Target is not a Git worktree, or Git is unavailable: ${target} (${error.code ?? 'git failed'}).`);
  }
  if (!samePath(root, target)) {
    fail(`Target must be the Git repository root, not a nested directory. Use --target ${JSON.stringify(root)}.`);
  }
  return target;
}

async function assertNoTransaction(target) {
  const filename = path.join(target, TRANSACTION_PATH);
  await assertSafePath(filename);
  if (await statOrNull(filename)) {
    fail(`An interrupted or active installation exists at ${TRANSACTION_PATH}. Do not delete it blindly. If no installer is running, inspect its original base64 file bytes and hashes, restore the recorded files, and remove only its recorded staging files and journal after recovery.`);
  }
}

async function loadInstallation(target) {
  const original = await snapshot(path.join(target, MANIFEST_PATH), { limit: MAX_MANIFEST_BYTES });
  return { original, manifest: original ? parseManifest(original.data) : null };
}

async function collectSource(sourceInput, target) {
  const source = await resolveInput(sourceInput, 'Source');
  await assertSafePath(source);
  for (const destination of [AGENT_DIR, EXTENSION_DIR]) {
    const output = path.join(target, destination);
    if (containsPath(source, output) || containsPath(output, source)) {
      fail('Source and destination overlap. The canonical plugin must be separate from generated local copies.');
    }
  }
  const pluginBytes = await requiredSnapshot(path.join(source, 'plugin.json'));
  let plugin;
  try {
    plugin = JSON.parse(pluginBytes.data.toString('utf8'));
  } catch {
    fail('Source plugin.json is not valid JSON.');
  }
  if (plugin?.name !== PLUGIN_NAME || typeof plugin.version !== 'string' || !VERSION.test(plugin.version)) {
    fail(`Source plugin.json must identify ${PLUGIN_NAME} with a semantic version.`);
  }
  const files = new Map();
  const agents = path.join(source, 'agents');
  await assertSafePath(agents);
  const agentNames = await fs.readdir(agents);
  for (const name of agentNames.sort()) {
    await assertSafePath(path.join(agents, name));
    if (!name.endsWith('.agent.md')) continue;
    const relative = `${AGENT_DIR}/${name}`;
    validateOwnedPath(relative);
    files.set(relative, await requiredSnapshot(path.join(agents, name)));
  }
  async function walk(directory, relative) {
    await assertSafePath(directory);
    if (!(await statOrNull(directory))?.isDirectory()) fail(`Source directory is missing: ${directory}`);
    for (const name of (await fs.readdir(directory)).sort()) {
      if (!portablePart(name)) fail(`Source filename is not portable: ${name}`);
      const filename = path.join(directory, name);
      await assertSafePath(filename);
      const stat = await fs.lstat(filename);
      if (stat.isDirectory()) await walk(filename, `${relative}/${name}`);
      else files.set(`${relative}/${name}`, await requiredSnapshot(filename));
    }
  }
  await walk(path.join(source, 'extensions', 'agent-workflow'), EXTENSION_DIR);
  validatePaths([...files.keys()]);
  return { version: plugin.version, files };
}

async function inspectOwned(target, manifest) {
  const originals = new Map();
  for (const entry of manifest?.files ?? []) {
    const original = await snapshot(path.join(target, entry.path));
    if (!original) fail(`Owned file is missing: ${entry.path}. Restore the original file before updating or uninstalling.`);
    if (original.hash !== entry.sha256) {
      fail(`Owned file was modified: ${entry.path}. Preserve your edits elsewhere and restore the original before updating or uninstalling.`);
    }
    originals.set(entry.path, original);
  }
  return originals;
}

async function ensureParents(filename) {
  const parent = path.dirname(filename);
  await assertSafePath(parent);
  const stat = await statOrNull(parent);
  if (stat) {
    if (!stat.isDirectory()) fail(`Expected a directory: ${parent}`);
    return;
  }
  await ensureParents(parent);
  try {
    await fs.mkdir(parent);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  await assertSafePath(parent);
  if (!(await fs.lstat(parent)).isDirectory()) fail(`Expected a directory: ${parent}`);
}

async function assertExpected(target, relative, expected) {
  const actual = await snapshot(path.join(target, relative));
  if ((actual?.hash ?? null) !== (expected?.hash ?? null)) {
    fail(`File changed during installation: ${relative}. Refusing to overwrite it.`);
  }
}

async function writeExclusive(filename, data, mode = 0o600, onCreated = () => {}) {
  await assertSafePath(filename);
  const handle = await fs.open(filename, 'wx', mode);
  try {
    onCreated();
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function cleanStage(target, relative, expectedHash) {
  const filename = path.join(target, relative);
  const actual = await snapshot(filename);
  if (!actual) return;
  if (actual.hash !== expectedHash) fail(`Staging file changed; preserved for inspection: ${relative}`);
  await fs.unlink(filename);
}

async function replaceFromStage(target, change, stage) {
  const filename = path.join(target, change.path);
  if (change.after) await assertExpected(target, stage, change.after);
  await assertExpected(target, change.path, change.before);
  if (!change.after) {
    await fs.unlink(filename);
  } else if (!change.before) {
    // Linking is atomic and refuses a file created by another writer.
    await fs.link(path.join(target, stage), filename);
  } else {
    await fs.rename(path.join(target, stage), filename);
  }
}

async function transact(target, changes, observations) {
  if (!changes.length) return;
  const id = randomUUID();
  const plans = changes.map((change, index) => ({
    ...change,
    stage: `${path.posix.dirname(change.path)}/.${PLUGIN_NAME}-${id}-${index}.stage`,
    rollbackStage: `${path.posix.dirname(change.path)}/.${PLUGIN_NAME}-${id}-${index}.rollback`,
  }));
  for (const change of plans) {
    await assertSafePath(path.join(target, change.path));
    for (const stage of [change.stage, change.rollbackStage]) {
      await assertSafePath(path.join(target, stage));
      if (await statOrNull(path.join(target, stage))) fail(`Unmanaged staging collision: ${stage}`);
    }
  }
  const journal = {
    schemaVersion: 1,
    plugin: PLUGIN_NAME,
    recovery: 'For each path, beforeBase64 is its original content (null means originally absent). Restore only if its current SHA-256 equals beforeSha256 or afterSha256; preserve unexpected content for manual reconciliation. Remove only the listed stages and this journal after recovery. Empty directories may remain.',
    changes: plans.map((change) => ({
      path: change.path,
      beforeBase64: change.before?.data.toString('base64') ?? null,
      beforeSha256: change.before?.hash ?? null,
      beforeMode: change.before?.mode ?? null,
      afterSha256: change.after?.hash ?? null,
      stage: change.stage,
      rollbackStage: change.rollbackStage,
    })),
  };
  const journalPath = path.join(target, TRANSACTION_PATH);
  const journalData = Buffer.from(`${JSON.stringify(journal, null, 2)}\n`);
  await ensureParents(journalPath);
  // Exclusive creation is also the cross-process installer lock.
  let journalHandle;
  try {
    journalHandle = await fs.open(journalPath, 'wx', 0o600);
  } catch (error) {
    fail(`Cannot acquire installation journal ${TRANSACTION_PATH}: ${error.code ?? error.message}. No owned files were changed.`);
  }
  const applied = [];
  const stages = new Map();
  let committed = false;
  let journalReady = false;
  try {
    await journalHandle.writeFile(journalData);
    await journalHandle.sync();
    await journalHandle.close();
    journalHandle = null;
    journalReady = true;
    for (const [relative, expected] of observations) await assertExpected(target, relative, expected);
    for (const change of plans) {
      await ensureParents(path.join(target, change.path));
      if (change.after) {
        await writeExclusive(
          path.join(target, change.stage), change.after.data, change.before?.mode ?? 0o644,
          () => stages.set(change.stage, change.after.hash),
        );
      }
    }
    for (const change of plans) {
      // Verify every observed file again before the first mutation.
      if (!applied.length) {
        for (const [relative, expected] of observations) await assertExpected(target, relative, expected);
      }
      if (change.path === MANIFEST_PATH) {
        const expectedState = new Map(observations);
        for (const appliedChange of applied) expectedState.set(appliedChange.path, appliedChange.after);
        for (const [relative, expected] of expectedState) await assertExpected(target, relative, expected);
      }
      await replaceFromStage(target, change, change.stage);
      applied.push(change);
    }
    committed = true;
    for (const [stage, hash] of stages) await cleanStage(target, stage, hash);
    await cleanStage(target, TRANSACTION_PATH, sha256(journalData));
  } catch (error) {
    if (journalHandle) await journalHandle.close().catch(() => {});
    const recoveryErrors = [];
    if (!committed) {
      for (const change of [...applied].reverse()) {
        try {
          await assertExpected(target, change.path, change.after);
          if (change.before) {
            await writeExclusive(
              path.join(target, change.rollbackStage), change.before.data, change.before.mode,
              () => stages.set(change.rollbackStage, change.before.hash),
            );
          }
          await replaceFromStage(target, {
            path: change.path, before: change.after, after: change.before,
          }, change.rollbackStage);
        } catch (rollbackError) {
          recoveryErrors.push(`${change.path}: ${rollbackError.message}`);
        }
      }
    }
    for (const [stage, hash] of stages) {
      try {
        await cleanStage(target, stage, hash);
      } catch (cleanupError) {
        recoveryErrors.push(cleanupError.message);
      }
    }
    if (!recoveryErrors.length && !committed && journalReady) {
      try {
        await cleanStage(target, TRANSACTION_PATH, sha256(journalData));
      } catch (cleanupError) {
        recoveryErrors.push(cleanupError.message);
      }
    }
    if (committed || recoveryErrors.length || !journalReady) {
      fail(`${committed ? 'Changes were committed, but cleanup failed' : 'Installation failed and recovery needs attention'}: ${error.message}. Recovery journal: ${TRANSACTION_PATH}. Do not delete it blindly.${recoveryErrors.length ? ` ${recoveryErrors.join('; ')}` : ''}`);
    }
    fail(`Installation failed; owned file changes were rolled back. Empty directories may remain. ${error.message}`);
  }
}

/**
 * Install or update from a plugin directory. `source` is for embedding/testing;
 * the CLI always uses CANONICAL_SOURCE. No absolute paths are persisted.
 */
export async function install({ target = process.cwd(), source = CANONICAL_SOURCE } = {}) {
  assertNodeVersion();
  target = await validateTarget(target);
  await assertNoTransaction(target);
  const { original, manifest } = await loadInstallation(target);
  const originals = await inspectOwned(target, manifest);
  const incoming = await collectSource(source, target);
  const observations = new Map(originals);
  observations.set(MANIFEST_PATH, original);
  const changes = [];
  const oldKeys = new Map([...originals.keys()].map((relative) => [relative.toLowerCase(), relative]));
  for (const [relative, after] of incoming.files) {
    if (oldKeys.has(relative.toLowerCase()) && oldKeys.get(relative.toLowerCase()) !== relative) {
      fail(`Case-only changes to owned paths are not supported: ${relative}`);
    }
    const before = originals.get(relative) ?? null;
    if (!before) {
      if (await snapshot(path.join(target, relative))) fail(`Unmanaged file collision: ${relative}. No files were changed.`);
      observations.set(relative, null);
    }
    if (before?.hash !== after.hash) changes.push({ path: relative, before, after });
  }
  for (const [relative, before] of originals) {
    if (!incoming.files.has(relative)) changes.push({ path: relative, before, after: null });
  }
  const nextManifest = {
    schemaVersion: 1,
    plugin: PLUGIN_NAME,
    version: incoming.version,
    files: [...incoming.files].sort(([a], [b]) => a.localeCompare(b)).map(([relative, file]) => ({
      path: relative, sha256: file.hash,
    })),
  };
  const data = Buffer.from(`${JSON.stringify(nextManifest, null, 2)}\n`);
  if (data.length > MAX_MANIFEST_BYTES) fail('Generated ownership manifest exceeds the size limit. No files were changed.');
  const after = { data, hash: sha256(data), mode: original?.mode ?? 0o644 };
  if (original?.hash !== after.hash) changes.push({ path: MANIFEST_PATH, before: original, after });
  await transact(target, changes, observations);
  return {
    action: changes.length ? (manifest ? 'updated' : 'installed') : 'unchanged',
    version: incoming.version, files: incoming.files.size,
  };
}

export const update = install;

export async function uninstall({ target = process.cwd() } = {}) {
  assertNodeVersion();
  target = await validateTarget(target);
  await assertNoTransaction(target);
  const { original, manifest } = await loadInstallation(target);
  if (!manifest) return { action: 'absent', files: 0 };
  const originals = await inspectOwned(target, manifest);
  const observations = new Map(originals);
  observations.set(MANIFEST_PATH, original);
  const changes = [...originals].map(([relative, before]) => ({ path: relative, before, after: null }));
  changes.push({ path: MANIFEST_PATH, before: original, after: null });
  await transact(target, changes, observations);
  return { action: 'uninstalled', version: manifest.version, files: originals.size };
}

export async function doctor({ target = process.cwd(), nodeVersion = process.versions.node } = {}) {
  const checks = [];
  async function check(name, action) {
    try {
      const detail = await action();
      checks.push({ name, ok: true, detail });
      return true;
    } catch (error) {
      checks.push({ name, ok: false, detail: error.message });
      return false;
    }
  }
  await check('Node.js >=22', () => {
    assertNodeVersion(nodeVersion);
    return nodeVersion;
  });
  if (await check('Git repository root', async () => {
    target = await validateTarget(target);
    return target;
  })) {
    await check('No interrupted transaction', async () => {
      await assertNoTransaction(target);
      return 'No pending installation journal.';
    });
    await check('Installed layout and hashes', async () => {
      const { manifest } = await loadInstallation(target);
      if (!manifest) fail(`No installation manifest at ${MANIFEST_PATH}. Run install first.`);
      await inspectOwned(target, manifest);
      return `${PLUGIN_NAME} ${manifest.version}: ${manifest.files.length} owned files verified.`;
    });
  }
  return { ok: checks.every((check) => check.ok), checks, runtime: RUNTIME_NOTICE };
}

export const HELP = `Repository-local agent workflow installer (Node.js >=22 and Git required)

Usage:
  node scripts/install.mjs install [--target <git-repository-root>]
  node scripts/install.mjs update [--target <git-repository-root>]
  node scripts/install.mjs uninstall [--target <git-repository-root>]
  node scripts/install.mjs doctor [--target <git-repository-root>]

The target defaults to the current working directory and must be a Git root.
Quote paths containing spaces. Source files always come from the canonical
plugins/agent-workflow-demo directory beside this repository's scripts.
Install also updates; update is an alias. Repeated installs are idempotent.
Only the four workflow agents and the agent-workflow extension are managed.
The ownership manifest is ${MANIFEST_PATH}.
Unmanaged collisions, missing/modified owned files, and symlinks are refused.
Uninstall removes only verified owned files and the manifest; empty directories
and unrelated files/settings are kept. No global configuration is changed.
Interrupted operations retain ${TRANSACTION_PATH}
with original bytes for recovery; do not remove it without reconciling files.
${RUNTIME_NOTICE}
`;

export async function main(argv = process.argv.slice(2)) {
  if (!argv.length || (argv.length === 1 && ['--help', '-h', 'help'].includes(argv[0]))) {
    console.log(HELP);
    return 0;
  }
  const [command, ...args] = argv;
  if (!['install', 'update', 'uninstall', 'doctor'].includes(command)) fail(`Unknown command: ${command}. Use --help.`);
  let target;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--target' || target !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) {
      fail(`Invalid arguments near ${args[index]}. Use --help.`);
    }
    target = args[++index];
  }
  if (command === 'doctor') {
    const report = await doctor({ target });
    for (const check of report.checks) console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`);
    console.log(report.runtime);
    return report.ok ? 0 : 1;
  }
  const result = command === 'uninstall' ? await uninstall({ target }) : await install({ target });
  console.log(`${PLUGIN_NAME}: ${result.action}${result.version ? ` (${result.version}, ${result.files} files)` : ''}.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}
