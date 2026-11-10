import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createModulePractice } from '../course-assets/module-practice.js';
import { createCourseHandler } from '../lib/course-server.mjs';

const course = JSON.parse(await readFile(new URL('../course-assets/course-content.json', import.meta.url), 'utf8'));
const quizzes = JSON.parse(await readFile(new URL('../course-assets/module-practice.json', import.meta.url), 'utf8'));

test('every module has five original questions and six distinct alternates', async () => {
  const handle = createCourseHandler({});
  const get = (path) => handle(new Request(`https://pm-course.test${path}`));
  const bank = await get('/module-practice.json');
  assert.equal(bank.status, 200);
  assert.match(bank.headers.get('content-type'), /^application\/json/);
  assert.deepEqual(await bank.json(), quizzes);
  assert.match((await get('/module-practice.js')).headers.get('content-type'), /^text\/javascript/);
  assert.equal((await get('/data/exam-bank.json')).status, 404);

  assert.deepEqual(quizzes.map(({ module }) => module), course.modules.map(({ id }) => id));
  const prompts = new Set();
  for (const { questions, alternates } of quizzes) {
    assert.equal(questions.length, 5);
    assert.equal(alternates.length, 6);
    const pool = [...questions, ...alternates];
    assert.equal(new Set(pool.map(({ id }) => id)).size, pool.length);
    for (const { id, prompt, choices, answerIndex, explanation } of pool) {
      assert.ok(Number.isInteger(id) && id > 0);
      assert.ok(prompt.trim() && explanation.trim());
      assert.ok(!prompts.has(prompt));
      prompts.add(prompt);
      assert.equal(choices.length, 4);
      assert.equal(new Set(choices).size, 4);
      assert.ok(choices.every((choice) => choice.trim()));
      assert.ok(Number.isInteger(answerIndex) && answerIndex >= 0 && answerIndex < choices.length);
    }
  }
});

function createFixture(context, storage = new Map()) {
  context.mock.method(globalThis, 'fetch', async () => Response.json(quizzes));
  let module = course.modules[0];
  const options = {
    currentModule: () => module,
    reviewHref: ({ id }) => `#lesson/${id}/0`,
    continueHref: ({ id }) => id === course.modules.at(-1).id ? '#assessment' : `#lesson/${id + 1}/0`,
    getLocal: (key, fallback) => storage.get(key) ?? fallback,
    setLocal: (key, value) => storage.set(key, value),
    render: () => {},
    focus: () => {},
    inline: (value) => value,
    icon: () => '',
  };
  let practice = createModulePractice(options);
  const submit = (choice) => practice.submit({
    target: { id: 'module-practice-form', elements: { namedItem: () => ({ value: String(choice) }) } },
    preventDefault() {},
  });
  const click = (practiceAction) => practice.click({ dataset: { practiceAction } });
  const view = () => practice.view(module);
  const attempt = () => storage.get(`pm-learning-lab:practice:v2:${module.id}`);
  const question = () => {
    const { questionIds, step } = attempt();
    const { questions, alternates } = quizzes.find((quiz) => quiz.module === module.id);
    return [...questions, ...alternates].find(({ id }) => id === questionIds[step]);
  };
  async function reload() {
    practice = createModulePractice(options);
    await practice.enter();
  }
  return { submit, click, view, attempt, question, reload, selectModule: (next) => { module = next; } };
}

test('feedback identifies the learner’s choice, verdict, and reasoning before advancing', async (context) => {
  const { submit, click, view, attempt, question, reload } = createFixture(context);
  await reload();
  assert.ok(view().includes('QUESTION 1 OF 5'));
  const first = question();
  assert.ok(view().includes(first.prompt));
  assert.ok(!view().includes(first.explanation));
  click('next');
  assert.ok(view().includes('QUESTION 1 OF 5'));
  const wrong = (first.answerIndex + 1) % first.choices.length;
  submit(wrong);
  assert.ok(view().includes('Your answer was incorrect.'));
  assert.ok(view().includes(`Your answer</dt><dd>${first.choices[wrong]}`));
  assert.ok(view().includes(`Correct answer</dt><dd>${first.choices[first.answerIndex]}`));
  assert.ok(view().includes(first.explanation));
  submit(first.answerIndex);
  assert.ok(view().includes('Your answer was incorrect.'));

  const originalIds = attempt().questionIds;
  await reload();
  assert.ok(view().includes(first.explanation));
  assert.deepEqual(attempt().questionIds, originalIds);
  click('next');
  for (let index = 1; index < 5; index++) {
    const current = question();
    assert.ok(view().includes(current.prompt));
    submit(current.answerIndex);
    assert.ok(view().includes('Your answer was correct.'));
    assert.ok(view().includes(`Your answer</dt><dd>${current.choices[current.answerIndex]}`));
    assert.ok(view().includes(current.explanation));
    click('next');
  }
  assert.ok(view().includes('4 of 5 correct'));
  assert.ok(view().includes('Review missed questions'));
  assert.ok(view().includes(`Incorrect · ${first.prompt}`));
  assert.ok(view().includes('href="#lesson/2/0"'));
});

test('every retry picks five questions outside the previous set and keeps them on reload', async (context) => {
  const { submit, click, view, attempt, question, reload, selectModule } = createFixture(context);
  selectModule(course.modules.at(-1));
  await reload();
  assert.ok(view().includes('QUESTION 1 OF 5'));
  for (let round = 0; round < 4; round++) {
    const ids = attempt().questionIds;
    assert.equal(new Set(ids).size, 5);
    for (let index = 0; index < 5; index++) {
      submit(question().answerIndex);
      click('next');
    }
    assert.ok(view().includes('5 of 5 correct'));
    assert.ok(view().includes('href="#assessment"'));
    assert.ok(view().includes('Try a new set'));
    click('restart');
    const nextIds = attempt().questionIds;
    assert.ok(nextIds.every((id) => !ids.includes(id)));
    assert.ok(view().includes('QUESTION 1 OF 5'));
    await reload();
    assert.ok(view().includes('QUESTION 1 OF 5'));
    assert.deepEqual(attempt().questionIds, nextIds);
  }
});

test('an existing five-question attempt keeps its answers and question order', async (context) => {
  const [first, second, third] = quizzes[0].questions;
  const wrong = (second.answerIndex + 1) % second.choices.length;
  const storage = new Map([['pm-learning-lab:practice:v1:1', { step: 1, answers: [first.answerIndex, wrong] }]]);
  const { reload, view, attempt, click } = createFixture(context, storage);
  await reload();
  assert.ok(view().includes('QUESTION 2 OF 5'));
  assert.ok(view().includes(second.prompt));
  assert.ok(view().includes('Your answer was incorrect.'));
  assert.deepEqual(attempt().questionIds, quizzes[0].questions.map(({ id }) => id));
  click('next');
  assert.ok(view().includes(third.prompt));
});
