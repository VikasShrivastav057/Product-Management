const suggestions = [
  'How does a LEFT JOIN affect a retention metric?',
  'What evidence would show product-market fit?',
  'How do I choose guardrails for a pricing experiment?',
];
const lessonSuggestions = ['What should I remember from this lesson?', 'Can you show a practical example?'];

export function createStudio({ getCourse, escape, icon, blocks, render, updateTutorSurface }) {
  let entries = null;
  let portfolioLoading = false;
  let portfolioError = '';
  let portfolioMessage = '';
  let sending = false;
  let draft = { title: '', demoUrl: '', caseId: '' };
  let selectedFile = null;
  let uploadKey = null;
  let removing = '';
  let tutorMode = null;
  let checkingTutor = false;
  let asking = false;
  let tutorError = '';
  let question = '';
  let turns = [];
  const pageName = () => location.hash.slice(1).split('/')[0];
  const update = (page) => {
    if (pageName() !== page) return;
    const active = document.activeElement;
    const name = active?.form?.id === 'portfolio-form' ? active.name : '';
    const selection = name && active.selectionStart != null
      ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
    render();
    if (!name) return;
    const field = document.getElementById('portfolio-form')?.elements.namedItem(name);
    field?.focus({ preventScroll: true });
    if (selection) field?.setSelectionRange(...selection);
  };
  const heading = (tag, title, description) => `<header class="studio-header"><span class="eyebrow">${tag}</span><h1>${title}</h1><p>${description}</p></header>`;

  async function request(path, init) {
    const response = await fetch(path, init);
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error || 'The request didn’t go through. Please try again.');
    return value;
  }

  const caseById = (id) => getCourse().cases.find((item) => item.id === id);
  const caseHref = (id) => `#case/${encodeURIComponent(id)}`;
  const portfolioHref = (id) => `#portfolio/${encodeURIComponent(id)}`;

  function caseList() {
    return `${heading('CASE STUDIO', 'Case studies', 'Practice making a product decision with evidence, constraints, and a concrete deliverable. Open the worked solution after you’ve made your own recommendation.')}
      <div class="section-head"><h2>${getCourse().cases.length} practice cases</h2><a class="btn secondary" href="#portfolio">My portfolio ${icon('layers')}</a></div>
      <div class="module-grid case-grid">${getCourse().cases.map((item, i) => `<a class="module-card" href="${caseHref(item.id)}">
        <div class="module-top"><span class="module-icon">${icon(['compass', 'chart', 'search', 'calendar', 'flag', 'layers', 'spark'][i % 7])}</span><span class="module-meta">${escape(item.tag)}</span></div>
        <h3>${escape(item.title)}</h3><p>${escape(item.summary)}</p><div class="module-footer"><span>Open case</span>${icon('arrow')}</div></a>`).join('')}</div>`;
  }

  function caseDetail(id) {
    const item = caseById(id) || getCourse().cases[0];
    return `<div class="lesson-layout"><article class="lesson-body"><a class="text-link studio-back" href="#cases">← All case studies</a><span class="eyebrow">CASE STUDY · ${escape(item.tag)}</span><h1>${escape(item.title)}</h1><p class="case-intro">${escape(item.summary)}</p><div class="prose">${blocks(item)}</div>
      ${item.solution.length ? `<details class="worked-solution"><summary>Reveal the worked solution</summary><div class="prose">${blocks({ blocks: item.solution })}</div></details>` : ''}
      </article><aside class="lesson-outline studio-side"><span class="eyebrow">YOUR DELIVERABLE</span><h2>Make it yours</h2><p>${escape(item.deliverable)}</p><a class="btn primary" href="${portfolioHref(item.id)}">Upload my work ${icon('arrow')}</a><a class="text-link" href="#tutor/case/${encodeURIComponent(item.id)}">Ask about this case ${icon('spark')}</a></aside></div>`;
  }

  function fileSize(bytes) {
    return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function portfolio(id) {
    const chosen = draft.caseId || caseById(id)?.id || '';
    const locked = sending ? ' disabled' : '';
    const items = entries?.map((item) => {
      const file = item.filename ? `<a class="text-link" href="/api/portfolio/${encodeURIComponent(item.id)}">Download ${escape(item.filename)} <span class="muted">(${fileSize(item.size)})</span></a>` : '';
      const link = item.demo_url?.startsWith('https://') ? `<a class="text-link" href="${escape(item.demo_url)}" target="_blank" rel="noopener noreferrer">Open demo link ↗</a>` : '';
      return `<article class="portfolio-entry"><span class="eyebrow">${escape(caseById(item.case_id)?.title || 'Case submission')}</span><h3>${escape(item.title)}</h3><div class="portfolio-links">${file}${link}</div>
        <details class="remove-entry"><summary>Remove entry</summary><p>Remove this entry and its uploaded file?</p><button class="btn quiet" type="button" data-remove-entry="${escape(item.id)}"${removing ? ' disabled' : ''}>Remove permanently</button></details></article>`;
    }).join('');
    return `${heading('YOUR PRIVATE WORKSPACE', 'Case portfolio', 'Save your own case-study documents, spreadsheets, slide decks, screenshots, or a link to a demo.')}
      <div class="studio-columns"><section class="studio-panel"><h2>Add case work</h2><form id="portfolio-form" class="studio-form">
        <label class="field">Case study<select name="caseId" required${locked}><option value=""${!chosen ? ' selected' : ''} disabled>Choose a case</option>${getCourse().cases.map((item) => `<option value="${escape(item.id)}"${item.id === chosen ? ' selected' : ''}>${escape(item.title)}</option>`).join('')}</select></label>
        <label class="field">Title<input name="title" maxlength="120" placeholder="e.g. Retention analysis and rollout plan" required value="${escape(draft.title)}"${locked}></label>
        <label class="field">Document or demo file<input name="file" type="file" aria-describedby="file-help"${locked}><small id="file-help">One file up to 4 MiB.${selectedFile ? ` Selected ${escape(selectedFile.name)}.` : ''}</small></label>${selectedFile ? `<button class="btn quiet" type="button" data-clear-file${locked}>Clear selected file</button>` : ''}
        <label class="field">HTTPS demo link <span class="muted">(optional if you add a file)</span><input type="url" name="demoUrl" maxlength="2048" placeholder="https://…" value="${escape(draft.demoUrl)}"${locked}></label>
        <button class="btn primary" type="submit"${sending || entries === null ? ' disabled' : ''}>${sending ? 'Saving…' : 'Save to portfolio'} ${icon('arrow')}</button></form></section>
      <section class="studio-panel"><h2>Saved work</h2><p class="muted">Your entries are private to this browser session.</p>${portfolioError ? `<div class="notice studio-error" role="alert">${escape(portfolioError)}</div>` : portfolioMessage ? `<div class="notice" role="status">${escape(portfolioMessage)}</div>` : ''}
        ${portfolioLoading ? '<p role="status">Loading your portfolio…</p>' : items || '<div class="portfolio-empty"><p>Your portfolio is empty. Start with a case study and save your deliverable here.</p><a class="text-link" href="#cases">Explore case studies</a></div>'}
        ${entries === null && !portfolioLoading && portfolioError ? '<button type="button" class="btn secondary" data-portfolio-retry>Reload portfolio</button>' : ''}</section></div>`;
  }

  function sourceHref(value) {
    return /^#(?:lesson\/\d+\/\d+|case\/[a-z0-9_-]+|guide\/rice)$/i.test(value) ? value : '#modules';
  }

  function tutor() {
    return `${heading('COURSE Q&A', 'Ask about the course', 'Ask about product strategy, a SQL query, a case, or any other course topic. Follow the source links to keep learning.')}
      <div class="studio-panel tutor-panel">${tutorContent()}</div>`;
  }

  function tutorContent({ embedded = false, lesson = false } = {}) {
    const isAI = tutorMode === 'ai';
    const status = isAI ? 'AI answers with course references' : tutorMode === 'search' ? 'Answers from the course material' : 'Answers with course references';
    const messages = turns.map(({ asked, reply }) => `<article class="tutor-turn"><p class="tutor-question">${escape(asked)}</p>${reply.answer ? `<div class="tutor-answer">${reply.mode === 'search' ? '<span class="tutor-answer-label">From the course</span>' : ''}${escape(reply.answer)}</div>` : ''}${reply.note ? `<p class="muted">${escape(reply.note)}</p>` : ''}
      ${reply.sources?.length ? `<div class="tutor-sources"><strong>${reply.answer ? 'Course references' : 'Matching course material'}</strong><ol>${reply.sources.map((source) => `<li><a class="text-link" href="${sourceHref(source.href)}">${escape(source.title)}</a><small>${escape(source.section)}</small>${reply.answer ? '' : `<p>${escape(source.excerpts[0])}</p>`}</li>`).join('')}</ol></div>` : !reply.note ? '<p>No matching lesson found. Try a course term such as retention, RICE, or SQL joins.</p>' : ''}</article>`).join('');
    const welcome = lesson ? 'Ask about a term, an example, or the main idea in this lesson.' : 'Ask a question about any module in the course.';
    const starterQuestions = lesson ? lessonSuggestions : suggestions;
    return `${embedded ? '' : `<div class="tutor-top"><span class="module-icon">${icon('spark')}</span><div><h2>Learning assistant</h2><p class="muted">${status}</p></div></div>`}
      <div class="tutor-transcript" role="log" aria-label="Course chat conversation" aria-live="polite" tabindex="0">${messages}${!turns.length && !asking ? `<p class="tutor-welcome">${welcome}</p>` : ''}${asking ? `<article class="tutor-turn"><p class="tutor-question">${escape(question)}</p><p role="status">Checking the course material…</p></article>` : ''}${tutorError ? `<div class="notice studio-error" role="alert">${escape(tutorError)}</div>` : ''}</div>
      ${!turns.length && !asking ? `<div class="prompt-chips">${starterQuestions.map((text) => `<button type="button" class="btn secondary" data-suggest-question="${escape(text)}">${escape(text)}</button>`).join('')}</div>` : ''}
      <form class="studio-form tutor-form" id="tutor-form"><label class="field"><span${embedded ? ' class="sr-only"' : ''}>Your question</span><textarea name="question" rows="${embedded ? 2 : 3}" maxlength="1000" placeholder="Ask a question…" required${asking ? ' disabled' : ''}>${asking ? '' : escape(question)}</textarea></label>
        <div class="tutor-actions"><button class="btn primary" type="submit"${asking ? ' disabled' : ''}>Send ${icon('arrow')}</button>${turns.length ? '<button type="button" class="btn quiet" data-clear-tutor' + (asking ? ' disabled' : '') + '>Clear chat</button>' : ''}</div>
        ${tutorMode !== 'search' ? '<small class="muted tutor-privacy">When AI is available, Groq receives your question, recent questions, and related course excerpts.</small>' : ''}</form>`;
  }

  async function refreshPortfolio() {
    if (portfolioLoading) return;
    portfolioLoading = true;
    portfolioError = '';
    update('portfolio');
    try { entries = (await request('/api/portfolio')).entries; }
    catch (error) { portfolioError = error.message; }
    finally { portfolioLoading = false; update('portfolio'); }
  }

  async function ensureTutor() {
    if (checkingTutor || tutorMode !== null) return;
    checkingTutor = true;
    try { tutorMode = (await request('/api/tutor')).mode; }
    catch { /* A later visit can retry checking the tutor mode. */ }
    finally { checkingTutor = false; updateTutorSurface(); }
  }

  function enter() {
    const [page, id] = location.hash.slice(1).split('/');
    if (page === 'portfolio') {
      const linkedCase = caseById(id);
      const caseChanged = linkedCase && linkedCase.id !== draft.caseId;
      if (caseChanged) {
        draft.caseId = linkedCase.id;
        uploadKey = null;
      }
      if (entries === null && !portfolioLoading) void refreshPortfolio();
      else if (caseChanged) update('portfolio');
    }
    if (page === 'tutor') void ensureTutor();
  }

  function click(button) {
    if (button.hasAttribute('data-portfolio-retry')) { void refreshPortfolio(); return true; }
    if (button.hasAttribute('data-clear-file')) { selectedFile = null; uploadKey = null; update('portfolio'); return true; }
    if (button.dataset.removeEntry) {
      if (removing) return true;
      removing = button.dataset.removeEntry;
      button.disabled = true;
      const entryId = removing;
      void request(`/api/portfolio/${encodeURIComponent(entryId)}`, { method: 'DELETE' }).then(() => {
        entries = (entries || []).filter(({ id }) => id !== entryId);
        portfolioError = '';
        portfolioMessage = 'Entry removed.';
      }).catch((error) => { portfolioError = error.message; }).finally(() => { removing = ''; update('portfolio'); });
      return true;
    }
    if (button.dataset.suggestQuestion) {
      const field = document.querySelector('#tutor-form textarea');
      question = button.dataset.suggestQuestion;
      field.value = question;
      field.focus();
      return true;
    }
    if (button.hasAttribute('data-clear-tutor')) {
      if (!asking) { turns = []; question = ''; tutorError = ''; updateTutorSurface({ focus: true }); }
      return true;
    }
    return false;
  }

  function submit(event) {
    const form = event.target;
    if (form.id === 'portfolio-form') {
      event.preventDefault();
      if (sending || entries === null) return true;
      const data = new FormData(form);
      const newFile = data.get('file');
      if (newFile?.size) selectedFile = newFile;
      if (selectedFile) data.set('file', selectedFile);
      else data.delete('file');
      const nextDraft = { caseId: data.get('caseId'), title: data.get('title'), demoUrl: data.get('demoUrl') };
      if (newFile?.size || JSON.stringify(nextDraft) !== JSON.stringify(draft)) uploadKey = null;
      draft = nextDraft;
      if (!selectedFile && !draft.demoUrl?.trim()) { portfolioError = 'Add a file or an HTTPS demo link.'; update('portfolio'); return true; }
      if (selectedFile?.size > 4 * 1024 * 1024) { selectedFile = null; portfolioError = 'Choose a file no larger than 4 MiB.'; update('portfolio'); return true; }
      sending = true;
      portfolioError = '';
      portfolioMessage = '';
      uploadKey ??= crypto.randomUUID();
      update('portfolio');
      void request('/api/portfolio', { method: 'POST', headers: { 'Idempotency-Key': uploadKey }, body: data }).then((entry) => {
        entries = [entry, ...(entries || []).filter(({ id }) => id !== entry.id)];
        draft = { caseId: '', title: '', demoUrl: '' };
        selectedFile = null;
        uploadKey = null;
        portfolioMessage = 'Saved to your portfolio.';
      }).catch((error) => { portfolioError = error.message; }).finally(() => { sending = false; update('portfolio'); });
      return true;
    }
    if (form.id === 'tutor-form') {
      event.preventDefault();
      if (asking) return true;
      question = new FormData(form).get('question').trim();
      if (!question) return true;
      const asked = question;
      const route = location.hash.slice(1).split('/');
      const [context, mod, index] = route[0] === 'tutor' ? route.slice(1) : route;
      const focus = context === 'lesson' ? `#lesson/${mod}/${index}` : context === 'case' ? `#case/${mod}` : context === 'guide' && mod === 'rice' ? '#guide/rice' : '';
      asking = true;
      tutorError = '';
      updateTutorSurface({ latest: true });
      void request('/api/tutor', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: asked, focus, previous: turns.slice(-2).map((turn) => turn.asked) }),
      }).then((reply) => { turns = [...turns.slice(-7), { asked, reply }]; question = ''; })
        .catch((error) => { tutorError = error.message; }).finally(() => {
          asking = false;
          const active = document.activeElement;
          updateTutorSurface({ latest: true, focus: active === document.body || Boolean(active?.closest('#tutor-form')) });
        });
      return true;
    }
    return false;
  }

  function input(event) {
    const field = event.target;
    if (field.form?.id === 'tutor-form' && field.name === 'question') question = field.value;
    if (field.form?.id !== 'portfolio-form' || sending) return;
    if (field.name === 'file') selectedFile = field.files[0] ?? null;
    else if (Object.hasOwn(draft, field.name)) draft[field.name] = field.value;
    uploadKey = null;
  }

  return { caseList, caseDetail, portfolio, tutor, tutorContent, ensureTutor, enter, click, submit, input };
}
