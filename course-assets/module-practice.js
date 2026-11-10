function isQuestion(question) {
  return typeof question?.prompt === 'string' && question.prompt.trim() &&
    typeof question.explanation === 'string' && question.explanation.trim() &&
    Array.isArray(question.choices) && question.choices.length === 4 &&
    question.choices.every((choice) => typeof choice === 'string' && choice.trim()) &&
    new Set(question.choices).size === 4 && Number.isInteger(question.answerIndex) &&
    question.answerIndex >= 0 && question.answerIndex < question.choices.length;
}

function restoreAttempt(saved, questions) {
  if (!saved || !Number.isInteger(saved.step) || saved.step < 0 || saved.step > questions.length ||
    !Array.isArray(saved.answers) || saved.answers.length > questions.length ||
    saved.answers.length < saved.step || saved.answers.length > saved.step + 1 ||
    !saved.answers.every((choice, index) => Number.isInteger(choice) && choice >= 0 && choice < questions[index].choices.length)) {
    return { step: 0, answers: [] };
  }
  return saved;
}

export function createModulePractice({ currentModule, reviewHref, continueHref, getLocal, setLocal, render, focus, inline, icon }) {
  const attempts = new Map();
  let bank;
  let loading = false;
  let loadError = false;
  const storageKey = (id) => `pm-learning-lab:practice:v1:${id}`;

  function attemptFor(id, questions) {
    if (!attempts.has(id)) attempts.set(id, restoreAttempt(getLocal(storageKey(id), null), questions));
    return attempts.get(id);
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
      if (!Array.isArray(quizzes) || !quizzes.every((quiz) => Number.isInteger(quiz?.module) &&
        Array.isArray(quiz.questions) && quiz.questions.length === 5 && quiz.questions.every(isQuestion)) ||
        new Set(quizzes.map(({ module }) => module)).size !== quizzes.length) throw new Error('Invalid quiz data');
      bank = new Map(quizzes.map(({ module, questions }) => [module, questions]));
    } catch {
      loadError = true;
    } finally {
      loading = false;
      if (currentModule()) render();
    }
  }

  function view(module) {
    const header = `<div class="section-head"><div><span class="eyebrow">MODULE ${String(module.id).padStart(2, '0')} · PRACTICE QUIZ</span><h1>${inline(module.title)}</h1></div></div>`;
    const wrap = (body) => `<section class="assessment">${header}${body}</section>`;
    const questions = bank?.get(module.id);
    if (!questions) {
      if (loadError || bank) return wrap(`<div class="notice"><p>The practice quiz is temporarily unavailable.</p>${loadError ? '<button type="button" class="btn secondary" data-practice-action="retry-load">Try again</button>' : ''}<a class="btn quiet" href="${reviewHref(module)}">Review module</a></div>`);
      return wrap('<div class="notice" role="status">Loading your practice quiz…</div>');
    }

    const { step, answers } = attemptFor(module.id, questions);
    if (step === questions.length) {
      const missed = questions.map((question, index) => ({ question, index })).filter(({ question, index }) => answers[index] !== question.answerIndex);
      const review = missed.length ? `<div class="review-list"><h2>Review missed questions</h2>${missed.map(({ question, index }) => `<details class="notice"><summary>${index + 1}. ${inline(question.prompt)}</summary><p><strong>Your answer</strong> ${inline(question.choices[answers[index]])}</p><p><strong>Correct answer</strong> ${inline(question.choices[question.answerIndex])}</p><p>${inline(question.explanation)}</p></details>`).join('')}</div>` : '';
      const next = continueHref(module);
      return wrap(`<div class="result-panel"><span class="eyebrow">PRACTICE COMPLETE</span><h2 tabindex="-1" data-practice-focus>${questions.length - missed.length} of ${questions.length} correct</h2>
        <div class="assessment-actions"><a class="btn primary" href="${next}">${next === '#assessment' ? 'Go to final assessment' : 'Continue to next module'} ${icon('arrow')}</a><button class="btn secondary" type="button" data-practice-action="restart">Retry quiz</button><a class="btn quiet" href="${reviewHref(module)}">Review module</a></div></div>${review}`);
    }

    const question = questions[step];
    const selected = answers[step];
    const answered = selected !== undefined;
    const correct = selected === question.answerIndex;
    const feedback = answered ? `<div class="notice practice-feedback ${correct ? 'correct' : 'incorrect'}" role="status" tabindex="-1" data-practice-focus><strong>${correct ? 'Correct' : 'Incorrect'}</strong>${correct ? '' : `<p><strong>Correct answer</strong> ${inline(question.choices[question.answerIndex])}</p>`}<p>${inline(question.explanation)}</p></div>` : '';
    const choices = question.choices.map((choice, index) => `<label class="option"><input type="radio" name="practice-answer" value="${index}" required${index === selected ? ' checked' : ''}><span>${inline(choice)}</span></label>`).join('');
    return wrap(`<p class="muted">Practice what you learned and get feedback after each answer. Your score is for practice.</p>
      <form class="question-card" id="module-practice-form"><div class="section-head"><span class="eyebrow">QUESTION ${step + 1} OF ${questions.length}</span><span class="pill">${answers.length}/${questions.length} ANSWERED</span></div>
        <div class="progress-track" aria-hidden="true"><span style="width:${answers.length * 100 / questions.length}%"></span></div>
        <fieldset${answered ? ' disabled' : ''}><legend tabindex="-1"${answered ? '' : ' data-practice-focus'}>${inline(question.prompt)}</legend><div class="options">${choices}</div></fieldset>
        ${feedback}<div class="assessment-actions">${answered ? `<button class="btn primary" type="button" data-practice-action="next">${step + 1 === questions.length ? 'See results' : 'Next question'} ${icon('arrow')}</button>` : '<button class="btn primary" type="submit">Check answer</button>'}<a class="btn quiet" href="${reviewHref(module)}">Review module</a></div>
      </form>`);
  }

  function submit(event) {
    if (event.target.id !== 'module-practice-form') return false;
    event.preventDefault();
    const module = currentModule();
    const questions = bank?.get(module?.id);
    const value = event.target.elements.namedItem('practice-answer')?.value ?? '';
    if (!questions || !/^[0-3]$/.test(value)) return true;
    const { step, answers } = attemptFor(module.id, questions);
    if (step < questions.length && answers.length === step) {
      save(module.id, { step, answers: [...answers, Number(value)] });
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
    const questions = bank?.get(module?.id);
    if (!questions) return true;
    const { step, answers } = attemptFor(module.id, questions);
    if (action === 'restart' && step === questions.length) save(module.id, { step: 0, answers: [] });
    else if (action === 'next' && step < questions.length && answers.length === step + 1) save(module.id, { step: step + 1, answers });
    focus();
    return true;
  }

  return { enter, view, submit, click };
}
