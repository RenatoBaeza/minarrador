import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DiskScan, AbortError, sizeOnDisk, isWithin, type DiskEntry } from '../src/main/diskusage';

function tmpDir(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minarrador-disk-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Writes `bytes` of filler to a file, creating its folders on the way. */
function file(root: string, rel: string, bytes: number): string {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(bytes));
  return full;
}

const byName = (entries: DiskEntry[] | null): Record<string, DiskEntry> => Object.fromEntries((entries ?? []).map((e) => [e.name, e]));

test('sizeOnDisk rounds up to the cluster, and an empty file takes none', () => {
  assert.equal(sizeOnDisk({ size: 0, blksize: 0 }), 0);
  assert.equal(sizeOnDisk({ size: 1, blksize: 0 }), 4096);
  assert.equal(sizeOnDisk({ size: 4097, blksize: 0 }), 8192);
  assert.equal(sizeOnDisk({ size: 1, blksize: 512 }), 512);
});

test('isWithin treats a folder as inside itself and ignores case', () => {
  assert.ok(isWithin('C:\\Notes', 'C:\\Notes'));
  assert.ok(isWithin('C:\\Notes', 'c:\\notes\\2026-08-11'));
  assert.ok(!isWithin('C:\\Notes', 'C:\\Notes-old'));
  assert.ok(!isWithin('C:\\Notes\\a', 'C:\\Notes'));
});

test('a walk totals every folder, and a listing is largest first', async (t) => {
  const root = tmpDir(t);
  file(root, 'big/a.bin', 10_000);
  file(root, 'big/deep/b.bin', 5_000);
  file(root, 'small/c.bin', 100);
  file(root, 'loose.bin', 1);

  const scan = new DiskScan(root);
  const counts = await scan.walk();
  assert.deepEqual(counts, { files: 4, dirs: 4 });

  const top = scan.rootEntry();
  assert.equal(top.size, 12_288 + 8192 + 4096 + 4096);

  const entries = await scan.list(top.id);
  assert.ok(entries);
  assert.equal(entries[0].name, 'big');
  for (let i = 1; i < entries.length; i++) assert.ok(entries[i - 1].size >= entries[i].size);
  const { big } = byName(entries);
  assert.equal(big.size, 12_288 + 8192);
  assert.equal(big.hasChildren, true);

  const inside = byName(await scan.list(big.id));
  assert.equal(inside.deep.size, 8192);
  assert.equal(inside['a.bin'].isDirectory, false);
});

test('ids carry no path, and one from another scan resolves to nothing', async (t) => {
  const root = tmpDir(t);
  file(root, 'x/y.bin', 10);
  const scan = new DiskScan(root);
  await scan.walk();
  const entries = await scan.list(scan.rootEntry().id);
  assert.ok(entries);
  for (const entry of entries) {
    assert.equal(typeof entry.id, 'number');
    assert.ok(!Object.values(entry).some((v) => typeof v === 'string' && v.includes(root)));
  }

  const other = new DiskScan(root);
  assert.equal(await other.list(entries[0].id), null);
  assert.equal(other.resolve(9999), null);
  // A file is not a folder to list.
  const f = file(root, 'z.bin', 10);
  const listed = byName(await scan.list(scan.rootEntry().id));
  assert.equal(scan.resolve(listed['z.bin'].id)?.path, f);
  assert.equal(await scan.list(listed['z.bin'].id), null);
});

test('forget takes an entry off every folder above it', async (t) => {
  const root = tmpDir(t);
  file(root, 'a/b/gone.bin', 5000);
  file(root, 'a/b/kept.bin', 10);
  const scan = new DiskScan(root);
  await scan.walk();
  const rootId = scan.rootEntry().id;
  const a = byName(await scan.list(rootId)).a;
  const b = byName(await scan.list(a.id)).b;
  const gone = byName(await scan.list(b.id))['gone.bin'];

  scan.forget(gone.id);
  assert.equal(scan.resolve(gone.id), null);
  assert.equal(byName(await scan.list(rootId)).a.size, 4096);
  assert.equal(scan.rootEntry().size, 4096);

  // A folder going takes its own totals with it.
  scan.forget(b.id);
  assert.equal(byName(await scan.list(rootId)).a.size, 0);
  assert.ok(![...scan.dirSizes.keys()].some((dir) => isWithin(path.join(root, 'a', 'b'), dir)));
});

test('an aborted walk stops with an AbortError', async (t) => {
  const root = tmpDir(t);
  file(root, 'a/b.bin', 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(new DiskScan(root).walk({ signal: controller.signal }), AbortError);
});
