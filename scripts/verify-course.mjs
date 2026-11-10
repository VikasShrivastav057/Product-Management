import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { handleLearning } from '../lib/learning.mjs';

const migration = await readFile(new URL('../drizzle/0000_learning.sql', import.meta.url), 'utf8');
const bank = Array.from({ length: 30 }, (_, index) => ({
  id: `fixture-${index}`, module: Math.floor(index / 3) + 1, prompt: `Test question ${index}`,
  options: [`Test answer ${index} A`, `Test answer ${index} B`, `Test answer ${index} C`, `Test answer ${index} D`],
  correct: index % 4, rationale: 'Synthetic fixture for grading tests.',
}));
const questionById = new Map(bank.map((question) => [question.id, question]));

function fixture(context) {
  const database = new DatabaseSync(':memory:');
  context.after(() => database.close());
  database.exec(migration);

  const db = {
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        bind(...values) {
          return {
            async first() { return statement.get(...values) ?? null; },
            async run() { return statement.run(...values); },
          };
        },
      };
    },
  };

  async function call(path = '', { method = 'POST', user = 'learner-a', body } = {}) {
    const headers = new Headers();
    if (user !== null) headers.set('oai-authenticated-user-id', user);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const request = new Request(`https://course.example/api/learning${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const response = await handleLearning(request, db, bank);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, value: await response.json() };
  }

  return { call, database };
}

function submission(attempt, score) {
  return {
    id: attempt.id,
    answers: attempt.questions.map((question, index) => {
      const source = questionById.get(question.id);
      const correctIndex = question.options.indexOf(source.options[source.correct]);
      assert.notEqual(correctIndex, -1);
      return index < score ? correctIndex : (correctIndex + 1) % question.options.length;
    }),
  };
}

test('signed-out requests cannot access attempts or certificates', async (context) => {
  const { call } = fixture(context);
  for (const [path, method] of [['', 'GET'], ['/start', 'POST'], ['/submit', 'POST'], ['/certificate', 'POST']]) {
    const result = await call(path, { method, user: null });
    assert.equal(result.status, 401);
    assert.match(result.value.error, /sign in/i);
  }
});

test('starting returns one public question per module and resumes the open attempt', async (context) => {
  const { call } = fixture(context);
  const start = await call('/start');
  assert.equal(start.status, 200);
  assert.deepEqual(Object.keys(start.value).sort(), ['id', 'questions']);
  assert.equal(new Set(start.value.questions.map(({ id }) => id)).size, 10);
  assert.deepEqual(start.value.questions.map(({ module }) => module).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  for (const question of start.value.questions) {
    assert.deepEqual(Object.keys(question).sort(), ['id', 'module', 'options', 'prompt']);
    const source = questionById.get(question.id);
    assert.equal(question.module, source.module);
    assert.deepEqual([...question.options].sort(), [...source.options].sort());
  }
  assert.deepEqual((await call('/start')).value, start.value);
  const state = await call('', { method: 'GET' });
  assert.deepEqual(state.value, { attempt: start.value, result: null, eligible: false, certificate: null });
});

test('7/10 is blocked and exactly 8/10 qualifies for one certificate', async (context) => {
  const { call, database } = fixture(context);
  const first = (await call('/start')).value;
  const failed = await call('/submit', { body: { ...submission(first, 7), score: 10 } });
  assert.equal(failed.status, 200);
  assert.equal(failed.value.correct, 7);
  assert.equal(failed.value.percent, 70);
  assert.equal(failed.value.passed, false);
  assert.equal(failed.value.review.filter(({ correct }) => correct).length, 7);
  assert.equal((await call('/certificate', { body: { name: 'Course Learner' } })).status, 403);
  assert.equal((await call('', { method: 'GET' })).value.eligible, false);

  const second = (await call('/start')).value;
  assert.notEqual(second.id, first.id);
  const seen = new Set(first.questions.map(({ id }) => id));
  assert(second.questions.every(({ id }) => !seen.has(id)));
  const passed = await call('/submit', { body: submission(second, 8) });
  assert.equal(passed.status, 200);
  assert.equal(passed.value.correct, 8);
  assert.equal(passed.value.percent, 80);
  assert.equal(passed.value.passed, true);
  assert.equal(passed.value.review.filter(({ correct }) => correct).length, 8);
  assert.deepEqual((await call('/submit', { body: submission(second, 10) })).value, passed.value);
  assert.equal((await call('', { method: 'GET' })).value.eligible, true);

  const firstClaim = await call('/certificate', { body: { name: '  Course   Learner  ' } });
  assert.equal(firstClaim.status, 201);
  assert.match(firstClaim.value.id, /^PML-/);
  assert.equal(firstClaim.value.name, 'Course Learner');
  assert.equal(firstClaim.value.score, 8);
  const repeatedClaim = await call('/certificate', { body: { name: 'Different Name' } });
  assert.equal(repeatedClaim.status, 200);
  assert.deepEqual(repeatedClaim.value, firstClaim.value);
  assert.deepEqual((await call('', { method: 'GET' })).value.certificate, firstClaim.value);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM certificates').get().count, 1);
});

test('malformed submissions leave the open attempt unchanged', async (context) => {
  const { call } = fixture(context);
  const attempt = (await call('/start')).value;
  const valid = submission(attempt, 8);
  for (const body of [
    null,
    { id: attempt.id, answers: valid.answers.slice(1) },
    { id: attempt.id, answers: ['1', ...valid.answers.slice(1)] },
    { id: attempt.id, answers: [1.5, ...valid.answers.slice(1)] },
    { id: attempt.id, answers: [4, ...valid.answers.slice(1)] },
    { id: attempt.id, answers: [-1, ...valid.answers.slice(1)] },
  ]) {
    assert.equal((await call('/submit', { body })).status, 400);
  }
  const state = (await call('', { method: 'GET' })).value;
  assert.deepEqual(state, { attempt, result: null, eligible: false, certificate: null });
  assert.equal((await call('/submit', { body: valid })).value.percent, 80);
});

test('a separate user cannot read, score, or claim from someone else’s attempt', async (context) => {
  const { call } = fixture(context);
  const attempt = (await call('/start')).value;
  const body = submission(attempt, 10);
  assert.equal((await call('/submit', { body, user: 'learner-b' })).status, 404);
  assert.equal((await call('/submit', { body })).value.percent, 100);
  assert.equal((await call('/certificate', { body: { name: 'Learner A' } })).status, 201);
  assert.equal((await call('/submit', { body, user: 'learner-b' })).status, 404);
  assert.equal((await call('/certificate', { user: 'learner-b', body: { name: 'Learner B' } })).status, 403);
  const state = (await call('', { user: 'learner-b', method: 'GET' })).value;
  assert.deepEqual(state, { attempt: null, result: null, eligible: false, certificate: null });
});
