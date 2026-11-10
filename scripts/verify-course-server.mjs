import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createCourseHandler } from '../lib/course-server.mjs';

const origin = 'https://pm-course.test';
const accessCode = Buffer.alloc(32, 21).toString('base64url');
const accessHash = createHash('sha256').update(accessCode).digest('hex');
const bank = Array.from({ length: 30 }, (_, i) => ({
  id: `example-${i}`, module: Math.floor(i / 3) + 1, prompt: `Fixture question ${i}`,
  options: ['One', 'Two', 'Three', 'Four'], correct: 1, rationale: 'Test fixture.',
}));

async function createFixture(context) {
  const sql = new DatabaseSync(':memory:');
  context.after(() => sql.close());
  for (const name of ['0000_learning', '0001_portfolio', '0002_tutor']) {
    sql.exec(await readFile(new URL(`../drizzle/${name}.sql`, import.meta.url), 'utf8'));
  }
  const DB = { prepare(query) {
    return { bind(...values) {
      const stmt = sql.prepare(query);
      return { first: () => stmt.get(...values) ?? null, all: () => ({ results: stmt.all(...values) }), run: () => stmt.run(...values) };
    } };
  } };
  const bucket = new Map();
  const BUCKET = {
    async put(key, value) { bucket.set(key, new Uint8Array(await new Response(value).arrayBuffer())); },
    async get(key) {
      const bytes = bucket.get(key);
      return bytes ? { body: new Response(bytes).body, size: bytes.length } : null;
    },
    async delete(key) { bucket.delete(key); },
  };
  const handle = createCourseHandler({ DB, BUCKET, secure: true, accessHash, examBank: JSON.stringify(bank) });
  const signIn = await handle(new Request(`${origin}/access`, { method: 'POST', headers: { origin }, body: new URLSearchParams({ code: accessCode }) }));
  assert.equal(signIn.status, 303);
  const cookie = signIn.headers.get('set-cookie').split(';')[0];
  function call(path, options = {}, authorized = true) {
    return handle(new Request(`${origin}${path}`, { ...options, headers: { ...options.headers, origin, ...(authorized ? { cookie } : {}) } }));
  }
  return { call, sql };
}

test('protects assets and APIs and keeps the exam bank server-side', async (context) => {
  const { call } = await createFixture(context);
  const locked = await call('/', {}, false);
  assert.ok([302, 303].includes(locked.status));
  assert.notEqual((await call('/course-content.json', {}, false)).status, 200);
  assert.equal((await call('/api/learning', { headers: { 'oai-authenticated-user-id': 'spoof' } }, false)).status, 401);
  const home = await call('/');
  assert.match(await home.text(), /PM Learning Lab/);
  assert.equal(home.headers.get('cache-control'), 'private, no-store');
  for (const path of ['/course-app.js', '/course-studio.js', '/study-chat.css', '/course-content.json', '/certificate.js']) {
    assert.equal((await call(path)).status, 200, path);
  }
  assert.equal((await call('/data/exam-bank.json')).status, 404);
  const start = await (await call('/api/learning/start', { method: 'POST' })).json();
  assert.equal(start.questions.length, 10);
  assert.ok(start.questions.every((q) => !Object.hasOwn(q, 'correct') && !Object.hasOwn(q, 'rationale')));
});

test('runs course chat and private portfolio with the same signed-in course session', async (context) => {
  const { call, sql } = await createFixture(context);
  const question = await call('/api/tutor', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'What is this lesson about?', focus: '#lesson/11/0' }) });
  const answer = await question.json();
  assert.equal(answer.sources[0].href, '#lesson/11/0');
  assert.ok(answer.answer);
  const form = new FormData();
  form.set('caseId', 'delivery-window');
  form.set('title', 'Vercel fixture');
  form.set('file', new File(['one,two\n1,2'], 'fixture.csv', { type: 'text/csv' }));
  const saved = await call('/api/portfolio', { method: 'POST', body: form, headers: { 'oai-authenticated-user-id': 'spoof' } });
  assert.equal(saved.status, 201);
  const entry = await saved.json();
  assert.equal(sql.prepare('SELECT user_id FROM portfolio_entries').get().user_id, 'course-owner');
  assert.equal(await (await call(`/api/portfolio/${entry.id}`)).text(), 'one,two\n1,2');
  assert.equal((await call(`/api/portfolio/${entry.id}`, {}, false)).status, 401);
});
