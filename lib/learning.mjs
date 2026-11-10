const TOTAL = 10;
const PASS = 8;
const OPEN_WINDOW = 24 * 60 * 60 * 1000;

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

function shuffle(items) {
  return items.map((item) => ({ item, order: crypto.getRandomValues(new Uint32Array(1))[0] }))
    .sort((a, b) => a.order - b.order).map(({ item }) => item);
}

function publicQuestion({ id, prompt, options, module }) {
  return { id, prompt, options, module };
}

function parseAttempt(row) {
  const questions = JSON.parse(row.items_json);
  return { id: row.id, questions: questions.map(publicQuestion) };
}

function resultFor(row) {
  const answers = JSON.parse(row.answers_json);
  const questions = JSON.parse(row.items_json);
  return {
    correct: row.score,
    total: TOTAL,
    percent: 100 * row.score / TOTAL,
    passed: row.score >= PASS,
    review: questions.map((question, index) => ({
      prompt: question.prompt,
      answer: question.options[answers[index]],
      expected: question.options[question.correct],
      correct: question.correct === answers[index],
      rationale: question.rationale,
      module: question.module,
    })),
  };
}

async function state(db, user) {
  const [latest, certificate, qualification] = await Promise.all([
    db.prepare('SELECT * FROM attempts WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').bind(user).first(),
    db.prepare('SELECT id, name, score, awarded_at FROM certificates WHERE user_id = ?').bind(user).first(),
    db.prepare('SELECT MAX(score) AS best FROM attempts WHERE user_id = ?').bind(user).first(),
  ]);
  return {
    attempt: latest?.score == null && latest?.created_at > Date.now() - OPEN_WINDOW ? parseAttempt(latest) : null,
    result: latest?.score != null ? resultFor(latest) : null,
    eligible: (qualification?.best ?? 0) >= PASS,
    certificate,
  };
}

async function start(db, user, bank) {
  const readLatest = db.prepare('SELECT * FROM attempts WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').bind(user);
  const latest = await readLatest.first();
  if (latest?.score == null && latest?.created_at > Date.now() - OPEN_WINDOW) return json(parseAttempt(latest));
  const previous = new Set(latest ? JSON.parse(latest.items_json).map(({ id }) => id) : []);
  const selected = [];
  for (let module = 1; module <= TOTAL; module++) {
    const question = shuffle(bank.filter((item) => item.module === module && !previous.has(item.id)))[0];
    const order = shuffle([0, 1, 2, 3]);
    selected.push({ ...question, options: order.map((i) => question.options[i]), correct: order.indexOf(question.correct) });
  }
  const id = crypto.randomUUID();
  const items = shuffle(selected);
  const createdAt = Math.max(Date.now(), (latest?.created_at ?? 0) + 1);
  // Only one caller can create the next attempt from the same prior attempt.
  const created = await db.prepare(`INSERT INTO attempts (id, user_id, items_json, created_at)
    SELECT ?, ?, ?, ?
    WHERE (SELECT id FROM attempts WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1) IS ?
    RETURNING id, items_json`)
    .bind(id, user, JSON.stringify(items), createdAt, user, latest?.id ?? null).first();
  return json(parseAttempt(created ?? await readLatest.first()));
}

async function submit(db, user, body) {
  if (typeof body?.id !== 'string' || !Array.isArray(body.answers) || body.answers.length !== TOTAL ||
      body.answers.some((answer) => !Number.isInteger(answer) || answer < 0 || answer > 3)) {
    return json({ error: 'Answer all 10 questions before submitting.' }, 400);
  }
  const readAttempt = () => db.prepare('SELECT * FROM attempts WHERE id = ? AND user_id = ?').bind(body.id, user).first();
  const attempt = await readAttempt();
  if (!attempt) return json({ error: 'This attempt could not be found. Start the assessment again.' }, 404);
  if (attempt.score != null) return json(resultFor(attempt));
  if (attempt.created_at < Date.now() - OPEN_WINDOW) return json({ error: 'This attempt has expired. Start a new attempt.' }, 410);
  const items = JSON.parse(attempt.items_json);
  const score = items.reduce((sum, item, index) => sum + Number(item.correct === body.answers[index]), 0);
  await db.prepare('UPDATE attempts SET score = ?, answers_json = ? WHERE id = ? AND user_id = ? AND score IS NULL')
    .bind(score, JSON.stringify(body.answers), body.id, user).run();
  return json(resultFor(await readAttempt()));
}

async function issue(db, user, body) {
  const lookup = () => db.prepare('SELECT id, name, score, awarded_at FROM certificates WHERE user_id = ?').bind(user).first();
  const existing = await lookup();
  if (existing) return json(existing);
  const name = typeof body?.name === 'string' ? body.name.normalize('NFC').trim().replace(/\s+/gu, ' ') : '';
  if (!name || [...name].length > 80 || /[\p{Cc}\p{Cf}]/u.test(name)) {
    return json({ error: 'Enter the name to print on the certificate, up to 80 characters.' }, 400);
  }
  await db.prepare(`INSERT OR IGNORE INTO certificates (user_id, id, name, score, awarded_at)
    SELECT ?, ?, ?, score, ? FROM attempts WHERE user_id = ? AND score >= ?
    ORDER BY created_at ASC, id ASC LIMIT 1`)
    .bind(user, `PML-${crypto.randomUUID().slice(0, 13).toUpperCase()}`, name, Date.now(), user, PASS).run();
  const certificate = await lookup();
  return certificate ? json(certificate, 201) : json({ error: 'A score of 80% or higher is required to unlock the certificate.' }, 403);
}

export async function handleLearning(request, db, bank) {
  const user = request.headers.get('oai-authenticated-user-id');
  if (!user) return json({ error: 'Sign in to save an attempt and claim your certificate.' }, 401);
  if (!db) return json({ error: 'Assessment storage is temporarily unavailable. Please try again shortly.' }, 503);
  const url = new URL(request.url);
  const endpoint = url.pathname.replace(/\/$/, '').split('/').at(-1);
  if (request.method === 'GET' && endpoint === 'learning') return json(await state(db, user));
  if (request.method !== 'POST') return json({ error: 'This action is unavailable.' }, 405);
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return json({ error: 'This action must come from the course website.' }, 403);
  if (endpoint === 'start') return start(db, user, bank);
  if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ error: 'Invalid request.' }, 400);
  let body;
  try {
    const raw = await request.text();
    if (raw.length > 4096) return json({ error: 'This submission is too large.' }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'This submission could not be read.' }, 400);
  }
  if (endpoint === 'submit') return submit(db, user, body);
  if (endpoint === 'certificate') return issue(db, user, body);
  return json({ error: 'This action is unavailable.' }, 404);
}
