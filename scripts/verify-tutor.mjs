import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createTutorIndex, handleTutor, searchTutor } from '../lib/tutor.mjs';
import { createCourseHandler } from '../lib/course-server.mjs';

const site = 'https://course.test';
const content = JSON.parse(await readFile(new URL('../course-assets/course-content.json', import.meta.url), 'utf8'));
const migration = await readFile(new URL('../drizzle/0002_tutor.sql', import.meta.url), 'utf8');
const index = createTutorIndex(content);
const joinQuestion = 'How does a LEFT JOIN affect a retention metric?';

function ask(question = joinQuestion, { origin = site, user = 'student', ...extra } = {}) {
  return new Request(`${site}/api/tutor`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json', ...(user ? { 'oai-authenticated-user-id': user } : {}) },
    body: JSON.stringify({ question, ...extra }),
  });
}

test('search indexes all 52 lessons and seven cases and returns relevant linked material', () => {
  assert.equal(index.length, 59);
  for (const query of [joinQuestion, 'market fit evidence', 'clinic appointment rollout']) {
    const links = searchTutor(index, query);
    assert.ok(links.length >= 2, query);
    assert.ok(links.every((link) => /^#(?:lesson|case)\//.test(link.href)));
    assert.ok(links.every((link) => link.excerpts[0].length > 30));
  }
  assert.ok(searchTutor(index, joinQuestion).some((link) => /#lesson\/1[12]\//.test(link.href)));
  assert.equal(searchTutor(index, 'What is A/B testing?')[0].href, '#lesson/4/1');
  assert.equal(searchTutor(index, 'What is critical path?')[0].href, '#lesson/10/0');
  assert.match(searchTutor(index, 'How does LIMIT work?')[0].excerpts[0], /LIMIT.*first three/);
  assert.equal(searchTutor(index, 'dyd66ghzc93x').length, 0);
});

test('requires sign-in and a same-origin, bounded question', async () => {
  assert.equal((await handleTutor(ask('', { user: '' }), {}, index)).status, 401);
  assert.equal((await handleTutor(ask(joinQuestion, { origin: 'https://other.test' }), {}, index)).status, 403);
  assert.equal((await handleTutor(ask('  '), {}, index)).status, 400);
  assert.equal((await handleTutor(ask('x'.repeat(1001)), {}, index)).status, 400);
  const reply = await (await handleTutor(ask(), {}, index, () => assert.fail('Search must avoid the model'))).json();
  assert.equal(reply.mode, 'search');
  assert.ok(reply.sources.length);
  assert.equal(reply.sources[0].href, '#lesson/11/3');
  assert.equal(reply.answer, `“${reply.sources[0].excerpts[0]}” [1]`);
  assert.match(reply.answer, /left join/i);
});

test('anchors a vague follow-up to the current lesson and favors related module sources', async () => {
  const focus = '#lesson/11/3';
  const reply = await (await handleTutor(ask('Could you give me a worked example?', { focus }), {}, index)).json();
  assert.equal(reply.sources[0].href, focus);
  assert.equal(reply.answer, `“${reply.sources[0].excerpts[0]}” [1]`);
  assert.match(reply.answer, /Farah|9,500|7,000/);
  assert.ok(reply.sources.slice(1).some(({ href }) => href.startsWith('#lesson/11/')));
});

test('answers the lesson chat suggestions from the active lesson', async () => {
  const focus = '#lesson/11/0';
  for (const question of [
    'What is the main idea of this lesson?',
    'What is this lesson about?',
    'What should I remember from this lesson?',
    'Could you give me an overview of the current lesson?',
  ]) {
    const reply = await (await handleTutor(ask(question, { focus }), {}, index)).json();
    assert.equal(reply.sources[0]?.href, focus, question);
    assert.match(reply.answer, /SQL is a language.*grain/, question);
    assert.equal(reply.answer, `“${reply.sources[0].excerpts[0]}” [1]`);
  }

  const example = await (await handleTutor(ask('Can you show a practical example?', { focus }), {}, index)).json();
  assert.equal(example.sources[0]?.href, focus);
  assert.match(example.answer, /Expected rows.*Ava.*Chen/);
});

test('uses the latest topical question for a vague follow-up without a focused lesson', () => {
  const sources = searchTutor(index, 'Could you explain that again?', ['What is a LEFT JOIN?', 'How do I measure an ordered checkout funnel?']);
  assert.equal(sources[0].href, '#lesson/12/2');
});

test('keeps a focused lesson from overriding stronger evidence or supplying an unrelated answer', async () => {
  const focus = '#lesson/10/0';
  assert.equal(searchTutor(index, 'What is retrieval-augmented generation?', [], focus)[0].href, '#lesson/7/2');
  assert.equal(searchTutor(index, 'How does this lesson apply to product–market fit?', [], '#lesson/11/0')[0].href, '#lesson/13/2');
  assert.deepEqual(searchTutor(index, 'How does this lesson apply to volcanic eruptions on Mars?', [joinQuestion], '#lesson/11/0'), []);
  const unrelated = await (await handleTutor(ask('What is the weather in Tokyo tomorrow?', { focus, previous: [joinQuestion] }), {}, index)).json();
  assert.equal(unrelated.mode, 'search');
  assert.deepEqual(unrelated.sources, []);
  assert.equal(unrelated.answer, undefined);
  assert.match(unrelated.note, /topic|lesson/i);
  assert.deepEqual(searchTutor(index, 'Where did dinosaurs live?', [joinQuestion], focus), []);
  const unclear = await (await handleTutor(ask('Could you explain this?'), {}, index)).json();
  assert.deepEqual(unclear.sources, []);
  assert.match(unclear.note, /topic|lesson/i);
});

test('the public course enables AI mode when the server has a Groq key and storage', async () => {
  for (const [configuration, mode] of [
    [{ DB: {}, groqApiKey: 'fixture-only' }, 'ai'],
    [{ DB: {}, groqApiKey: '   ' }, 'search'],
    [{ groqApiKey: 'fixture-only' }, 'search'],
  ]) {
    const handle = createCourseHandler(configuration);
    const page = await handle(new Request(site));
    const cookie = page.headers.get('set-cookie').split(';', 1)[0];
    const response = await handle(new Request(`${site}/api/tutor`, { headers: { cookie } }));
    assert.deepEqual(await response.json(), { mode });
  }
});

test('generates a grounded Groq reply with a bounded request and a 20-question daily limit', async () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec(migration);
    const DB = { prepare: (sql) => ({ bind: (...values) => ({ first: () => sqlite.prepare(sql).get(...values) ?? null }) }) };
    const env = { DB, GROQ_API_KEY: 'fixture-only' };
    let modelCalls = 0;
    const fakeModel = async (url, init) => {
      modelCalls++;
      const payload = JSON.parse(init.body);
      assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
      assert.equal(init.method, 'POST');
      assert.ok(init.signal instanceof AbortSignal);
      assert.equal(payload.model, 'openai/gpt-oss-20b');
      assert.equal(payload.reasoning_effort, 'low');
      assert.equal(payload.max_completion_tokens, 768);
      assert.deepEqual(payload.messages.map(({ role }) => role), ['system', 'user']);
      assert.match(payload.messages[0].content, /Cite course sources/);
      assert.equal(init.headers.Authorization, 'Bearer fixture-only');
      const context = JSON.parse(payload.messages[1].content);
      assert.equal(context.question, joinQuestion);
      assert.deepEqual(context.earlierLearnerQuestions, ['Previous question', 'Most recent question']);
      assert.ok(context.sources.length >= 2);
      assert.ok(context.sources.every((source) => Object.keys(source).sort().join() === 'excerpts,number,title'));
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Keep all eligible users in the denominator [1].', reasoning: 'Hidden fixture reasoning' } }] });
    };
    assert.equal((await (await handleTutor(ask(joinQuestion, { searchOnly: true }), env, index, fakeModel)).json()).mode, 'search');
    assert.equal((await (await handleTutor(ask('Where did dinosaurs live?'), env, index, fakeModel)).json()).mode, 'search');
    for (let i = 0; i < 20; i++) {
      const previous = ['Discard this', 'Previous question', 'Most recent question'];
      const reply = await (await handleTutor(ask(joinQuestion, { previous }), env, index, fakeModel)).json();
      assert.equal(reply.mode, 'ai');
      assert.equal(reply.answer, 'Keep all eligible users in the denominator [1].');
    }
    const limited = await (await handleTutor(ask(), env, index, fakeModel)).json();
    assert.match(limited.note, /daily AI question limit/);
    assert.equal(limited.answer, `“${limited.sources[0].excerpts[0]}” [1]`);
    assert.equal(modelCalls, 20);
  } finally { sqlite.close(); }
});

test('Groq errors and incomplete replies fall back to the course references', async () => {
  const env = {
    GROQ_API_KEY: 'fixture-only',
    GROQ_TUTOR_MODEL: 'another-chat-model',
    DB: { prepare: () => ({ bind: () => ({ first: async () => ({ count: 1 }) }) }) },
  };
  for (const [providerReply, note] of [
    [new Response('private provider error', { status: 401 }), /temporarily unavailable/],
    [new Response(null, { status: 503 }), /temporarily unavailable/],
    [new Response(null, { status: 429 }), /usage limit/],
    [Response.json({ choices: [{ message: { content: null } }] }), /couldn’t finish/],
    [Response.json({ choices: [{ finish_reason: 'length', message: { content: 'Truncated model text' } }] }), /couldn’t finish/],
  ]) {
    let payload;
    const response = await handleTutor(ask(), env, index, async (url, init) => {
      payload = JSON.parse(init.body);
      return providerReply;
    });
    assert.equal(payload.model, 'another-chat-model');
    assert.equal(payload.reasoning_effort, undefined);
    assert.equal(response.status, 200);
    const reply = await response.json();
    assert.equal(reply.mode, 'search');
    assert.equal(reply.answer, `“${reply.sources[0].excerpts[0]}” [1]`);
    assert.match(reply.note, note);
  }
});

test('returns course excerpts if the AI usage counter is unavailable', async () => {
  const env = {
    GROQ_API_KEY: 'fixture-only',
    DB: { prepare: () => ({ bind: () => ({ first: async () => { throw new Error('Fixture storage outage'); } }) }) },
  };
  let modelCalls = 0;
  const response = await handleTutor(ask(), env, index, () => {
    modelCalls++;
    return new Response(null, { status: 503 });
  });
  assert.equal(response.status, 200);
  const reply = await response.json();
  assert.equal(reply.mode, 'search');
  assert.match(reply.note, /AI tutor is temporarily unavailable/);
  assert.equal(reply.answer, `“${reply.sources[0].excerpts[0]}” [1]`);
  assert.equal(modelCalls, 0);
});
