import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCourseHandler } from '../lib/course-server.mjs';

test('each public lesson includes valid teaching blocks and a glossary', async () => {
  const handle = createCourseHandler({});
  const response = await handle(new Request('https://course.test/course-content.json'));
  assert.equal(response.status, 200);
  const { modules } = await response.json();
  const lessons = modules.flatMap(({ lessons }) => lessons);
  assert.equal(lessons.length, 52);
  for (const { title, glossary, blocks } of lessons) {
    assert.ok(glossary.length >= 4, title);
    const terms = glossary.map(({ term }) => term.trim().toLowerCase());
    assert.equal(new Set(terms).size, glossary.length, title);
    assert.ok(glossary.every(({ term, definition }) => term.trim() && definition.trim()), title);
    assert.ok(blocks.some(({ type }) => type === 'heading'), title);
    assert.ok(blocks.some(({ type }) => type === 'callout'), title);
    for (const { type, value } of blocks) {
      if (type === 'list' || type === 'steps') {
        assert.ok(Array.isArray(value) && value.length && value.every((item) => item.trim()), title);
      } else {
        assert.ok(['heading', 'paragraph', 'callout', 'code'].includes(type), title);
        assert.ok(typeof value === 'string' && value.trim(), title);
      }
    }
  }
  const foundations = lessons[0].glossary.map(({ term }) => term);
  assert.ok(foundations.includes('Guardrail') && foundations.includes('Bottleneck'));
});
