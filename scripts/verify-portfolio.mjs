import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { handlePortfolio } from '../lib/portfolio.mjs';

const migration = await readFile(new URL('../drizzle/0001_portfolio.sql', import.meta.url), 'utf8');
const courseOrigin = 'https://course.test';
const path = '/api/portfolio';
const maxBytes = 4 * 1024 * 1024;

function form({ caseId = 'discovery-case', title = 'Evidence and launch plan', demoUrl, file } = {}) {
  const data = new FormData();
  data.set('caseId', caseId);
  data.set('title', title);
  if (demoUrl !== undefined) data.set('demoUrl', demoUrl);
  if (file !== undefined) data.set('file', file);
  return data;
}

function fixture(context) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(migration);
  context.after(() => sql.close());

  const objects = new Map();
  const failures = { write: null, delete: false, put: false };
  const db = { prepare(query) {
    const statement = sql.prepare(query);
    return { bind(...values) {
      return {
        first: () => statement.get(...values) ?? null,
        all: () => ({ results: statement.all(...values) }),
        run: () => {
          const fail = query.startsWith('INSERT INTO portfolio_entries') && failures.write;
          if (fail === 'before') throw new Error('Insert rejected');
          const result = statement.run(...values);
          if (fail === 'after') throw new Error('Result lost after commit');
          return { meta: { changes: result.changes } };
        },
      };
    } };
  } };
  const bucket = {
    async put(key, file) {
      objects.set(key, new Blob([await file.arrayBuffer()]));
      if (failures.put) throw new Error('Object write result lost');
    },
    async get(key) {
      const object = objects.get(key);
      return object ? { body: object.stream() } : null;
    },
    async delete(key) {
      if (failures.delete) throw new Error('Object delete unavailable');
      objects.delete(key);
    },
  };

  function call({ method = 'GET', id, user = 'learner-a', origin = courseOrigin, body, key, useBucket = true } = {}) {
    const headers = new Headers();
    if (user !== null) headers.set('oai-authenticated-user-id', user);
    if (origin !== null && method !== 'GET') headers.set('Origin', origin);
    if (key) headers.set('Idempotency-Key', key);
    return handlePortfolio(new Request(courseOrigin + path + (id ? `/${id}` : ''), { method, headers, body }), db, useBucket ? bucket : null);
  }

  return { call, objects, failures, sql };
}

test('requires an authenticated user and same-origin writes', async (context) => {
  const { call } = fixture(context);
  assert.equal((await call({ user: null })).status, 401);
  for (const origin of ['https://elsewhere.test', null]) {
    assert.equal((await call({ method: 'POST', origin, body: form({ demoUrl: 'https://example.com' }) })).status, 403);
    assert.equal((await call({ method: 'DELETE', origin, id: crypto.randomUUID() })).status, 403);
  }
  assert.equal((await call({ method: 'PATCH' })).headers.get('Allow'), 'GET, POST');
});

test('stores link-only metadata and rejects unsafe or repeated input', async (context) => {
  const { call } = fixture(context);
  for (const demoUrl of ['javascript:alert(1)', 'http://example.com', 'https://alice:pass@example.com', 'not a URL', '']) {
    assert.equal((await call({ method: 'POST', body: form({ demoUrl }) })).status, 400);
  }
  const repeated = form({ demoUrl: 'https://example.com' });
  repeated.append('title', 'Second title');
  assert.equal((await call({ method: 'POST', body: repeated })).status, 400);
  assert.equal((await call({ method: 'POST', body: form({ caseId: '../other', demoUrl: 'https://example.com' }) })).status, 400);
  const response = await call({ method: 'POST', body: form({ demoUrl: 'https://example.com' }), useBucket: false });
  assert.equal(response.status, 201);
  const row = await response.json();
  assert.deepEqual(Object.keys(row).sort(), ['case_id', 'created_at', 'demo_url', 'filename', 'id', 'size', 'title']);
  assert.equal(row.demo_url, 'https://example.com/');
  assert.equal(row.filename, null);
  assert.equal(row.size, 0);
  assert.deepEqual((await (await call({ useBucket: false })).json()).entries, [row]);
  assert.equal((await call({ id: row.id })).status, 404);
});

test('serves only owned uploads as private binary attachments and deletes idempotently', async (context) => {
  const { call, objects } = fixture(context);
  const data = '<script>alert(1)</script>';
  const response = await call({ method: 'POST', body: form({ file: new File([data], 'Caf\u00e9.html', { type: 'text/html' }) }) });
  assert.equal(response.status, 201);
  const entry = await response.json();
  assert.equal(entry.filename, 'Caf\u00e9.html');
  assert.equal(entry.size, data.length);
  assert.equal(objects.size, 1);
  assert.deepEqual(await (await call({ user: 'learner-b' })).json(), { entries: [] });
  assert.equal((await call({ id: entry.id, user: 'learner-b' })).status, 404);
  await call({ method: 'DELETE', id: entry.id, user: 'learner-b' });
  const file = await call({ id: entry.id });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('Cache-Control'), 'no-store');
  assert.equal(file.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(file.headers.get('Content-Type'), 'application/octet-stream');
  assert.match(file.headers.get('Content-Disposition'), /^attachment;.*filename\*=UTF-8''Caf%C3%A9\.html$/);
  assert.equal(await file.text(), data);
  for (let index = 0; index < 2; index++) {
    assert.deepEqual(await (await call({ method: 'DELETE', id: entry.id })).json(), { deleted: true });
  }
  assert.equal((await call({ id: entry.id })).status, 404);
  assert.equal(objects.size, 0);
});

test('accepts a 4 MiB file and rejects oversized file and streamed body', async (context) => {
  const { call, objects } = fixture(context);
  for (const size of [maxBytes, maxBytes + 1, maxBytes + 128 * 1024]) {
    const result = await call({ method: 'POST', body: form({ file: new File([new Uint8Array(size)], 'draft.bin') }) });
    assert.equal(result.status, size === maxBytes ? 201 : 413);
  }
  assert.equal(objects.size, 1);
  assert.equal((await call({ method: 'POST', body: form({ file: new File([], 'empty.txt') }) })).status, 400);
});

test('enforces the per-user cap during concurrent writes and deduplicates an upload retry', async (context) => {
  const { call, objects } = fixture(context);
  const file = () => new File(['draft'], 'case.txt');
  const request = () => call({ method: 'POST', body: form({ file: file() }), key: 'one-action' });
  const results = await Promise.all([request(), request(), request()]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 200, 201]);
  const [first, ...replays] = await Promise.all(results.map((result) => result.json()));
  for (const replay of replays) assert.deepEqual(replay, first);
  assert.equal(objects.size, 1);

  const upload = () => call({ method: 'POST', body: form({ file: file() }) });
  const extra = await Promise.all(Array.from({ length: 22 }, upload));
  assert.equal(extra.filter((result) => result.status === 201).length, 19);
  assert.equal(extra.filter((result) => result.status === 409).length, 3);
  assert.equal(objects.size, 20);
  assert.equal((await (await call()).json()).entries.length, 20);
  assert.equal((await request()).status, 200);
  assert.equal((await call({ method: 'POST', user: 'learner-b', body: form({ demoUrl: 'https://example.com' }) })).status, 201);
});

test('preserves committed files when the database acknowledgement is lost', async (context) => {
  const { call, objects, failures } = fixture(context);
  const upload = (key) => call({ method: 'POST', key, body: form({ file: new File(['case'], 'case.txt') }) });
  failures.put = true;
  assert.equal((await upload('put-fails')).status, 503);
  assert.equal(objects.size, 0);
  failures.put = false;
  failures.write = 'before';
  assert.equal((await upload('insert-fails')).status, 503);
  assert.equal(objects.size, 0);
  failures.write = 'after';
  const response = await upload('response-lost');
  assert.equal(response.status, 200);
  assert.equal(objects.size, 1);
  assert.deepEqual(await (await upload('response-lost')).json(), await response.json());
});

test('hides pending deletion and retries private file cleanup on the next upload', async (context) => {
  const { call, objects, failures, sql } = fixture(context);
  const created = await call({ method: 'POST', body: form({ file: new File(['case'], 'case.txt') }) });
  const { id } = await created.json();
  failures.delete = true;
  assert.equal((await call({ method: 'DELETE', id })).status, 503);
  assert.deepEqual(await (await call()).json(), { entries: [] });
  assert.equal((await call({ id })).status, 404);
  assert.equal(objects.size, 1);
  failures.delete = false;
  assert.equal((await call({ method: 'POST', body: form({ demoUrl: 'https://example.com' }) })).status, 201);
  assert.equal(objects.size, 0);
  assert.equal(sql.prepare('SELECT COUNT(*) AS total FROM portfolio_entries').get().total, 1);
});

