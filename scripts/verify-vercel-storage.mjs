import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createVercelStorage } from '../lib/vercel-storage.mjs';

class BlobPreconditionFailedError extends Error {}

function mockBlob() {
  const objects = new Map();
  let nextEtag = 0;
  let fault;
  let conflicts = 0;
  return {
    objects,
    BlobPreconditionFailedError,
    failAfterWrite(error) { fault = error; },
    get conflicts() { return conflicts; },
    async get(key, options) {
      assert.equal(options.access, 'private');
      assert.equal(options.useCache, false);
      const object = objects.get(key);
      await delay(1);
      if (!object) return null;
      return { statusCode: 200, stream: new Blob([object.bytes]).stream(), blob: { etag: object.etag, size: object.bytes.length } };
    },
    async put(key, body, options) {
      assert.equal(options.access, 'private');
      assert.equal(options.addRandomSuffix, false);
      const bytes = Buffer.from(await new Response(body).arrayBuffer());
      const current = objects.get(key);
      if (current && !options.allowOverwrite) {
        conflicts++;
        throw new Error('This blob already exists.');
      }
      if (options.ifMatch && current?.etag !== options.ifMatch) {
        conflicts++;
        throw new BlobPreconditionFailedError('ETag mismatch.');
      }
      const etag = `"mock-${++nextEtag}"`;
      objects.set(key, { bytes, etag });
      if (fault && options.ifMatch) {
        const error = fault;
        fault = null;
        throw error;
      }
      return { etag };
    },
    async del(key) { objects.delete(key); },
  };
}

const increment = (database, user, cap = 20) => database.prepare(`INSERT INTO tutor_usage (user_id, day, count)
  VALUES (?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1 WHERE count < ? RETURNING count`)
  .bind(user, '2026-01-01', cap).first();

test('runs existing migrations, exposes D1 results, and keeps data across adapter instances', async () => {
  const blob = mockBlob();
  const first = createVercelStorage(blob);
  const second = createVercelStorage(blob);

  assert.deepEqual(await first.DB.prepare('SELECT * FROM attempts').bind().all(), { results: [] });
  assert.equal(blob.objects.size, 0);
  const inserted = await first.DB.prepare('INSERT INTO attempts (id, user_id, items_json, created_at) VALUES (?, ?, ?, ?)')
    .bind('attempt-1', 'learner-1', '[]', 10).run();
  assert.equal(inserted.meta.changes, 1);
  const attempt = await second.DB.prepare('SELECT id FROM attempts WHERE user_id = ?').bind('learner-1').first();
  assert.equal(attempt.id, 'attempt-1');
  assert.equal(await second.DB.prepare('SELECT id FROM attempts WHERE user_id = ?').bind('learner-2').first(), null);
  assert.deepEqual(await second.DB.prepare('SELECT * FROM portfolio_entries').bind().all(), { results: [] });
  assert.equal((await increment(second.DB, 'learner-1')).count, 1);
});

test('retries concurrent initial and conditional writes without exceeding a cap', async () => {
  const blob = mockBlob();
  const workers = Array.from({ length: 4 }, () => createVercelStorage(blob).DB);
  const counters = await Promise.all(workers.map((db) => increment(db, 'same-user', 3)));
  assert.ok(blob.conflicts > 0, 'The mock must exercise an actual write conflict.');
  assert.deepEqual(counters.map((row) => row?.count ?? 0).sort((a, b) => a - b), [0, 1, 2, 3]);
  const final = await workers[0].prepare('SELECT count FROM tutor_usage WHERE user_id = ?').bind('same-user').first();
  assert.equal(final.count, 3);
});

test('recovers acknowledged-late writes without applying the same statement twice', async () => {
  const blob = mockBlob();
  const { DB } = createVercelStorage(blob);
  await increment(DB, 'same-user');

  blob.failAfterWrite(new BlobPreconditionFailedError('The retry received a stale ETag.'));
  assert.equal((await increment(DB, 'same-user')).count, 2);
  blob.failAfterWrite(new Error('The transport lost the successful response.'));
  assert.equal((await increment(DB, 'same-user')).count, 3);

  assert.equal((await DB.prepare('SELECT count FROM tutor_usage WHERE user_id = ?').bind('same-user').first()).count, 3);
});

test('keeps attachment blobs private and isolates namespaces', async () => {
  const blob = mockBlob();
  const prod = createVercelStorage(blob, { prefix: 'course/production' });
  const preview = createVercelStorage(blob, { prefix: 'course/preview' });
  const key = 'portfolio/7a59a53b-f4f0-4576-99e5-8d43646d7631';
  await prod.BUCKET.put(key, new File(['Example attachment'], 'test.txt'));
  assert.equal(await new Response((await prod.BUCKET.get(key)).body).text(), 'Example attachment');
  assert.equal(await preview.BUCKET.get(key), null);
  assert.throws(() => prod.BUCKET.delete('course.sqlite'), /Invalid portfolio object key/);
  await prod.BUCKET.delete(key);
  await prod.BUCKET.delete(key);
  assert.equal(await prod.BUCKET.get(key), null);

  await increment(prod.DB, 'same-user');
  assert.equal(await preview.DB.prepare('SELECT count FROM tutor_usage WHERE user_id = ?').bind('same-user').first(), null);
});
