import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createCourseHandler } from '../lib/course-server.mjs';

const origin = 'https://pm-course.test';
const visitorCookieName = '__Host-pm_learning_visitor';
const visitorCookiePattern = /^__Host-pm_learning_visitor=[a-f0-9]{64}$/;
const ownerPortfolioId = '12345678-1234-4321-8123-0123456789ab';
const ownerFileKey = `portfolio/${ownerPortfolioId}`;
const ownerCookie = `__Host-pm_learning_access=${Buffer.alloc(32, 21).toString('base64url')}`;
const ownerHeaders = { 'oai-authenticated-user-id': 'course-owner' };
const bank = Array.from({ length: 30 }, (_, i) => ({
  id: `example-${i}`, module: Math.floor(i / 3) + 1, prompt: `Fixture question ${i}`,
  options: ['One', 'Two', 'Three', 'Four'], correct: 1, rationale: 'Test fixture.',
}));
const emptyLearningState = { attempt: null, result: null, eligible: false, certificate: null };

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

  const now = Date.now();
  sql.prepare('INSERT INTO attempts (id, user_id, items_json, created_at, score, answers_json) VALUES (?, ?, ?, ?, ?, ?)')
    .run('owner-attempt', 'course-owner', JSON.stringify(bank.slice(0, 10)), now, 10, JSON.stringify(Array(10).fill(1)));
  sql.prepare('INSERT INTO certificates (user_id, id, name, score, awarded_at) VALUES (?, ?, ?, ?, ?)')
    .run('course-owner', 'owner-certificate', 'Legacy owner', 10, now);
  const ownerFile = new TextEncoder().encode('Legacy owner file');
  bucket.set(ownerFileKey, ownerFile);
  sql.prepare('INSERT INTO portfolio_entries (id, user_id, case_id, title, filename, size, object_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(ownerPortfolioId, 'course-owner', 'delivery-window', 'Legacy owner upload', 'owner.txt', ownerFile.length, ownerFileKey, now);

  const handle = createCourseHandler({ DB, BUCKET, secure: true, examBank: JSON.stringify(bank) });
  function call(path, { cookie, headers, ...options } = {}) {
    return handle(new Request(`${origin}${path}`, { ...options, headers: { origin, ...headers, ...(cookie ? { cookie } : {}) } }));
  }
  return { call, sql };
}

async function startVisitor(call, cookie) {
  const home = await call('/', { cookie });
  assert.equal(home.status, 200);
  const setCookie = home.headers.get('set-cookie');
  assert.ok(setCookie);
  const visitorCookie = setCookie.split(';')[0];
  assert.match(visitorCookie, visitorCookiePattern);
  assert.match(setCookie, /(?:^|;\s*)Path=\/(?:;|$)/i);
  assert.match(setCookie, /(?:^|;\s*)Secure(?:;|$)/i);
  assert.match(setCookie, /(?:^|;\s*)HttpOnly(?:;|$)/i);
  assert.match(setCookie, /(?:^|;\s*)SameSite=Lax(?:;|$)/i);
  assert.doesNotMatch(setCookie, /(?:^|;\s*)Domain=/i);
  assert.match(home.headers.get('cache-control'), /no-store/i);
  assert.match(await home.text(), /PM Learning Lab/);
  return visitorCookie;
}

function postJson(call, path, cookie, body, headers) {
  return call(path, { cookie, method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

test('opens the public course and assets without the access code while keeping the exam bank private', async (context) => {
  const { call } = await createFixture(context);
  for (const method of ['GET', 'HEAD']) {
    const legacy = await call('/access', { method });
    assert.equal(legacy.status, 303);
    assert.equal(new URL(legacy.headers.get('location'), origin).href, `${origin}/#modules`);
  }
  const first = await startVisitor(call);
  const second = await startVisitor(call, ownerCookie);
  assert.notEqual(first, second);
  assert.equal((await call('/', { cookie: first })).headers.has('set-cookie'), false);
  for (const path of ['/course-app.js', '/course-studio.js', '/study-chat.css', '/course-content.json', '/certificate.js']) {
    const asset = await call(path);
    assert.equal(asset.status, 200, path);
    assert.equal(asset.headers.has('set-cookie'), false, path);
  }
  assert.equal((await call('/data/exam-bank.json')).status, 404);
  for (const [path, method] of [['/api/learning', 'GET'], ['/api/learning/start', 'POST'], ['/api/portfolio', 'GET'], ['/api/portfolio', 'POST'], ['/api/tutor', 'GET']]) {
    const noSession = await call(path, { method, headers: ownerHeaders, cookie: ownerCookie });
    assert.equal(noSession.status, 401, `${method} ${path}`);
    assert.equal(noSession.headers.has('set-cookie'), false, path);
  }
});

test('awards the certificate at 80% and keeps each visitor and the legacy owner assessment separate', async (context) => {
  const { call, sql } = await createFixture(context);
  const first = await startVisitor(call);
  const second = await startVisitor(call);
  assert.deepEqual(await (await call('/api/learning', { cookie: `${first}; ${ownerCookie}`, headers: ownerHeaders })).json(), emptyLearningState);
  assert.equal((await postJson(call, '/api/learning/certificate', first, { name: 'First visitor' })).status, 403);

  const start = await call('/api/learning/start', { method: 'POST', cookie: first, headers: ownerHeaders });
  assert.equal(start.status, 200);
  const attempt = await start.json();
  assert.equal(attempt.questions.length, 10);
  assert.ok(attempt.questions.every((question) => !Object.hasOwn(question, 'correct') && !Object.hasOwn(question, 'rationale')));
  assert.deepEqual((await (await call('/api/learning', { cookie: first })).json()).attempt, attempt);
  const answers = attempt.questions.map((question, index) => question.options.indexOf(index < 8 ? 'Two' : 'One'));
  assert.equal((await postJson(call, '/api/learning/submit', second, { id: attempt.id, answers }, ownerHeaders)).status, 404);
  const result = await (await postJson(call, '/api/learning/submit', first, { id: attempt.id, answers })).json();
  assert.equal(result.percent, 80);
  assert.equal(result.passed, true);
  const issued = await postJson(call, '/api/learning/certificate', first, { name: 'First visitor' });
  assert.equal(issued.status, 201);
  const certificate = await issued.json();
  assert.equal(certificate.score, 8);
  const firstState = await call('/api/learning', { cookie: first });
  assert.match(firstState.headers.get('cache-control'), /no-store/i);
  assert.deepEqual((await firstState.json()).certificate, certificate);
  assert.deepEqual(await (await call('/api/learning', { cookie: second, headers: ownerHeaders })).json(), emptyLearningState);
  assert.equal((await postJson(call, '/api/learning/certificate', second, { name: 'Second visitor' })).status, 403);
  assert.equal(sql.prepare('SELECT user_id FROM attempts WHERE id = ?').get(attempt.id).user_id, `visitor:${first.slice(visitorCookieName.length + 1)}`);
  assert.equal(sql.prepare('SELECT name FROM certificates WHERE user_id = ?').get('course-owner').name, 'Legacy owner');
});

test('grounds chat in the lesson and limits private portfolio files to their browser session', async (context) => {
  const { call, sql } = await createFixture(context);
  const first = await startVisitor(call);
  const second = await startVisitor(call);
  const question = await postJson(call, '/api/tutor', first, { question: 'What is this lesson about?', focus: '#lesson/11/0' });
  assert.equal(question.status, 200);
  const answer = await question.json();
  assert.equal(answer.sources[0].href, '#lesson/11/0');
  assert.ok(answer.answer);
  const form = new FormData();
  form.set('caseId', 'delivery-window');
  form.set('title', 'Visitor upload');
  form.set('file', new File(['one,two\n1,2'], 'fixture.csv', { type: 'text/csv' }));
  const saved = await call('/api/portfolio', { method: 'POST', body: form, cookie: first, headers: ownerHeaders });
  assert.equal(saved.status, 201);
  const entry = await saved.json();
  assert.equal(sql.prepare('SELECT user_id FROM portfolio_entries WHERE id = ?').get(entry.id).user_id, `visitor:${first.slice(visitorCookieName.length + 1)}`);
  const list = await call('/api/portfolio', { cookie: first });
  assert.match(list.headers.get('cache-control'), /no-store/i);
  assert.deepEqual((await list.json()).entries, [entry]);
  assert.deepEqual((await (await call('/api/portfolio', { cookie: second, headers: ownerHeaders })).json()).entries, []);
  const fileUrl = `/api/portfolio/${entry.id}`;
  assert.equal((await call(fileUrl, { cookie: second, headers: ownerHeaders })).status, 404);
  assert.equal((await call(`/api/portfolio/${ownerPortfolioId}`, { cookie: `${first}; ${ownerCookie}`, headers: ownerHeaders })).status, 404);
  await call(fileUrl, { method: 'DELETE', cookie: second, headers: ownerHeaders });
  assert.equal(await (await call(fileUrl, { cookie: first })).text(), 'one,two\n1,2');
});
