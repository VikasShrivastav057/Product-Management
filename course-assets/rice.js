const impactOptions = [[3, 'Massive'], [2, 'High'], [1, 'Medium'], [0.5, 'Low'], [0.25, 'Minimal']];
const confidenceOptions = [100, 80, 50];
const format = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

export function riceScore({ reach, impact, confidence, effort }) {
  if (![reach, impact, confidence, effort].every(Number.isFinite) ||
    reach < 0 || impact < 0 || confidence < 0 || confidence > 100 || effort <= 0) return null;
  const score = reach * impact * (confidence / 100) / effort;
  return Number.isFinite(score) ? score : null;
}

function expression({ reach, impact, confidence, effort }) {
  return `${format.format(reach)} × ${impact} × ${confidence / 100} ÷ ${effort}`;
}

export function riceComparison(features) {
  const scored = features.map((feature) => ({ ...feature, score: riceScore(feature) }));
  return {
    rows: scored.map(({ name, reach, impact, confidence, effort, score }) => [
      name, format.format(reach), String(impact), `${confidence}%`, String(effort), format.format(score),
    ]),
    ranked: scored.sort((a, b) => b.score - a.score).map(({ name, score }, _, ranking) => ({
      name,
      score: format.format(score),
      width: ranking[0].score > 0 ? score / ranking[0].score * 100 : 0,
    })),
  };
}

export function riceCalculator(defaults) {
  return `<section class="rice-calculator" aria-labelledby="rice-calculator-title">
    <h2 id="rice-calculator-title" tabindex="-1">RICE score calculator</h2>
    <p>Start with AI recommendations. Change effort from 4 to 2 and see how the score moves.</p>
    <form id="rice-form">
      <div class="rice-fields">
        <label>Reach <small>Users per month</small><input name="reach" type="number" min="0" step="1" required value="${defaults.reach}"></label>
        <label>Impact <small>Effect on the chosen outcome</small><select name="impact">${impactOptions.map(([value, label]) => `<option value="${value}"${value === defaults.impact ? ' selected' : ''}>${label} (${value})</option>`).join('')}</select></label>
        <label>Confidence <small>Strength of the evidence</small><select name="confidence">${confidenceOptions.map((value) => `<option value="${value}"${value === defaults.confidence ? ' selected' : ''}>${value}%</option>`).join('')}</select></label>
        <label>Effort <small>Person-months</small><input name="effort" type="number" min="0" step="any" required value="${defaults.effort}"></label>
      </div>
      <div class="rice-result"><span class="eyebrow" id="rice-score-label">CALCULATED RICE SCORE</span><output aria-labelledby="rice-score-label">${format.format(riceScore(defaults))}</output><p data-rice-expression>${expression(defaults)}</p></div>
      <button type="button" class="btn secondary" data-rice-reset>Reset calculator</button>
    </form>
  </section>`;
}

export function updateRiceCalculator(form) {
  const fields = form.elements;
  const values = {
    reach: fields.namedItem('reach').valueAsNumber,
    impact: Number(fields.namedItem('impact').value),
    confidence: Number(fields.namedItem('confidence').value),
    effort: fields.namedItem('effort').valueAsNumber,
  };
  const score = Number.isInteger(values.reach) ? riceScore(values) : null;
  form.querySelector('output').value = score === null ? '—' : format.format(score);
  form.querySelector('[data-rice-expression]').textContent = score === null
    ? 'Enter a whole number for reach and an effort greater than zero.'
    : expression(values);
}
