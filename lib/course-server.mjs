import { readFileSync } from 'node:fs';
import { createCourseAccess } from './course-access.mjs';
import { handleLearning } from './learning.mjs';
import { handlePortfolio } from './portfolio.mjs';
import { createTutorIndex, handleTutor } from './tutor.mjs';

const courseContent = readFileSync(new URL('../course-assets/course-content.json', import.meta.url), 'utf8');
const files = new Map([
  ['/', ['text/html', readFileSync(new URL('../course-assets/index.html', import.meta.url), 'utf8')]],
  ['/course.css', ['text/css', readFileSync(new URL('../course-assets/course.css', import.meta.url), 'utf8')]],
  ['/course-studio.css', ['text/css', readFileSync(new URL('../course-assets/course-studio.css', import.meta.url), 'utf8')]],
  ['/study-chat.css', ['text/css', readFileSync(new URL('../course-assets/study-chat.css', import.meta.url), 'utf8')]],
  ['/course-app.js', ['text/javascript', readFileSync(new URL('../course-assets/course-app.js', import.meta.url), 'utf8')]],
  ['/course-studio.js', ['text/javascript', readFileSync(new URL('../course-assets/course-studio.js', import.meta.url), 'utf8')]],
  ['/certificate.js', ['text/javascript', readFileSync(new URL('../course-assets/certificate.js', import.meta.url), 'utf8')]],
  ['/course-content.json', ['application/json', courseContent]],
  ['/course-mark.svg', ['image/svg+xml', readFileSync(new URL('../course-assets/course-mark.svg', import.meta.url), 'utf8')]],
]);
const curriculum = JSON.parse(courseContent);
const courseIndex = createTutorIndex(curriculum);
const caseIds = new Set(curriculum.cases.map(({ id }) => id));
const privateHeaders = {
  'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer',
};

function parseBank(raw) {
  try {
    const items = JSON.parse(raw || 'null');
    if (!Array.isArray(items) || items.length !== 30 || new Set(items.map(({ id }) => id)).size !== 30) return null;
    for (let id = 1; id <= 10; id++) if (items.filter((item) => item.module === id).length !== 3) return null;
    return items.every((item) => typeof item.id === 'string' && typeof item.prompt === 'string' &&
      typeof item.rationale === 'string' && Array.isArray(item.options) && item.options.length === 4 &&
      item.options.every((option) => typeof option === 'string') && Number.isInteger(item.correct) &&
      item.correct >= 0 && item.correct < item.options.length) ? items : null;
  } catch { return null; }
}

function jsonError(error, status) {
  return Response.json({ error }, { status, headers: privateHeaders });
}

export function createCourseHandler({ DB, BUCKET, secure, accessHash, examBank, openAIKey, tutorModel }) {
  const access = createCourseAccess({ accessHash, secure });
  const bank = parseBank(examBank);
  return async function handleCourse(request) {
    const gate = await access.handle(request);
    if (gate) return gate;
    const path = new URL(request.url).pathname;
    const identity = new Headers(request.headers);
    identity.delete('oai-authenticated-user-id');
    identity.set('oai-authenticated-user-id', 'course-owner');
    const authenticated = () => new Request(request, { headers: identity });
    if (path === '/api/learning' || path.startsWith('/api/learning/')) {
      return bank ? handleLearning(authenticated(), DB, bank) : jsonError('The final assessment is awaiting setup.', 503);
    }
    if (path === '/api/portfolio' || path.startsWith('/api/portfolio/')) {
      return handlePortfolio(authenticated(), DB, BUCKET, caseIds);
    }
    if (path === '/api/tutor') return handleTutor(authenticated(), { DB, OPENAI_API_KEY: openAIKey, OPENAI_TUTOR_MODEL: tutorModel }, courseIndex);
    const asset = files.get(path);
    if (!asset) return jsonError('Page not found.', 404);
    if (request.method !== 'GET' && request.method !== 'HEAD') return jsonError('Method not allowed.', 405);
    const [type, content] = asset;
    return new Response(request.method === 'HEAD' ? null : content, {
      headers: { ...privateHeaders, 'Content-Type': `${type}; charset=utf-8` },
    });
  };
}
