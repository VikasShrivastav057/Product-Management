import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
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

export function createCourseHandler({ DB, BUCKET, secure = true, examBank, openAIKey, tutorModel }) {
  const bank = parseBank(examBank);
  const cookieName = secure ? '__Host-pm_learning_visitor' : 'pm_learning_visitor';
  const cookieAttributes = `Path=/; Max-Age=15552000; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  return async function handleCourse(request) {
    const path = new URL(request.url).pathname;
    const method = request.method;
    if (path === '/access') {
      return method === 'GET' || method === 'HEAD'
        ? new Response(null, { status: 303, headers: { ...privateHeaders, Location: '/#modules' } })
        : jsonError('Method not allowed.', 405);
    }
    const cookies = (request.headers.get('cookie') ?? '').split(';').map((part) => part.trim());
    const matches = cookies.filter((part) => part.startsWith(`${cookieName}=`));
    const token = matches.length === 1 ? matches[0].slice(cookieName.length + 1) : '';
    const visitor = /^[a-f0-9]{64}$/.test(token) ? token : '';
    const learning = path === '/api/learning' || path.startsWith('/api/learning/');
    const portfolio = path === '/api/portfolio' || path.startsWith('/api/portfolio/');
    const tutor = path === '/api/tutor';
    if (learning || portfolio || tutor) {
      if (!visitor) return jsonError('Allow cookies and reload the course to use this feature.', 401);
      const identity = new Headers(request.headers);
      identity.set('oai-authenticated-user-id', `visitor:${visitor}`);
      const personalized = new Request(request, { headers: identity });
      if (learning) return bank ? handleLearning(personalized, DB, bank) : jsonError('The final assessment is awaiting setup.', 503);
      if (portfolio) return handlePortfolio(personalized, DB, BUCKET, caseIds);
      return handleTutor(personalized, { DB, OPENAI_API_KEY: openAIKey, OPENAI_TUTOR_MODEL: tutorModel }, courseIndex);
    }
    const asset = files.get(path);
    if (!asset) return jsonError('Page not found.', 404);
    if (method !== 'GET' && method !== 'HEAD') return jsonError('Method not allowed.', 405);
    const [type, content] = asset;
    const headers = new Headers({ ...privateHeaders, 'Content-Type': `${type}; charset=utf-8` });
    const mode = request.headers.get('sec-fetch-mode');
    if (path === '/' && method === 'GET' && !visitor && (!mode || mode === 'navigate')) {
      headers.set('Set-Cookie', `${cookieName}=${randomBytes(32).toString('hex')}; ${cookieAttributes}`);
    }
    return new Response(method === 'HEAD' ? null : content, { headers });
  };
}
