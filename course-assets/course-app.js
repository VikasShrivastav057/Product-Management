import { downloadCertificate } from './certificate.js';
import { createStudio } from './course-studio.js';
import { createModulePractice, GUESSTIMATE_PRACTICE_ID } from './module-practice.js';
import { riceCalculator, riceComparison, updateRiceCalculator } from './rice.js';

const root = document.querySelector('#learning-root');
const studyChat = document.querySelector('#study-chat');
const progressKey = 'pm-learning-lab:lessons:v1';
let course;
let server = { attempt: null, result: null, certificate: null, eligible: false };
let sessionState = 'loading';
let working = false;
let questionIndex = 0;
let notice = '';
let chatOpen = false;
let chatTrigger = null;

const paths = {
  home: '<path d="M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h13v17H6a2 2 0 0 1 0-4h13M4 5v13M8 7h7M8 11h5"/>',
  exam: '<path d="M8 5H5v16h14V5h-3M9 3h6v4H9zM8 12h8M8 16h6"/>',
  award: '<circle cx="12" cy="9" r="5"/><path d="m8 13-1 8 5-3 5 3-1-8"/>',
  arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
  search: '<circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 4 4"/>',
  layout: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18m-11 0v11"/>',
  chart: '<path d="M4 4v16h16M8 15l4-4 3 2 4-6"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16"/>',
  spark: '<path d="M12 2v20M2 12h20M5 5l14 14m0-14L5 19"/>',
  network: '<circle cx="5" cy="12" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="18" cy="19" r="2"/><path d="m7 11 9-5m-9 7 9 5"/>',
  flag: '<path d="M5 21V4m0 1c5-4 9 4 15 0v10c-6 4-10-4-15 0"/>',
  calendar: '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4m8-4v4M4 10h16m-12 5 2 2 4-4"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3"/>',
};

const modulesIcons = ['compass', 'search', 'layout', 'chart', 'layers', 'code', 'spark', 'network', 'flag', 'calendar', 'code', 'chart', 'compass', 'flag'];
const nav = [['home', 'Overview', 'home'], ['modules', 'Course library', 'book'], ['cases', 'Case studies', 'compass'], ['portfolio', 'My portfolio', 'layers'], ['tutor', 'Course Q&A', 'spark'], ['assessment', 'Final assessment', 'exam'], ['certificate', 'Certificate', 'award']];

function icon(name, className = 'nav-icon') {
  return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}

const escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (text) => String(text ?? '').replace(/[&<>"']/g, (char) => escapeMap[char]);
const inline = (text) => escape(text).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
const two = (number) => String(number).padStart(2, '0');
const lessonId = (mod, index) => `${mod}-${index}`;
const lessonProgressKey = (id) => `${progressKey}:${id}`;
const lessonHref = (mod, index) => `#lesson/${mod}/${index}`;
const practiceHref = (mod) => `#practice/${mod}`;
const assessmentDraftKey = (id) => `pm-learning-lab:attempt:${id}`;
const riceHref = '#guide/rice';
const strategyLesson = lessonHref(1, 1);
const opportunitySizingLesson = lessonHref(13, 4);
const guesstimatePractice = {
  id: GUESSTIMATE_PRACTICE_ID,
  title: 'Guesstimate practice',
  eyebrow: 'ESTIMATION · PRACTICE QUIZ',
  intro: 'Use the assumptions in each question. Break the estimate into parts, keep the units consistent, and round at the end.',
  reviewLabel: 'Review opportunity sizing',
  continueLabel: 'Back to course library',
};

function getLocal(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

function setLocal(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch { return false; }
}

const complete = new Set();
const unsavedAnswers = new Map();
const lessonCount = () => course.modules.reduce((total, item) => total + item.lessons.length, 0);
const coursePercent = () => Math.round(100 * complete.size / lessonCount());

function refreshLessonProgress() {
  const saved = getLocal(progressKey, []);
  const legacy = new Set(Array.isArray(saved) ? saved : []);
  for (const { id, lessons } of course.modules) {
    for (const index of lessons.keys()) {
      const key = lessonId(id, index);
      if (legacy.has(key) || getLocal(lessonProgressKey(key), false) === true) complete.add(key);
    }
  }
}

function answers() {
  if (!server.attempt) return [];
  const prefix = assessmentDraftKey(server.attempt.id);
  const legacy = getLocal(prefix, []);
  return server.attempt.questions.map(({ options }, index) => {
    const key = `${prefix}:${index}`;
    const value = unsavedAnswers.has(key) ? unsavedAnswers.get(key) : getLocal(key, legacy[index]);
    return Number.isInteger(value) && value >= 0 && value < options.length ? value : null;
  });
}

async function api(suffix = '', body) {
  const response = await fetch(`/api/learning${suffix}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(value.error || 'That action is temporarily unavailable. Please try again.');
    error.status = response.status;
    throw error;
  }
  return value;
}

async function refreshServer() {
  try { server = await api(); sessionState = 'ready'; }
  catch (error) { sessionState = error.status === 401 ? 'cookies' : 'error'; }
}

function navLinks(active) {
  return nav.map(([url, label, shape]) => `<a href="#${url}" class="nav-link${url === active ? ' active' : ''}"${url === active ? ' aria-current="page"' : ''}>${icon(shape)}<span>${label}</span></a>`).join('');
}

const brand = `<a class="brand" href="#home"><span class="brand-mark">${icon('layers')}</span><span>PM Learning Lab<small>COURSE WORKSPACE</small></span></a>`;

function shell(active, crumb, body) {
  return `<a class="skip-link" href="#main-content" data-skip>Skip to content</a><div class="app-shell">
    <aside class="sidebar">${brand}<div class="nav-label">LEARN</div><nav aria-label="Course navigation">${navLinks(active)}</nav>
      <div class="sidebar-bottom"><div class="nav-label">YOUR PROGRESS</div><strong>${complete.size} of ${lessonCount()} lessons</strong><div class="progress-track" aria-hidden="true"><span style="width:${coursePercent()}%"></span></div><small>Saved in this browser</small></div></aside>
    <div class="workspace"><header class="topbar"><div class="breadcrumbs"><span>Learning lab</span><span aria-hidden="true">/</span><strong>${escape(crumb)}</strong></div><span class="pill">SELF-PACED COURSE</span></header>
      <div class="mobile-nav">${brand}<nav aria-label="Mobile course navigation">${navLinks(active)}</nav></div>
      <main class="page-content" id="main-content" tabindex="-1">${notice ? `<div class="notice" role="status">${escape(notice)}</div>` : ''}${body}</main>
    </div></div>`;
}

function nextLesson() {
  for (const mod of course.modules) for (let index = 0; index < mod.lessons.length; index++) {
    if (!complete.has(lessonId(mod.id, index))) return { mod: mod.id, index };
  }
  return null;
}

const heroArt = `<svg class="hero-art" viewBox="0 0 380 284" aria-hidden="true" fill="none"><defs><pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0v24" fill="none" stroke="#d0e3d1" stroke-opacity=".14"/></pattern></defs>
  <rect x="10" y="9" width="360" height="264" rx="14" fill="url(#grid)"/>
  <circle cx="190" cy="142" r="104" stroke="#d0e3d1" stroke-opacity=".27" stroke-dasharray="5 6"/>
  <path d="M96 68h94v74h98m-98 0v70h-78" stroke="#a9cbb9" stroke-width="2"/>
  <rect x="44" y="49" width="107" height="42" rx="9" fill="#dceae0"/><text x="97" y="75" fill="#1b3c30" font-size="12" text-anchor="middle" font-family="system-ui" font-weight="700">DISCOVER</text>
  <rect x="131" y="115" width="118" height="54" rx="11" fill="#e8f29c"/><path d="M148 143h13m-6.5-6.5v13" stroke="#203b32" stroke-width="1.8" stroke-linecap="round"/><text x="200" y="147" fill="#203b32" font-size="13" text-anchor="middle" font-family="system-ui" font-weight="800">DECIDE</text>
  <rect x="250" y="123" width="92" height="40" rx="8" fill="#dceae0"/><text x="296" y="148" fill="#1b3c30" font-size="12" text-anchor="middle" font-family="system-ui" font-weight="700">DELIVER</text>
  <rect x="58" y="192" width="107" height="40" rx="8" fill="#dceae0"/><text x="111" y="217" fill="#1b3c30" font-size="12" text-anchor="middle" font-family="system-ui" font-weight="700">MEASURE</text>
  <circle cx="290" cy="71" r="18" fill="#243f34" stroke="#89aa98"/><path d="M290 62v18m-9-9h18" stroke="#e8f29c" stroke-width="1.5" stroke-linecap="round"/>
  <circle cx="241" cy="227" r="4" fill="#e8f29c"/><circle cx="42" cy="143" r="4" fill="#e8f29c"/><circle cx="330" cy="202" r="4" fill="#e8f29c"/>
</svg>`;

function card(mod) {
  const done = mod.lessons.filter((_, index) => complete.has(lessonId(mod.id, index))).length;
  const next = mod.lessons.findIndex((_, index) => !complete.has(lessonId(mod.id, index)));
  return `<a class="module-card" href="${lessonHref(mod.id, Math.max(0, next))}">
    <div class="module-top"><span class="module-icon">${icon(modulesIcons[mod.id - 1])}</span><span class="module-meta">${two(mod.id)} / ${escape(mod.tag)}</span></div>
    <h3>${escape(mod.title)}</h3><p>${escape(mod.summary)}</p>
    <div class="progress-track" aria-hidden="true"><span style="width:${100 * done / mod.lessons.length}%"></span></div>
    <div class="module-footer"><span>${done ? `${done}/${mod.lessons.length} complete` : `${mod.lessons.length} lessons`}</span>${icon('arrow')}</div></a>`;
}

function library(withChat = false) {
  return `<section id="course-library"><div class="section-head"><div><span class="eyebrow">THE CURRICULUM</span><h2>Explore the modules</h2></div><span class="muted">${course.modules.length} modules · ${lessonCount()} lessons</span></div>
    ${withChat ? `<div class="study-chat-entry"><span class="module-icon">${icon('spark')}</span><div><h3>Have a course question?</h3><p>Ask about any module and get an answer with a link to the lesson.</p></div><button type="button" class="btn secondary" data-study-chat-open>Open course chat ${icon('arrow')}</button></div>` : ''}
    ${course.guides?.rice ? `<div class="notice"><strong>RICE framework</strong><p>Compare four feature ideas and try the interactive score calculator.</p><a class="text-link" href="${riceHref}">Open the RICE guide ${icon('arrow')}</a></div>` : ''}
    <div class="notice"><strong>Guesstimate practice</strong><p>Estimate demand, market size, revenue, and capacity from a few assumptions. See the calculation after each answer.</p><a class="text-link" href="${practiceHref(guesstimatePractice.id)}">Start guesstimate quiz ${icon('arrow')}</a></div>
    <div class="module-grid">${course.modules.map(card).join('')}</div>
    <div class="notice"><strong>Put the lessons into practice</strong><p>Work through seven case studies and save your own deliverables in your private portfolio.</p><a class="text-link" href="#cases">Explore case studies ${icon('arrow')}</a></div></section>`;
}

function home() {
  const next = nextLesson();
  return `<section class="hero"><div class="hero-copy"><span class="eyebrow">A PRACTICAL, SELF-PACED COURSE</span><h1>Learn product management by making decisions.</h1>
    <p>Study product strategy, SQL, experimentation, AI, and project delivery. Then work through cases and practice making decisions with evidence.</p>
    <div class="hero-actions"><a class="btn primary" href="${next ? lessonHref(next.mod, next.index) : '#assessment'}">${complete.size && next ? 'Continue learning' : next ? 'Start learning' : 'Take assessment'} ${icon('arrow')}</a><a class="btn secondary" href="#modules">Browse modules</a></div></div>${heroArt}</section>
    <div class="metric-grid"><div class="metric-card"><strong>${course.modules.length}</strong><span>COURSE MODULES</span></div><div class="metric-card"><strong>${lessonCount()}</strong><span>SHORT LESSONS</span></div><div class="metric-card"><strong>80%</strong><span>ASSESSMENT PASS MARK</span></div></div>${library()}`;
}

function learningTable({ caption, headers, rows }) {
  return `<div class="learning-table" tabindex="0" role="region" aria-label="${escape(caption)}"><table>
    <caption>${inline(caption)}</caption><thead><tr>${headers.map((header) => `<th scope="col">${inline(header)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(([label, ...cells]) => `<tr><th scope="row">${inline(label)}</th>${cells.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>`;
}

function glossaryList(words) {
  return words.length ? `<dl>${words.map(({ term, definition }) => `<dt>${escape(term)}</dt><dd>${inline(definition)}</dd>`).join('')}</dl>` : '';
}

function blocks(lesson, heading = 'h2') {
  return lesson.blocks.map(({ type, value }) => {
    if (type === 'heading') return `<${heading}>${inline(value)}</${heading}>`;
    if (type === 'table') return learningTable(value);
    if (type === 'formula') return `<p class="lesson-formula">${inline(value)}</p>`;
    if (type === 'list' || type === 'steps') {
      const tag = type === 'steps' ? 'ol' : 'ul';
      return `<${tag}>${value.map((item) => `<li>${inline(item)}</li>`).join('')}</${tag}>`;
    }
    if (type === 'code') return `<div class="lesson-code"><div class="code-bar"><span>SQL</span><button type="button" class="btn quiet" data-copy-code>Copy SQL</button></div><pre tabindex="0"><code>${escape(value)}</code></pre></div>`;
    if (type === 'callout' || /^\*\*(?:Practice|Try it)/i.test(value)) return `<div class="practice">${inline(value)}</div>`;
    return `<p>${inline(value)}</p>`;
  }).join('');
}

function tryIt({ practice, interview }, heading) {
  return `<div class="learning-exercise">
    <${heading}>Try it yourself</${heading}><p>${inline(practice.prompt)}</p>
    <details><summary>Reveal the worked answer</summary><p>${inline(practice.answer)}</p></details>
    </div><${heading}>How to explain it in an interview</${heading}><blockquote>${inline(interview)}</blockquote>`;
}

function walkthroughView(walkthrough) {
  return `<section class="lesson-walkthrough" aria-labelledby="worked-example-title">
    <span class="eyebrow">WORKED WALKTHROUGH</span><h2 id="worked-example-title" tabindex="-1">${inline(walkthrough.title)}</h2>
    <p>${inline(walkthrough.scenario)}</p>${blocks(walkthrough, 'h3')}${tryIt(walkthrough, 'h3')}
    </section>`;
}

function riceGuideView(guide) {
  const { rows, ranked } = riceComparison(guide.features);
  const comparison = learningTable({
    caption: 'Illustrative monthly RICE scores for four delivery app features',
    headers: ['Feature', 'Reach per month', 'Impact', 'Confidence', 'Effort in person-months', 'RICE score'],
    rows,
  });
  const ranking = `<ol class="rice-ranking">${ranked.map(({ name, score, width }) => `<li><div><span>${inline(name)}</span><strong>${score}</strong></div><span class="rice-bar" aria-hidden="true"><span style="width:${width}%"></span></span></li>`).join('')}</ol>`;
  const glossary = glossaryList(guide.glossary);
  return `<div class="lesson-layout lesson-with-glossary"><article class="lesson-body rice-guide">
    <span class="eyebrow">PRODUCT MANAGEMENT FRAMEWORK</span><h1>${inline(guide.title)}</h1>
    <div class="lesson-chat-entry"><button class="btn secondary" type="button" data-study-chat-open>Ask about RICE ${icon('spark')}</button><button type="button" class="btn quiet" data-learning-jump="rice-calculator-title">Jump to calculator</button><a class="btn quiet" href="${strategyLesson}">Back to strategy lesson</a></div>
    <details class="lesson-glossary mobile-glossary"><summary>Words in this guide</summary>${glossary}</details>
    <div class="prose"><p>${inline(guide.scenario)}</p>${blocks(guide)}
      <h2>Compare four features</h2>${comparison}<h3>Priority ranking</h3>${ranking}
      ${guide.decision.map((paragraph) => `<p>${inline(paragraph)}</p>`).join('')}
      ${riceCalculator(guide.features[0])}${tryIt(guide, 'h2')}
      <p><a href="https://www.intercom.com/blog/rice-simple-prioritization-for-product-managers">Intercom’s original RICE framework</a></p>
    </div></article><aside class="lesson-glossary desktop-glossary" aria-labelledby="rice-glossary-title"><h2 id="rice-glossary-title">Words in this guide</h2>${glossary}</aside></div>`;
}

function lessonView(mod, index) {
  const lesson = mod.lessons[index];
  const key = lessonId(mod.id, index);
  const lastLesson = index === mod.lessons.length - 1;
  const next = lastLesson ? practiceHref(mod.id) : lessonHref(mod.id, index + 1);
  const label = lastLesson
    ? (complete.has(key) ? 'Open practice quiz' : 'Complete & take quiz')
    : (complete.has(key) ? 'Continue' : 'Complete & continue');
  const words = lesson.glossary ?? [];
  const glossary = glossaryList(words);
  const href = lessonHref(mod.id, index);
  const estimates = (mod.id === 9 && index === 1) || href === opportunitySizingLesson;
  const rice = course.guides?.rice && (href === strategyLesson || href === opportunitySizingLesson);
  return `<div class="lesson-layout lesson-with-glossary"><article class="lesson-body"><span class="eyebrow">MODULE ${two(mod.id)} · LESSON ${index + 1} OF ${mod.lessons.length}</span><h1>${escape(lesson.title)}</h1><div class="lesson-chat-entry"><button class="btn secondary" type="button" data-study-chat-open>Ask about this lesson ${icon('spark')}</button><a class="btn quiet" href="${practiceHref(mod.id)}">Practice quiz</a>${lesson.walkthrough ? '<button type="button" class="btn quiet" data-learning-jump="worked-example-title">Worked walkthrough</button>' : ''}${rice ? `<a class="btn quiet" href="${riceHref}">RICE guide and calculator</a>` : ''}${estimates ? `<a class="btn quiet" href="${practiceHref(guesstimatePractice.id)}">Guesstimate practice</a>` : ''}</div>
    ${glossary ? `<details class="lesson-glossary mobile-glossary"><summary>Words in this lesson <span class="muted">· ${words.length} terms</span></summary>${glossary}</details>` : ''}
    <div class="prose">${blocks(lesson)}${lesson.walkthrough ? walkthroughView(lesson.walkthrough) : ''}</div>
    <div class="lesson-nav"><a class="btn quiet" href="${index > 0 ? lessonHref(mod.id, index - 1) : '#modules'}">${index > 0 ? 'Previous lesson' : 'Course library'}</a><button class="btn quiet" type="button" data-study-chat-open>Ask about this lesson ${icon('spark')}</button><button class="btn primary" type="button" data-complete="${key}" data-next="${next}">${label} ${icon('arrow')}</button></div></article>
    <div class="lesson-sidebar">
      ${glossary ? `<aside class="lesson-glossary desktop-glossary" aria-labelledby="lesson-glossary-title"><h2 id="lesson-glossary-title">Words in this lesson</h2>${glossary}</aside>` : ''}
      <aside class="lesson-outline"><span class="eyebrow">MODULE ${two(mod.id)}</span><h2>${escape(mod.title)}</h2><ol>${mod.lessons.map((item, i) => `<li><a href="${lessonHref(mod.id, i)}"${i === index ? ' aria-current="page" class="active"' : ''}>${complete.has(lessonId(mod.id, i)) ? icon('check') : `<span class="lesson-number">${two(i + 1)}</span>`}<span>${escape(item.title)}</span></a></li>`).join('')}</ol><a class="module-practice-link" href="${practiceHref(mod.id)}">${icon('exam')}<span>Practice quiz · 5 questions</span></a></aside>
    </div></div>`;
}

function sessionMessage() {
  if (sessionState === 'loading') return '<div class="notice" role="status">Checking your assessment status…</div>';
  if (sessionState === 'cookies') return '<div class="notice"><p>Allow cookies and reload the course to save your assessment and certificate in this browser.</p><button class="btn primary" type="button" data-action="reload">Reload course</button></div>';
  if (sessionState === 'error') return '<div class="notice"><p>Your assessment status is temporarily unavailable.</p><button type="button" class="btn secondary" data-action="refresh">Try again</button></div>';
  return '';
}

function showResult(result) {
  return `<div class="result-panel ${result.passed ? 'passed' : 'failed'}"><span class="eyebrow">ASSESSMENT RESULT</span><h2>${result.percent}% · ${result.passed ? 'Passed' : 'Keep practicing'}</h2>
    <p>${result.correct} of ${result.total} correct. ${result.passed ? 'Your completion certificate is unlocked.' : 'A score of at least 80% unlocks the certificate. Review the explanations and try another set.'}</p>
    <div class="assessment-actions">${server.eligible ? '<a class="btn primary" href="#certificate">Open certificate</a>' : '<button class="btn primary" data-action="start" type="button">Try again</button>'}<a class="btn quiet" href="#modules">Review lessons</a></div></div>
    <div class="review-list"><h2>Review your answers</h2>${result.review.map((item, index) => `<details class="notice"><summary>${two(index + 1)} · ${item.correct ? 'Correct' : 'Incorrect'} · ${escape(item.prompt)}</summary><p><strong>Your answer</strong> ${escape(item.answer)}</p>${item.correct ? '' : `<p><strong>Correct answer</strong> ${escape(item.expected)}</p>`}<p><strong>Why</strong> ${escape(item.rationale)}</p></details>`).join('')}</div>`;
}

function activeQuestion() {
  const attempt = server.attempt;
  const question = attempt.questions[questionIndex];
  const draft = answers();
  const answered = draft.filter(Number.isInteger).length;
  return `<div class="question-card"><div class="section-head"><span class="eyebrow">QUESTION ${two(questionIndex + 1)} / ${attempt.questions.length}</span><span class="pill">${answered}/${attempt.questions.length} ANSWERED</span></div>
    <div class="progress-track" aria-hidden="true"><span style="width:${answered * 10}%"></span></div>
    <fieldset><legend>${escape(question.prompt)}</legend><div class="options">${question.options.map((option, i) => `<label class="option"><input type="radio" name="answer" value="${i}"${draft[questionIndex] === i ? ' checked' : ''}><span>${escape(option)}</span></label>`).join('')}</div></fieldset>
    <div class="assessment-actions"><button class="btn quiet" type="button" data-action="previous"${questionIndex ? '' : ' disabled'}>Previous</button>${questionIndex === attempt.questions.length - 1 ? `<button class="btn primary" type="button" data-action="submit"${answered === attempt.questions.length && !working ? '' : ' disabled'}>Submit assessment</button>` : `<button class="btn primary" type="button" data-action="next">Next question ${icon('arrow')}</button>`}</div>
    <nav class="question-map" aria-label="Jump to a question">${attempt.questions.map((_, i) => `<button type="button" class="btn quiet${draft[i] !== null ? ' answered' : ''}" data-question="${i}" aria-label="Question ${i + 1}${draft[i] !== null ? ', answered' : ''}"${i === questionIndex ? ' aria-current="step"' : ''}>${i + 1}</button>`).join('')}</nav>
    ${questionIndex === attempt.questions.length - 1 && answered !== attempt.questions.length ? '<p class="muted">Answer every question to submit.</p>' : ''}</div>`;
}

function assessment() {
  const heading = '<div class="section-head"><div><span class="eyebrow">THE FINAL STEP</span><h1>Final assessment</h1></div></div>';
  if (sessionState !== 'ready') return `<section class="assessment">${heading}${sessionMessage()}</section>`;
  if (server.attempt) return `<section class="assessment">${heading}${activeQuestion()}</section>`;
  if (server.result) return `<section class="assessment">${heading}${showResult(server.result)}</section>`;
  return `<section class="assessment">${heading}<div class="question-card"><span class="module-icon">${icon('exam')}</span><h2>Put your learning into practice</h2><p>Answer 10 scenario-based questions covering the core product management and project delivery modules. The site draws from an AI-written question bank, shuffles the choices, and grades your answers automatically.</p><p><strong>Pass with 8 out of 10.</strong> Review explanations after submitting. You can retry with a different set of questions.</p><button class="btn primary" type="button" data-action="start"${working ? ' disabled' : ''}>Start assessment ${icon('arrow')}</button></div></section>`;
}

function certificate() {
  const heading = '<div class="section-head"><div><span class="eyebrow">YOUR ACHIEVEMENT</span><h1>Project Management Certificate</h1></div></div>';
  if (sessionState !== 'ready') return `${heading}${sessionMessage()}`;
  const issued = server.certificate;
  if (issued) return `${heading}<div class="certificate-panel"><span class="module-icon">${icon('award')}</span><span class="eyebrow">CERTIFICATE OF COMPLETION</span><h2>${escape(issued.name)}</h2><p>Product Management and Project Delivery</p><p><strong>${issued.score * 10}%</strong> assessment score · ${escape(issued.id)}</p><button type="button" class="btn primary" data-action="download">Download PDF certificate</button></div>`;
  if (!server.eligible) return `${heading}<div class="certificate-panel"><span class="module-icon">${icon('lock')}</span><h2>Certificate locked</h2><p>Complete the final assessment with a score of 80% or higher to unlock one course completion certificate.</p><a class="btn primary" href="#assessment">Go to final assessment ${icon('arrow')}</a></div>`;
  return `${heading}<div class="certificate-panel"><span class="module-icon">${icon('award')}</span><h2>Claim your certificate</h2><p>Enter the name you want printed. You can download the same certificate again from this page.</p><form id="certificate-form"><label class="field">Name on certificate<input name="learnerName" type="text" maxlength="80" autocomplete="name" required></label><button class="btn primary" type="submit">Create my certificate</button></form></div>`;
}

function currentStudy() {
  const [page, id, index] = location.hash.slice(1).split('/');
  if (page === 'modules') return { label: 'All modules', focus: '' };
  if (location.hash === riceHref && course?.guides?.rice) return { label: 'RICE framework', focus: riceHref };
  if (page !== 'lesson') return null;
  const module = course?.modules.find((item) => item.id === Number(id));
  const lesson = module?.lessons[Number(index)];
  return lesson ? { label: lesson.title, focus: lessonHref(module.id, Number(index)) } : null;
}

function renderStudyChat({ focus = false, latest = false } = {}) {
  const study = currentStudy();
  studyChat.hidden = !study;
  if (!study) chatOpen = false;
  chatLauncher.setAttribute('aria-expanded', String(chatOpen));
  chatPanel.hidden = !chatOpen;
  if (!chatOpen) {
    chatContent.replaceChildren();
    return;
  }
  chatContext.textContent = study.label;
  chatContext.title = study.label;
  const active = document.activeElement;
  const selection = chatContent.contains(active) && active.matches('textarea') ? [active.selectionStart, active.selectionEnd] : null;
  const oldTranscript = chatContent.querySelector('.tutor-transcript');
  const oldScroll = oldTranscript?.scrollTop ?? 0;
  chatContent.innerHTML = studio.tutorContent({ embedded: true, lesson: Boolean(study.focus) });
  const transcript = chatContent.querySelector('.tutor-transcript');
  transcript.scrollTop = latest ? transcript.scrollHeight : oldScroll;
  if (focus || selection) {
    const field = chatContent.querySelector('textarea');
    if (field.disabled) {
      chatPanel.querySelector('[data-study-chat-close]').focus({ preventScroll: true });
      return;
    }
    field.focus({ preventScroll: true });
    if (selection && !focus) field.setSelectionRange(...selection);
  }
}

function updateTutorSurface(options) {
  if (location.hash === '#tutor' || location.hash.startsWith('#tutor/')) {
    const active = document.activeElement;
    const selection = active?.matches('#tutor-form textarea') ? [active.selectionStart, active.selectionEnd] : null;
    render();
    if (options?.latest) root.querySelector('.tutor-turn:last-child')?.scrollIntoView({ block: 'nearest' });
    if (options?.focus || selection) {
      const field = root.querySelector('#tutor-form textarea');
      field?.focus({ preventScroll: true });
      if (selection && !options?.focus) field?.setSelectionRange(...selection);
    }
  } else if (chatOpen) renderStudyChat(options);
}

function toggleStudyChat(open, trigger) {
  if (open && !currentStudy()) return;
  chatOpen = open;
  if (open) chatTrigger = trigger;
  renderStudyChat({ focus: open, latest: open });
  if (open) studio.ensureTutor();
  else (chatTrigger?.isConnected ? chatTrigger : chatLauncher).focus({ preventScroll: true });
}

function currentPracticeModule() {
  if (location.hash === practiceHref(guesstimatePractice.id)) return guesstimatePractice;
  const [, id] = /^#practice\/(\d+)$/.exec(location.hash) ?? [];
  return course?.modules.find((module) => module.id === Number(id));
}

function render(moveFocus = false) {
  if (!course) return;
  refreshLessonProgress();
  const [page, modId, index] = (location.hash.slice(1) || 'home').split('/');
  const mod = course.modules.find((item) => item.id === Number(modId));
  const quiz = page === 'practice' ? currentPracticeModule() : null;
  if (page === 'lesson' && mod?.lessons[Number(index)]) root.innerHTML = shell('modules', `Module ${two(mod.id)}`, lessonView(mod, Number(index)));
  else if (location.hash === riceHref && course.guides?.rice) root.innerHTML = shell('modules', 'RICE framework', riceGuideView(course.guides.rice));
  else if (quiz) root.innerHTML = shell('modules', quiz === guesstimatePractice ? quiz.title : `Module ${two(quiz.id)} practice quiz`, practice.view(quiz));
  else if (page === 'modules') root.innerHTML = shell('modules', 'Course library', `<h1>Course library</h1>${library(true)}`);
  else if (page === 'assessment') root.innerHTML = shell('assessment', 'Final assessment', assessment());
  else if (page === 'certificate') root.innerHTML = shell('certificate', 'Certificate', certificate());
  else if (page === 'cases') root.innerHTML = shell('cases', 'Case studies', studio.caseList());
  else if (page === 'case') root.innerHTML = shell('cases', 'Case study', studio.caseDetail(modId));
  else if (page === 'portfolio') root.innerHTML = shell('portfolio', 'My portfolio', studio.portfolio(modId));
  else if (page === 'tutor') root.innerHTML = shell('tutor', 'Course Q&A', studio.tutor());
  else root.innerHTML = shell('home', 'Overview', home());
  renderStudyChat();
  if (moveFocus) {
    root.querySelector('main').focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
}

async function action(fn) {
  if (working) return;
  working = true;
  notice = '';
  root.querySelector('main')?.setAttribute('aria-busy', 'true');
  try { await fn(); } catch (error) { notice = error.message || 'Something went wrong. Please try again.'; }
  finally { working = false; render(); }
}

const studio = createStudio({ getCourse: () => course, escape, icon, blocks, render, updateTutorSurface });
const practice = createModulePractice({
  currentModule: currentPracticeModule,
  reviewHref: (mod) => mod === guesstimatePractice ? opportunitySizingLesson : lessonHref(mod.id, 0),
  continueHref: (mod) => {
    if (mod === guesstimatePractice) return '#modules';
    const next = course.modules[course.modules.indexOf(mod) + 1];
    return next ? lessonHref(next.id, 0) : '#assessment';
  },
  getLocal, setLocal, render, inline, icon,
  focus: () => root.querySelector('[data-practice-focus]')?.focus(),
});
studyChat.innerHTML = `<button class="study-chat-launcher btn primary" type="button" data-study-chat-toggle aria-controls="study-chat-panel" aria-expanded="false">${icon('spark')}<span>Course chat</span></button>
  <aside id="study-chat-panel" class="study-chat-panel" role="dialog" aria-labelledby="study-chat-title" hidden><header class="study-chat-head"><div class="study-chat-title"><span class="module-icon">${icon('spark')}</span><div><strong id="study-chat-title">Course chat</strong><small id="study-chat-context"></small></div></div><button type="button" class="study-chat-close" aria-label="Close course chat" data-study-chat-close>×</button></header><div class="study-chat-content"></div></aside>`;
const chatLauncher = studyChat.querySelector('.study-chat-launcher');
const chatPanel = studyChat.querySelector('.study-chat-panel');
const chatContext = studyChat.querySelector('#study-chat-context');
const chatContent = studyChat.querySelector('.study-chat-content');

studyChat.addEventListener('click', (event) => {
  if (event.target.closest('.tutor-sources a')) {
    toggleStudyChat(false);
    return;
  }
  const button = event.target.closest('button');
  if (!button) return;
  if (button.hasAttribute('data-study-chat-toggle')) toggleStudyChat(!chatOpen, button);
  else if (button.hasAttribute('data-study-chat-close')) toggleStudyChat(false);
  else studio.click(button);
});
studyChat.addEventListener('input', studio.input);
studyChat.addEventListener('submit', studio.submit);
window.addEventListener('keydown', (event) => {
  if (chatOpen && event.key === 'Escape') {
    event.preventDefault();
    toggleStudyChat(false);
  } else if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.target.matches?.('#tutor-form textarea')) {
    event.preventDefault();
    event.target.form.requestSubmit();
  }
});

root.addEventListener('click', (event) => {
  if (event.target.closest('[data-skip]')) {
    event.preventDefault();
    root.querySelector('main')?.focus();
    return;
  }
  const button = event.target.closest('button');
  if (!button) return;
  if (button.hasAttribute('data-study-chat-open')) {
    toggleStudyChat(true, button);
    return;
  }
  if (button.dataset.learningJump) {
    document.getElementById(button.dataset.learningJump)?.focus();
    return;
  }
  if (button.hasAttribute('data-rice-reset')) {
    button.form.reset();
    updateRiceCalculator(button.form);
    return;
  }
  if (studio.click(button)) return;
  if (practice.click(button)) return;
  if (button.hasAttribute('data-copy-code')) {
    const code = button.closest('.lesson-code').querySelector('code');
    const selectCode = () => {
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      button.textContent = 'SQL selected';
    };
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(code.textContent).then(() => { button.textContent = 'Copied'; }, selectCode);
    } else selectCode();
    return;
  }
  if (button.dataset.complete) {
    complete.add(button.dataset.complete);
    setLocal(lessonProgressKey(button.dataset.complete), true);
    location.hash = button.dataset.next;
  } else if (button.dataset.question != null) {
    questionIndex = Number(button.dataset.question);
    render(true);
  } else if (button.dataset.action === 'next' || button.dataset.action === 'previous') {
    questionIndex += button.dataset.action === 'next' ? 1 : -1;
    render(true);
  } else if (button.dataset.action === 'start') action(async () => {
    server.attempt = await api('/start', {});
    questionIndex = 0;
  });
  else if (button.dataset.action === 'submit' && server.attempt) action(async () => {
    try {
      const result = await api('/submit', { id: server.attempt.id, answers: answers() });
      server = { ...server, result, attempt: null, eligible: server.eligible || result.passed };
    } catch (error) {
      if (error.status === 410 || error.status === 404) await refreshServer();
      throw error;
    }
  });
  else if (button.dataset.action === 'refresh') action(refreshServer);
  else if (button.dataset.action === 'reload') window.location.reload();
  else if (button.dataset.action === 'download' && server.certificate) action(() => downloadCertificate(server.certificate));
});

root.addEventListener('change', (event) => {
  if (!event.target.matches('input[name="answer"]') || !server.attempt) return;
  const answer = Number(event.target.value);
  // Separate keys keep tabs answering different questions from replacing each other's work.
  const key = `${assessmentDraftKey(server.attempt.id)}:${questionIndex}`;
  if (setLocal(key, answer)) unsavedAnswers.delete(key);
  else unsavedAnswers.set(key, answer);
  render();
  root.querySelector(`input[name="answer"][value="${answer}"]`)?.focus({ preventScroll: true });
});

root.addEventListener('input', (event) => {
  if (event.target.form?.id === 'rice-form') updateRiceCalculator(event.target.form);
  else studio.input(event);
});

root.addEventListener('submit', (event) => {
  if (event.target.id === 'rice-form') {
    event.preventDefault();
    return;
  }
  if (studio.submit(event)) return;
  if (practice.submit(event)) return;
  if (event.target.id !== 'certificate-form') return;
  event.preventDefault();
  const name = new FormData(event.target).get('learnerName');
  action(async () => { server.certificate = await api('/certificate', { name }); });
});

window.addEventListener('hashchange', () => {
  notice = '';
  render(true);
  if (course) {
    studio.enter();
    void practice.enter();
  }
});

async function boot() {
  try {
    const response = await fetch('/course-content.json');
    if (!response.ok) throw new Error('The course could not load. Refresh this page to try again.');
    course = await response.json();
    render();
    studio.enter();
    void practice.enter();
    await refreshServer();
    if (/^#(?:assessment|certificate)(?:$|\/)/.test(location.hash)) render();
  } catch (error) {
    root.innerHTML = `<main class="page-content"><h1>PM Learning Lab</h1><p role="alert">${escape(error.message)}</p></main>`;
  }
}

boot();
