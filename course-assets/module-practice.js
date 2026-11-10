const QUIZ_LENGTH = 5;
export const GUESSTIMATE_PRACTICE_ID = 'guesstimates';

function isQuestion(question) {
  return Number.isInteger(question?.id) && question.id > 0 &&
    typeof question.prompt === 'string' && question.prompt.trim() &&
    typeof question.explanation === 'string' && question.explanation.trim() &&
    Array.isArray(question.choices) && question.choices.length === 4 &&
    question.choices.every((choice) => typeof choice === 'string' && choice.trim()) &&
    new Set(question.choices).size === 4 && Number.isInteger(question.answerIndex) &&
    question.answerIndex >= 0 && question.answerIndex < question.choices.length;
}

function questionPool(questions) {
  if (!Array.isArray(questions) || questions.length < 2 * QUIZ_LENGTH || !questions.every(isQuestion)) {
    throw new Error('Invalid quiz data');
  }
  const pool = new Map(questions.map((question) => [question.id, question]));
  if (pool.size !== questions.length) throw new Error('Duplicate practice question IDs');
  return pool;
}

function restoreAttempt(saved, pool) {
  if (!Array.isArray(saved?.questionIds) || saved.questionIds.length !== QUIZ_LENGTH ||
    new Set(saved.questionIds).size !== QUIZ_LENGTH || !saved.questionIds.every((id) => pool.has(id)) ||
    !Number.isInteger(saved.step) || saved.step < 0 || saved.step > QUIZ_LENGTH ||
    !Array.isArray(saved.answers) || saved.answers.length > QUIZ_LENGTH ||
    saved.answers.length < saved.step || saved.answers.length > saved.step + 1 ||
    !saved.answers.every((choice, index) => Number.isInteger(choice) && choice >= 0 && choice < pool.get(saved.questionIds[index]).choices.length)) {
    return null;
  }
  return saved;
}

function newAttempt(pool, previous = []) {
  const candidates = [...pool.keys()].filter((id) => !previous.includes(id));
  const questionIds = Array.from({ length: QUIZ_LENGTH }, () => {
    const index = Math.floor(Math.random() * candidates.length);
    return candidates.splice(index, 1)[0];
  });
  return { questionIds, step: 0, answers: [] };
}

export function createModulePractice({ currentModule, reviewHref, continueHref, getLocal, setLocal, render, focus, inline, icon }) {
  const attempts = new Map();
  let bank;
  let loading = false;
  let loadError = false;
  const storageKey = (id) => `pm-learning-lab:practice:v2:${id}`;

  function attemptFor(id, pool) {
    if (attempts.has(id)) return attempts.get(id);
    const key = storageKey(id);
    const saved = getLocal(key, null);
    // Older attempts used the five original questions in their published order.
    const legacy = saved == null ? getLocal(`pm-learning-lab:practice:v1:${id}`, null) : null;
    const prior = legacy ? { ...legacy, questionIds: [...pool.keys()].slice(0, QUIZ_LENGTH) } : saved;
    const attempt = restoreAttempt(prior, pool) ?? newAttempt(pool);
    attempts.set(id, attempt);
    if (attempt !== saved) setLocal(key, attempt);
    return attempt;
  }

  function save(id, attempt) {
    attempts.set(id, attempt);
    setLocal(storageKey(id), attempt);
    render();
  }

  async function enter() {
    if (!currentModule() || bank || loading) return;
    loading = true;
    loadError = false;
    try {
      const response = await fetch('/module-practice.json');
      if (!response.ok) throw new Error('Quiz unavailable');
      const quizzes = await response.json();
      if (!Array.isArray(quizzes)) throw new Error('Invalid quiz data');
      const pools = new Map();
      for (const quiz of quizzes) {
        if (!Number.isInteger(quiz?.module) || pools.has(quiz.module) ||
          !Array.isArray(quiz.questions) || quiz.questions.length !== QUIZ_LENGTH ||
          !Array.isArray(quiz.alternates)) throw new Error('Invalid quiz data');
        pools.set(quiz.module, questionPool([...quiz.questions, ...quiz.alternates]));
        const estimates = quiz[GUESSTIMATE_PRACTICE_ID];
        if (estimates !== undefined) {
          if (pools.has(GUESSTIMATE_PRACTICE_ID)) throw new Error('Duplicate guesstimate quiz');
          pools.set(GUESSTIMATE_PRACTICE_ID, questionPool(estimates));
        }
      }
      bank = pools;
    } catch {
      loadError = true;
    } finally {
      loading = false;
      if (currentModule()) render();
    }
  }

  function explain(question, selected) {
    return `<dl class="practice-answers"><div><dt>Your answer</dt><dd>${inline(question.choices[selected])}</dd></div>${selected === question.answerIndex ? '' : `<div><dt>Correct answer</dt><dd>${inline(question.choices[question.answerIndex])}</dd></div>`}</dl><p><strong>Why</strong> ${inline(question.explanation)}</p>`;
  }

  function view(module) {
    const heading = module.eyebrow ?? `MODULE ${String(module.id).padStart(2, '0')} · PRACTICE QUIZ`;
    const header = `<div class="section-head"><div><span class="eyebrow">${inline(heading)}</span><h1>${inline(module.title)}</h1></div></div>`;
    const reviewLink = `<a class="btn quiet" href="${reviewHref(module)}">${inline(module.reviewLabel ?? 'Review module')}</a>`;
    const wrap = (body) => `<section class="assessment">${header}${body}</section>`;
    const pool = bank?.get(module.id);
    if (!pool) {
      if (loadError || bank) return wrap(`<div class="notice"><p>The practice quiz is temporarily unavailable.</p>${loadError ? '<button type="button" class="btn secondary" data-practice-action="retry-load">Try again</button>' : ''}${reviewLink}</div>`);
      return wrap('<div class="notice" role="status">Loading your practice quiz…</div>');
    }

    const { questionIds, step, answers } = attemptFor(module.id, pool);
    const questions = questionIds.map((id) => pool.get(id));
    if (step === QUIZ_LENGTH) {
      const missed = questions.map((question, index) => ({ question, index })).filter(({ question, index }) => answers[index] !== question.answerIndex);
      const review = missed.length ? `<div class="review-list"><h2>Review missed questions</h2>${missed.map(({ question, index }) => `<details class="notice"><summary>${index + 1}. Incorrect · ${inline(question.prompt)}</summary>${explain(question, answers[index])}</details>`).join('')}</div>` : '';
      const next = continueHref(module);
      const nextLabel = module.continueLabel ?? (next === '#assessment' ? 'Go to final assessment' : 'Continue to next module');
      return wrap(`<div class="result-panel"><span class="eyebrow">PRACTICE COMPLETE</span><h2 tabindex="-1" data-practice-focus>${QUIZ_LENGTH - missed.length} of ${QUIZ_LENGTH} correct</h2>
        <p>Your next set will have five different questions.</p><div class="assessment-actions"><a class="btn primary" href="${next}">${inline(nextLabel)} ${icon('arrow')}</a><button class="btn secondary" type="button" data-practice-action="restart">Try a new set</button>${reviewLink}</div></div>${review}`);
    }

    const question = questions[step];
    const selected = answers[step];
    const answered = selected !== undefined;
    const correct = selected === question.answerIndex;
    const feedback = answered ? `<div class="notice practice-feedback ${correct ? 'correct' : 'incorrect'}" role="status" tabindex="-1" data-practice-focus><strong class="practice-verdict">${correct ? 'Your answer was correct.' : 'Your answer was incorrect.'}</strong>${explain(question, selected)}</div>` : '';
    const choices = question.choices.map((choice, index) => `<label class="option"><input type="radio" name="practice-answer" value="${index}" required${index === selected ? ' checked' : ''}><span>${inline(choice)}</span></label>`).join('');
    return wrap(`<p class="muted">${inline(module.intro ?? 'Practice what you learned and get feedback after each answer. Your score is for practice.')}</p>
      <form class="question-card" id="module-practice-form"><div class="section-head"><span class="eyebrow">QUESTION ${step + 1} OF ${QUIZ_LENGTH}</span><span class="pill">${answers.length}/${QUIZ_LENGTH} ANSWERED</span></div>
        <div class="progress-track" aria-hidden="true"><span style="width:${answers.length * 100 / QUIZ_LENGTH}%"></span></div>
        <fieldset${answered ? ' disabled' : ''}><legend tabindex="-1"${answered ? '' : ' data-practice-focus'}>${inline(question.prompt)}</legend><div class="options">${choices}</div></fieldset>
        ${feedback}<div class="assessment-actions">${answered ? `<button class="btn primary" type="button" data-practice-action="next">${step + 1 === QUIZ_LENGTH ? 'See results' : 'Next question'} ${icon('arrow')}</button>` : '<button class="btn primary" type="submit">Check answer</button>'}${reviewLink}</div>
      </form>`);
  }

  function submit(event) {
    if (event.target.id !== 'module-practice-form') return false;
    event.preventDefault();
    const module = currentModule();
    const pool = bank?.get(module?.id);
    const value = event.target.elements.namedItem('practice-answer')?.value ?? '';
    if (!pool || !/^[0-3]$/.test(value)) return true;
    const attempt = attemptFor(module.id, pool);
    if (attempt.step < QUIZ_LENGTH && attempt.answers.length === attempt.step) {
      save(module.id, { ...attempt, answers: [...attempt.answers, Number(value)] });
      focus();
    }
    return true;
  }

  function click(button) {
    const action = button.dataset.practiceAction;
    if (!action) return false;
    if (action === 'retry-load') {
      loadError = false;
      render();
      void enter();
      return true;
    }
    const module = currentModule();
    const pool = bank?.get(module?.id);
    if (!pool) return true;
    const attempt = attemptFor(module.id, pool);
    if (action === 'restart' && attempt.step === QUIZ_LENGTH) save(module.id, newAttempt(pool, attempt.questionIds));
    else if (action === 'next' && attempt.step < QUIZ_LENGTH && attempt.answers.length === attempt.step + 1) {
      save(module.id, { ...attempt, step: attempt.step + 1 });
    }
    focus();
    return true;
  }

  return { enter, view, submit, click };
}
