import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createModulePractice } from '../course-assets/module-practice.js';
import { createCourseHandler } from '../lib/course-server.mjs';

const course = JSON.parse(await readFile(new URL('../course-assets/course-content.json', import.meta.url), 'utf8'));
const quizzes = JSON.parse(await readFile(new URL('../course-assets/module-practice.json', import.meta.url), 'utf8'));

test('every course module has five distinct, publicly accessible practice questions', async () => {
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
  for (const { questions } of quizzes) {
    assert.equal(questions.length, 5);
    for (const { prompt, choices, answerIndex, explanation } of questions) {
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

test('a wrong answer shows the correct choice and rationale, then stays available on reload', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => Response.json(quizzes));
  const storage = new Map();
  let module = course.modules[0];
  const options = {
    currentModule: () => module,
    reviewHref: ({ id }) => `#lesson/${id}/0`,
    continueHref: ({ id }) => id === course.modules.at(-1).id ? '#assessment' : `#lesson/${id + 1}/0`,
    getLocal: (key) => storage.get(key),
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

  await practice.enter();
  const { questions } = quizzes[0];
  const first = questions[0];
  assert.ok(view().includes('QUESTION 1 OF 5'));
  assert.ok(!view().includes(first.explanation));
  click('next');
  assert.ok(view().includes('QUESTION 1 OF 5'));
  submit((first.answerIndex + 1) % first.choices.length);
  assert.ok(view().includes('Incorrect'));
  assert.ok(view().includes(`Correct answer</strong> ${first.choices[first.answerIndex]}`));
  assert.ok(view().includes(first.explanation));
  submit(first.answerIndex);
  assert.ok(view().includes('Incorrect'));

  practice = createModulePractice(options);
  await practice.enter();
  assert.ok(view().includes(first.explanation));
  click('next');
  for (const question of questions.slice(1)) {
    assert.ok(view().includes(question.prompt));
    submit(question.answerIndex);
    click('next');
  }
  assert.ok(view().includes('4 of 5 correct'));
  assert.ok(view().includes('Review missed questions'));
  assert.ok(view().includes('href="#lesson/2/0"'));
  click('restart');
  assert.ok(view().includes('QUESTION 1 OF 5'));
  assert.ok(!view().includes(first.explanation));

  module = course.modules.at(-1);
  assert.ok(view().includes('QUESTION 1 OF 5'));
  for (const question of quizzes.at(-1).questions) {
    submit(question.answerIndex);
    click('next');
  }
  assert.ok(view().includes('5 of 5 correct'));
  assert.ok(view().includes('href="#assessment"'));
});
