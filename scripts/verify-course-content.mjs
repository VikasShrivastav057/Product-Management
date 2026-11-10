import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCourseHandler } from '../lib/course-server.mjs';
import { riceScore, riceComparison } from '../course-assets/rice.js';

test('each public lesson includes valid teaching blocks and a glossary', async () => {
  const handle = createCourseHandler({});
  const response = await handle(new Request('https://course.test/course-content.json'));
  assert.equal(response.status, 200);
  const { modules, guides } = await response.json();
  const lessons = modules.flatMap(({ lessons }) => lessons);
  assert.equal(lessons.length, 52);
  for (const { title, glossary, blocks, walkthrough } of lessons) {
    assert.ok(glossary.length >= 4, title);
    const terms = glossary.map(({ term }) => term.trim().toLowerCase());
    assert.equal(new Set(terms).size, glossary.length, title);
    assert.ok(glossary.every(({ term, definition }) => term.trim() && definition.trim()), title);
    assert.ok(blocks.some(({ type }) => type === 'heading'), title);
    assert.ok(blocks.some(({ type }) => type === 'callout'), title);
    assert.ok(walkthrough.title.trim() && walkthrough.scenario.trim() && walkthrough.interview.trim(), title);
    assert.ok(walkthrough.practice.prompt.trim() && walkthrough.practice.answer.trim(), title);
    assert.ok(walkthrough.blocks.filter(({ type }) => type === 'heading').length >= 3, title);
    assert.ok(walkthrough.blocks.some(({ type }) => type === 'steps'), title);
    for (const { type, value } of [...blocks, ...walkthrough.blocks]) {
      if (type === 'list' || type === 'steps') {
        assert.ok(Array.isArray(value) && value.length && value.every((item) => item.trim()), title);
      } else if (type === 'table') {
        assert.ok(value.caption.trim() && value.headers.length > 1 && value.rows.length, title);
        assert.ok(value.rows.every((row) => row.length === value.headers.length), title);
      } else {
        assert.ok(['heading', 'paragraph', 'callout', 'code', 'formula'].includes(type), title);
        assert.ok(typeof value === 'string' && value.trim(), title);
      }
    }
  }
  const foundations = lessons[0].glossary.map(({ term }) => term);
  assert.ok(foundations.includes('Guardrail') && foundations.includes('Bottleneck'));
  assert.equal((await handle(new Request('https://course.test/rice.js'))).status, 200);
  assert.equal(guides.rice.features.length, 4);
});

test('RICE uses confidence as a fraction and ranks the four fictional features', () => {
  const examples = [
    { name: 'AI recommendations', reach: 50_000, impact: 2, confidence: 80, effort: 4 },
    { name: 'Faster checkout', reach: 40_000, impact: 3, confidence: 100, effort: 3 },
    { name: 'Dark mode', reach: 60_000, impact: 0.5, confidence: 80, effort: 2 },
    { name: 'Live order tracking', reach: 30_000, impact: 2, confidence: 100, effort: 2 },
  ];
  assert.deepEqual(examples.map(riceScore), [20_000, 40_000, 12_000, 30_000]);
  const [recommendations] = examples;
  assert.equal(riceScore({ ...recommendations, effort: 2 }), 40_000);
  assert.equal(riceScore({ ...recommendations, confidence: 50, effort: 5 }), 10_000);
  assert.equal(riceScore({ ...recommendations, reach: 0 }), 0);
  for (const effort of [0, -1, NaN, Infinity]) assert.equal(riceScore({ ...recommendations, effort }), null);
  const { ranked } = riceComparison(examples);
  assert.deepEqual(ranked.map(({ name }) => name), ['Faster checkout', 'Live order tracking', 'AI recommendations', 'Dark mode']);
  assert.deepEqual(ranked.map(({ width }) => width), [100, 75, 50, 30]);
});
