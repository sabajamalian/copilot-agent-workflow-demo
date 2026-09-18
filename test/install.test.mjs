import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  install, update, uninstall, doctor, assertNodeVersion, sha256,
  PLUGIN_NAME, MANIFEST_PATH, TRANSACTION_PATH, CANONICAL_SOURCE,
} from '../scripts/install.mjs';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../scripts/install.mjs', import.meta.url));
const agentDir = '.github/agents';
const extensionDir = '.github/extensions/agent-workflow';
const agentFile = `${agentDir}/workflow-plan.agent.md`;
const extensionFile = `${extensionDir}/extension.mjs`;
const sourceExtension = 'extensions/agent-workflow';
const agents = ['workflow-plan', 'workflow-implement', 'workflow-test', 'workflow-review'];
const modules = ['extension', 'controller', 'state-store', 'adapter'];

async function put(root, relative, content) {
  const filename = path.join(root, relative);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, content);
}

async function removeFixture(root) {
  const stat = await fs.lstat(root);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const name of await fs.readdir(root)) await removeFixture(path.join(root, name));
    await fs.rmdir(root);
  } else {
    await fs.unlink(root);
  }
}

async function tree(root) {
  const files = {};
  async function walk(directory, prefix = '') {
    for (const name of (await fs.readdir(directory)).sort()) {
      if (name === '.git') continue;
      const relative = prefix ? `${prefix}/${name}` : name;
      const filename = path.join(directory, name);
      const stat = await fs.lstat(filename);
      if (stat.isSymbolicLink()) files[relative] = `symlink:${await fs.readlink(filename)}`;
      else if (stat.isDirectory()) await walk(filename, relative);
      else files[relative] = (await fs.readFile(filename)).toString('base64');
    }
  }
  await walk(root);
  return files;
}

async function fixture(t) {
  // Test scratch data stays inside the worktree, never in an OS temp directory.
  const root = await fs.mkdtemp(path.join(process.cwd(), '.install-test-'));
  t.after(() => removeFixture(root));
  const target = path.join(root, 'target repo with spaces');
  const source = path.join(root, 'plugin source with spaces');
  await fs.mkdir(target);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  await run('git', ['init', '--quiet', target], { env, windowsHide: true });
  await put(source, 'plugin.json', JSON.stringify({ name: PLUGIN_NAME, version: '0.1.0' }));
  for (const agent of agents) await put(source, `agents/${agent}.agent.md`, `---\nname: ${agent}\n---\nFixture ${agent}.\n`);
  for (const module of modules) await put(source, `${sourceExtension}/${module}.mjs`, `export const name = ${JSON.stringify(module)};\n`);
  return { root, target, source };
}

async function manifest(target) {
  return JSON.parse(await fs.readFile(path.join(target, MANIFEST_PATH), 'utf8'));
}

async function hasFile(root, relative) {
  try {
    await fs.lstat(path.join(root, relative));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function symlinkOrSkip(t, destination, link, type = 'file') {
  try {
    await fs.symlink(destination, link, type);
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      t.skip(`Symlinks unavailable: ${error.code}`);
      return false;
    }
    throw error;
  }
}

test('installs in paths with spaces, hashes exact bytes, and repeated install is a no-op', async (t) => {
  const options = await fixture(t);
  const { target } = options;
  assert.deepEqual(await install(options), { action: 'installed', version: '0.1.0', files: 8 });
  const first = await tree(target);
  const installed = await manifest(target);
  assert.equal(installed.plugin, PLUGIN_NAME);
  assert.equal(installed.schemaVersion, 1);
  assert.equal(installed.files.length, 8);
  assert.ok(!JSON.stringify(installed).includes(options.root));
  for (const entry of installed.files) {
    assert.equal(entry.sha256, sha256(await fs.readFile(path.join(target, entry.path))));
  }
  const beforeStat = await fs.stat(path.join(target, MANIFEST_PATH));
  assert.deepEqual(await install(options), { action: 'unchanged', version: '0.1.0', files: 8 });
  assert.deepEqual(await update(options), { action: 'unchanged', version: '0.1.0', files: 8 });
  assert.deepEqual(await tree(target), first);
  assert.equal((await fs.stat(path.join(target, MANIFEST_PATH))).mtimeMs, beforeStat.mtimeMs);
  const report = await doctor({ target });
  assert.equal(report.ok, true);
  assert.match(report.runtime, /cannot prove.*authentication.*runtime SDK/);
  assert.match(report.runtime, /live workflow_status/);
});

test('discovers extension subtree dynamically and updates versions, changed, added, and removed files', async (t) => {
  const options = await fixture(t);
  const { target, source } = options;
  await put(source, `${sourceExtension}/obsolete.mjs`, 'old extra');
  await put(source, `${sourceExtension}/assets/template.json`, '{"template":true}');
  await install(options);
  await put(target, '.github/settings.json', '{"unrelated":true}');
  await put(target, `${extensionDir}/user-notes.txt`, 'keep this');
  await put(target, `${agentDir}/unrelated.agent.md`, 'user agent');
  await put(target, 'working-file.txt', 'uncommitted work');
  await put(source, 'plugin.json', JSON.stringify({ name: PLUGIN_NAME, version: '0.2.0-beta.1' }));
  await put(source, `${sourceExtension}/extension.mjs`, 'updated extension');
  await put(source, `${sourceExtension}/nested/new.mjs`, 'new dynamic module');
  await fs.unlink(path.join(source, sourceExtension, 'obsolete.mjs'));
  assert.equal((await update(options)).action, 'updated');
  assert.equal((await manifest(target)).version, '0.2.0-beta.1');
  assert.equal(await hasFile(target, `${extensionDir}/obsolete.mjs`), false);
  assert.equal(await fs.readFile(path.join(target, extensionFile), 'utf8'), 'updated extension');
  assert.equal(await fs.readFile(path.join(target, extensionDir, 'nested/new.mjs'), 'utf8'), 'new dynamic module');
  assert.equal((await doctor({ target })).ok, true);
  assert.equal((await uninstall({ target })).action, 'uninstalled');
  assert.deepEqual(await tree(target), {
    '.github/agents/unrelated.agent.md': Buffer.from('user agent').toString('base64'),
    '.github/extensions/agent-workflow/user-notes.txt': Buffer.from('keep this').toString('base64'),
    '.github/settings.json': Buffer.from('{"unrelated":true}').toString('base64'),
    'working-file.txt': Buffer.from('uncommitted work').toString('base64'),
  });
  assert.deepEqual(await uninstall({ target }), { action: 'absent', files: 0 });
});

test('uninstall without a manifest preserves unmanaged local copies', async (t) => {
  const { target } = await fixture(t);
  await put(target, agentFile, 'unmanaged agent');
  const before = await tree(target);
  assert.equal((await uninstall({ target })).action, 'absent');
  assert.deepEqual(await tree(target), before);
  assert.equal((await doctor({ target })).ok, false);
});

for (const mutation of ['modified', 'missing']) {
  for (const operation of ['update', 'uninstall']) {
    test(`${operation} refuses ${mutation} owned files without any writes`, async (t) => {
      const options = await fixture(t);
      await install(options);
      if (mutation === 'modified') await put(options.target, agentFile, 'user modifications');
      else await fs.unlink(path.join(options.target, agentFile));
      await put(options.source, `${sourceExtension}/extension.mjs`, 'would update');
      const before = await tree(options.target);
      await assert.rejects(operation === 'update' ? update(options) : uninstall(options), new RegExp(`Owned file (?:was|is) ${mutation}`));
      assert.deepEqual(await tree(options.target), before);
      assert.equal((await doctor(options)).ok, false);
    });
  }
}

test('preflights the entire install before creating any copies on collision', async (t) => {
  const options = await fixture(t);
  await put(options.target, extensionFile, await fs.readFile(path.join(options.source, sourceExtension, 'extension.mjs')));
  const before = await tree(options.target);
  await assert.rejects(install(options), /Unmanaged file collision/);
  assert.deepEqual(await tree(options.target), before);
  assert.equal(await hasFile(options.target, agentDir), false);
});

test('update refuses a newly introduced collision and preserves all existing files', async (t) => {
  const options = await fixture(t);
  await install(options);
  await put(options.source, `${sourceExtension}/extra.mjs`, 'new source');
  await put(options.source, `${sourceExtension}/extension.mjs`, 'would update');
  await put(options.target, `${extensionDir}/extra.mjs`, 'unmanaged');
  const before = await tree(options.target);
  await assert.rejects(update(options), /Unmanaged file collision/);
  assert.deepEqual(await tree(options.target), before);
});

const badManifestEdits = [
  ['parent traversal', (value) => { value.files[0].path = '../../outside.txt'; }],
  ['absolute path', (value) => { value.files[0].path = '/outside.txt'; }],
  ['Windows traversal', (value) => { value.files[0].path = '.github\\agents\\..\\settings.json'; }],
  ['unowned settings', (value) => { value.files[0].path = '.github/settings.json'; }],
  ['unowned agent', (value) => { value.files[0].path = '.github/agents/personal.agent.md'; }],
  ['bad hash', (value) => { value.files[0].sha256 = 'not-a-hash'; }],
  ['duplicate paths', (value) => { value.files.push({ ...value.files[0] }); }],
  ['case collision', (value) => { value.files.push({ ...value.files.find((file) => file.path === extensionFile), path: `${extensionDir}/EXTENSION.mjs` }); }],
  ['wrong layout casing', (value) => { value.files.find((file) => file.path === extensionFile).path = `${extensionDir}/EXTENSION.mjs`; }],
  ['missing required layout', (value) => { value.files.pop(); }],
  ['wrong plugin', (value) => { value.plugin = 'other-plugin'; }],
  ['wrong schema', (value) => { value.schemaVersion = 99; }],
  ['unexpected metadata', (value) => { value.target = '/not-portable'; }],
  ['reserved Windows name', (value) => { value.files.push({ path: `${extensionDir}/CON.txt`, sha256: '0'.repeat(64) }); }],
  ['file directory conflict', (value) => { value.files.push({ path: `${extensionFile}/nested.mjs`, sha256: '0'.repeat(64) }); }],
];

for (const [label, mutate] of badManifestEdits) {
  test(`rejects a tampered manifest: ${label}`, async (t) => {
    const options = await fixture(t);
    await install(options);
    const value = await manifest(options.target);
    mutate(value);
    await put(options.target, MANIFEST_PATH, JSON.stringify(value));
    const before = await tree(options.target);
    await assert.rejects(update(options));
    await assert.rejects(uninstall(options));
    assert.deepEqual(await tree(options.target), before);
    assert.equal((await doctor(options)).ok, false);
  });
}

test('rejects malformed JSON and manifest directories without mutation', async (t) => {
  const options = await fixture(t);
  await put(options.target, MANIFEST_PATH, '{broken');
  let before = await tree(options.target);
  await assert.rejects(install(options), /manifest JSON/);
  assert.deepEqual(await tree(options.target), before);
  await fs.unlink(path.join(options.target, MANIFEST_PATH));
  await fs.mkdir(path.join(options.target, MANIFEST_PATH));
  before = await tree(options.target);
  await assert.rejects(install(options), /regular file/);
  assert.deepEqual(await tree(options.target), before);
});

test('rejects a directory in place of an owned file and a file in place of a parent', async (t) => {
  const options = await fixture(t);
  await fs.mkdir(path.join(options.target, agentFile), { recursive: true });
  await assert.rejects(install(options), /regular file/);
  await fs.rmdir(path.join(options.target, agentFile));
  await fs.rmdir(path.join(options.target, agentDir));
  await put(options.target, agentDir, 'not a directory');
  const before = await tree(options.target);
  await assert.rejects(install(options), /directory.*component/);
  assert.deepEqual(await tree(options.target), before);
});

for (const location of ['.github', '.github/agents', '.github/extensions', extensionDir, agentFile, MANIFEST_PATH]) {
  test(`refuses symlink target component ${location}`, async (t) => {
    const options = await fixture(t);
    const outside = path.join(options.root, 'outside');
    const isFile = [agentFile, MANIFEST_PATH].includes(location);
    if (isFile) await fs.writeFile(outside, 'outside content');
    else await fs.mkdir(outside);
    const link = path.join(options.target, location);
    await fs.mkdir(path.dirname(link), { recursive: true });
    if (!await symlinkOrSkip(t, outside, link, isFile ? 'file' : 'dir')) return;
    const before = await tree(options.target);
    await assert.rejects(install(options), /symlink/);
    assert.deepEqual(await tree(options.target), before);
    if (isFile) assert.equal(await fs.readFile(outside, 'utf8'), 'outside content');
    else assert.deepEqual(await fs.readdir(outside), []);
  });
}

test('update, uninstall and doctor reject an owned file replaced by a symlink', async (t) => {
  const options = await fixture(t);
  await install(options);
  const outside = path.join(options.root, 'outside.mjs');
  await fs.copyFile(path.join(options.target, extensionFile), outside);
  await fs.unlink(path.join(options.target, extensionFile));
  if (!await symlinkOrSkip(t, outside, path.join(options.target, extensionFile))) return;
  const before = await tree(options.target);
  await assert.rejects(update(options), /symlink/);
  await assert.rejects(uninstall(options), /symlink/);
  assert.equal((await doctor(options)).ok, false);
  assert.deepEqual(await tree(options.target), before);
});

test('refuses a symlink target root or ancestor', async (t) => {
  const options = await fixture(t);
  const link = path.join(options.root, 'linked target');
  if (!await symlinkOrSkip(t, options.target, link, 'dir')) return;
  await assert.rejects(install({ ...options, target: link }), /symlink/);
  const ancestor = path.join(options.root, 'linked parent');
  if (!await symlinkOrSkip(t, options.root, ancestor, 'dir')) return;
  await assert.rejects(install({ ...options, target: path.join(ancestor, path.basename(options.target)) }), /symlink/);
  await assert.rejects(install({
    ...options, target: `${ancestor}${path.sep}..${path.sep}${path.basename(options.target)}`,
  }), /symlink/);
});

test('refuses source symlinks instead of copying their contents', async (t) => {
  const options = await fixture(t);
  const outside = path.join(options.root, 'outside.mjs');
  await fs.writeFile(outside, 'outside');
  if (!await symlinkOrSkip(t, outside, path.join(options.source, sourceExtension, 'extra.mjs'))) return;
  await assert.rejects(install(options), /symlink/);
  assert.deepEqual(await tree(options.target), {});
});

test('rejects invalid targets, nested directories, and source/destination overlap', async (t) => {
  const options = await fixture(t);
  const nested = path.join(options.target, 'nested');
  await fs.mkdir(nested);
  const outside = path.join(options.root, 'not a repository');
  await fs.mkdir(outside);
  const notDirectory = path.join(options.root, 'file');
  await fs.writeFile(notDirectory, 'file');
  for (const target of ['', null, path.join(options.root, 'missing'), notDirectory, nested, outside]) {
    await assert.rejects(install({ ...options, target }));
    await assert.rejects(uninstall({ target }));
    assert.equal((await doctor({ target })).ok, false);
  }
  await assert.rejects(install({ ...options, source: options.target }), /overlap/);
  await assert.rejects(install({ ...options, source: path.join(options.target, extensionDir) }), /overlap/);
  assert.deepEqual(await tree(options.target), {});
});

test('supports linked Git worktrees without requiring a .git directory', async (t) => {
  const options = await fixture(t);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const hooksConfig = `core.hooksPath=${path.join(options.root, 'no-hooks')}`;
  await run('git', ['-C', options.target, '-c', hooksConfig, '-c', 'user.name=Installer Test', '-c', 'user.email=installer@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '--quiet', '-m', 'Fixture'], { env });
  const target = path.join(options.root, 'linked worktree');
  await run('git', ['-C', options.target, '-c', hooksConfig, 'worktree', 'add', '--quiet', '--detach', target], { env });
  assert.equal((await fs.lstat(path.join(target, '.git'))).isFile(), true);
  assert.equal((await install({ ...options, target })).action, 'installed');
  assert.equal((await doctor({ target })).ok, true);
  assert.equal((await uninstall({ target })).action, 'uninstalled');
});

test('rejects source plugin identity, incomplete layouts, and portable filename conflicts', async (t) => {
  const options = await fixture(t);
  await put(options.source, 'plugin.json', JSON.stringify({ name: 'other', version: '0.1.0' }));
  await assert.rejects(install(options), /must identify/);
  await put(options.source, 'plugin.json', JSON.stringify({ name: PLUGIN_NAME, version: '0.1.0' }));
  await fs.unlink(path.join(options.source, sourceExtension, 'adapter.mjs'));
  await assert.rejects(install(options), /Required file.*layout/);
  await put(options.source, `${sourceExtension}/adapter.mjs`, 'restored');
  await put(options.source, `${sourceExtension}/not portable.mjs`, 'not portable');
  await assert.rejects(install(options), /not portable/);
  assert.deepEqual(await tree(options.target), {});
});

test('rolls back a failed update and leaves no journal or stages', async (t) => {
  const options = await fixture(t);
  await install(options);
  const before = await tree(options.target);
  await put(options.source, 'agents/workflow-implement.agent.md', 'changed first agent');
  await put(options.source, 'agents/workflow-plan.agent.md', 'changed second agent');
  const originalRename = fs.rename;
  let calls = 0;
  const renameMock = mock.method(fs, 'rename', async (...args) => {
    calls += 1;
    if (calls === 2) throw Object.assign(new Error('Injected rename failure'), { code: 'EIO' });
    return originalRename(...args);
  });
  try {
    await assert.rejects(update(options), /changes were rolled back/);
  } finally {
    renameMock.mock.restore();
  }
  assert.deepEqual(await tree(options.target), before);
  assert.equal((await doctor(options)).ok, true);
  assert.equal((await update(options)).action, 'updated');
});

test('retains original bytes and blocks new mutations when rollback fails', async (t) => {
  const options = await fixture(t);
  await install(options);
  const original = await fs.readFile(path.join(options.target, `${agentDir}/workflow-implement.agent.md`));
  await put(options.source, 'agents/workflow-implement.agent.md', 'changed first agent');
  await put(options.source, 'agents/workflow-plan.agent.md', 'changed second agent');
  const originalRename = fs.rename;
  let calls = 0;
  const renameMock = mock.method(fs, 'rename', async (...args) => {
    calls += 1;
    if (calls >= 2) throw new Error('Injected persistent I/O failure');
    return originalRename(...args);
  });
  try {
    await assert.rejects(update(options), /recovery needs attention.*Recovery journal/);
  } finally {
    renameMock.mock.restore();
  }
  const journal = JSON.parse(await fs.readFile(path.join(options.target, TRANSACTION_PATH), 'utf8'));
  assert.ok(!JSON.stringify(journal).includes(options.root));
  const changed = journal.changes.find((entry) => entry.path === `${agentDir}/workflow-implement.agent.md`);
  assert.deepEqual(Buffer.from(changed.beforeBase64, 'base64'), original);
  assert.equal(changed.beforeSha256, sha256(original));
  const before = await tree(options.target);
  await assert.rejects(update(options), /interrupted or active/);
  await assert.rejects(uninstall(options), /interrupted or active/);
  assert.deepEqual(await tree(options.target), before);
  assert.equal((await doctor(options)).ok, false);
});

test('rolls back a failed first install without deleting unrelated files', async (t) => {
  const options = await fixture(t);
  await put(options.target, `${agentDir}/personal.agent.md`, 'personal');
  const before = await tree(options.target);
  const originalLink = fs.link;
  let calls = 0;
  const linkMock = mock.method(fs, 'link', async (...args) => {
    calls += 1;
    if (calls === 3) throw new Error('Injected link failure');
    return originalLink(...args);
  });
  try {
    await assert.rejects(install(options), /changes were rolled back/);
  } finally {
    linkMock.mock.restore();
  }
  assert.deepEqual(await tree(options.target), before);
  assert.equal((await install(options)).action, 'installed');
});

test('rolls back a failed uninstall and keeps the previous manifest', async (t) => {
  const options = await fixture(t);
  await install(options);
  const before = await tree(options.target);
  const originalUnlink = fs.unlink;
  let calls = 0;
  const unlinkMock = mock.method(fs, 'unlink', async (...args) => {
    calls += 1;
    if (calls === 3) throw new Error('Injected unlink failure');
    return originalUnlink(...args);
  });
  try {
    await assert.rejects(uninstall(options), /changes were rolled back/);
  } finally {
    unlinkMock.mock.restore();
  }
  assert.deepEqual(await tree(options.target), before);
  assert.equal((await doctor(options)).ok, true);
});

test('preserves a partial stage and journal if writing the stage fails', async (t) => {
  const options = await fixture(t);
  const originalOpen = fs.open;
  let injected = false;
  const openMock = mock.method(fs, 'open', async (filename, ...args) => {
    const handle = await originalOpen(filename, ...args);
    if (String(filename).endsWith('.stage') && !injected) {
      injected = true;
      const originalWrite = handle.writeFile.bind(handle);
      handle.writeFile = async () => {
        await originalWrite('partial');
        throw new Error('Injected partial write failure');
      };
    }
    return handle;
  });
  try {
    await assert.rejects(install(options), /recovery needs attention.*Staging file changed/);
  } finally {
    openMock.mock.restore();
  }
  assert.equal(await hasFile(options.target, MANIFEST_PATH), false);
  assert.equal(await hasFile(options.target, agentFile), false);
  const journal = JSON.parse(await fs.readFile(path.join(options.target, TRANSACTION_PATH), 'utf8'));
  assert.equal(await fs.readFile(path.join(options.target, journal.changes[0].stage), 'utf8'), 'partial');
  await assert.rejects(install(options), /interrupted or active/);
});

test('blocks overlapping installers with the exclusive recovery journal', async (t) => {
  const options = await fixture(t);
  const results = await Promise.allSettled([install(options), install(options)]);
  assert.ok(results.some((result) => result.status === 'fulfilled'));
  assert.equal((await doctor(options)).ok, true);
  for (const result of results.filter((result) => result.status === 'rejected')) {
    assert.match(result.reason.message, /interrupted or active|acquire installation journal/);
  }
  assert.equal(await hasFile(options.target, TRANSACTION_PATH), false);
});

test('a concurrent edit detected after staging is preserved without applying updates', async (t) => {
  const options = await fixture(t);
  await install(options);
  await put(options.source, `${sourceExtension}/extension.mjs`, 'new extension');
  const originalOpen = fs.open;
  let edited = false;
  const openMock = mock.method(fs, 'open', async (filename, ...args) => {
    const handle = await originalOpen(filename, ...args);
    if (String(filename).endsWith('.stage') && !edited) {
      edited = true;
      await fs.writeFile(path.join(options.target, agentFile), 'concurrent user edit');
    }
    return handle;
  });
  try {
    await assert.rejects(update(options), /File changed during installation/);
  } finally {
    openMock.mock.restore();
  }
  assert.equal(await fs.readFile(path.join(options.target, agentFile), 'utf8'), 'concurrent user edit');
  assert.notEqual(await fs.readFile(path.join(options.target, extensionFile), 'utf8'), 'new extension');
  assert.equal(await hasFile(options.target, TRANSACTION_PATH), false);
});

test('checks staging hashes before publishing and preserves a tampered stage for recovery', async (t) => {
  const options = await fixture(t);
  const originalOpen = fs.open;
  let firstStage;
  let tampered = false;
  const openMock = mock.method(fs, 'open', async (filename, ...args) => {
    const handle = await originalOpen(filename, ...args);
    if (String(filename).endsWith('.stage') && args[0] === 'wx') {
      if (!firstStage) firstStage = filename;
      else if (!tampered) {
        tampered = true;
        await fs.writeFile(firstStage, 'tampered stage');
      }
    }
    return handle;
  });
  try {
    await assert.rejects(install(options), /recovery needs attention.*File changed during installation/);
  } finally {
    openMock.mock.restore();
  }
  assert.equal(await hasFile(options.target, agentFile), false);
  assert.equal(await hasFile(options.target, MANIFEST_PATH), false);
  assert.equal(await fs.readFile(firstStage, 'utf8'), 'tampered stage');
  assert.equal(await hasFile(options.target, TRANSACTION_PATH), true);
});

test('Node version guard and doctor report unsupported Node versions', async (t) => {
  const { target } = await fixture(t);
  assert.throws(() => assertNodeVersion('20.19.0'), /Node.js >=22/);
  assert.doesNotThrow(() => assertNodeVersion('22.0.0'));
  const report = await doctor({ target, nodeVersion: '20.19.0' });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.name === 'Node.js >=22').ok, false);
});

test('CLI help, argument validation, exit codes, and cwd-independent script location', async (t) => {
  const { target } = await fixture(t);
  assert.ok(CANONICAL_SOURCE.endsWith(`${path.sep}plugins${path.sep}agent-workflow-demo${path.sep}`));
  const help = await run(process.execPath, [cli, '--help'], { cwd: target });
  assert.match(help.stdout, /target defaults to the current working directory/);
  assert.match(help.stdout, /update is an alias/);
  for (const args of [['unknown'], ['install', '--source', target], ['install', '--target'], ['install', '--target', target, '--target', target]]) {
    await assert.rejects(run(process.execPath, [cli, ...args], { cwd: target }), (error) => error.code === 1 && /Error:/.test(error.stderr));
  }
  await assert.rejects(run(process.execPath, [cli, 'doctor'], { cwd: target }), (error) => error.code === 1 && /No installation manifest/.test(error.stdout));
  const removed = await run(process.execPath, [cli, 'uninstall', '--target', target], { cwd: target });
  assert.match(removed.stdout, /absent/);
});
