const PAGE_WIDTH = 792;
const PAGE_HEIGHT = 612;
const RENDER_SCALE = 3;
const SERIF = 'Georgia, "Noto Serif", serif';
const SANS = 'system-ui, sans-serif';
const PINE = '#173d36';
const TEAL = '#28675f';
const INK = '#394f48';
const RULE = '#bdc7b5';

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});

function drawText(ctx, text, y, { x = PAGE_WIDTH / 2, size = 12, font = SANS, color = INK, weight = 400 } = {}) {
  ctx.fillStyle = color;
  ctx.font = `${weight} ${size}px ${font}`;
  ctx.fillText(text, x, y);
}

function drawLine(ctx, x1, y1, x2, y2, color, width = 1) {
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function splitName(ctx, name, maxWidth) {
  const words = name.split(/\s+/u);
  const parts = (segments, separator) => segments.slice(1).map((_, index) => [
    segments.slice(0, index + 1).join(separator),
    segments.slice(index + 1).join(separator),
  ]);
  const narrowest = (choices) => choices.reduce((best, lines) => {
    const width = Math.max(...lines.map((line) => ctx.measureText(line).width));
    return width < best.width ? { lines, width } : best;
  }, { lines: [name], width: Infinity });

  const byWord = narrowest(parts(words, ' '));
  if (byWord.width <= maxWidth) return byWord;

  const characters = typeof Intl.Segmenter === 'function'
    ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(name), ({ segment }) => segment)
    : Array.from(name);
  return narrowest(parts(characters, ''));
}

function drawName(ctx, name) {
  const maxWidth = 626;
  const widthAt = (size) => {
    ctx.font = `400 ${size}px ${SERIF}`;
    return ctx.measureText(name).width;
  };
  const naturalWidth = widthAt(53);
  if (widthAt(32) <= maxWidth) {
    const size = Math.min(53, 53 * maxWidth / naturalWidth);
    drawText(ctx, name, 296, { size, font: SERIF, color: PINE });
    return;
  }

  const { lines, width } = splitName(ctx, name, maxWidth);
  const size = Math.min(32, 32 * maxWidth / width);
  const gap = size + 5;
  lines.forEach((line, index) => drawText(ctx, line.trim(), 296 + (index - 0.5) * gap, { size, font: SERIF, color: PINE }));
}

function drawCertificate({ id, name, score, awardedAt }) {
  const canvas = document.createElement('canvas');
  canvas.width = PAGE_WIDTH * RENDER_SCALE;
  canvas.height = PAGE_HEIGHT * RENDER_SCALE;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('This browser could not draw the certificate.');
  ctx.scale(RENDER_SCALE, RENDER_SCALE);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = '#fcf9f0';
  ctx.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);
  ctx.strokeStyle = PINE;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(27, 27, PAGE_WIDTH - 54, PAGE_HEIGHT - 54);
  ctx.strokeStyle = RULE;
  ctx.lineWidth = 0.75;
  ctx.strokeRect(35, 35, PAGE_WIDTH - 70, PAGE_HEIGHT - 70);

  for (const [x, y, dx, dy] of [[35, 35, 1, 1], [757, 35, -1, 1], [35, 577, 1, -1], [757, 577, -1, -1]]) {
    drawLine(ctx, x, y, x + 25 * dx, y, TEAL, 2.5);
    drawLine(ctx, x, y, x, y + 25 * dy, TEAL, 2.5);
  }

  const center = PAGE_WIDTH / 2;
  ctx.fillStyle = PINE;
  ctx.beginPath();
  ctx.arc(center, 75, 19, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineCap = 'round';
  drawLine(ctx, center - 7, 75, center - 2, 80, '#f7f3e6', 1.9);
  drawLine(ctx, center - 2, 80, center + 8, 70, '#f7f3e6', 1.9);
  ctx.lineCap = 'butt';

  drawText(ctx, 'CERTIFICATE OF COMPLETION', 113, { size: 12, color: TEAL, weight: 700 });
  drawText(ctx, 'Project Management', 158, { size: 48, font: SERIF, color: PINE });
  drawText(ctx, 'Product Management and Project Delivery', 199, { size: 16 });
  drawText(ctx, 'Presented to', 241, { size: 13 });
  drawName(ctx, name);
  drawText(ctx, 'For completing the course and passing the final assessment.', 355, { size: 15 });

  drawLine(ctx, 95, 396, 697, 396, RULE);
  const fields = [
    [181, 'ASSESSMENT SCORE', `${score * 10}%`],
    [396, 'DATE ISSUED', dateFormatter.format(awardedAt)],
    [611, 'CERTIFICATE ID', id],
  ];
  for (const [x, label, value] of fields) {
    drawText(ctx, label, 429, { x, size: 10, weight: 700, color: TEAL });
    drawText(ctx, value, 452, { x, size: 14, weight: 600, color: PINE });
  }

  drawText(ctx, 'PM Learning Lab', 515, { font: SERIF, size: 22, color: PINE });
  drawText(ctx, 'Course completion certificate', 542, { size: 11 });
  return canvas;
}

function makePdf(jpeg, width, height) {
  const encoder = new TextEncoder();
  const parts = [];
  const offsets = [0];
  let length = 0;

  function append(value) {
    const part = typeof value === 'string' ? encoder.encode(value) : value;
    parts.push(part);
    length += part.byteLength;
  }

  function addObject(...contents) {
    const number = offsets.length;
    offsets.push(length);
    append(`${number} 0 obj\n`);
    contents.forEach(append);
    append('\nendobj\n');
  }

  append('%PDF-1.4\n');
  append(Uint8Array.of(37, 226, 227, 207, 211, 10));
  addObject('<< /Type /Catalog /Pages 2 0 R >>');
  addObject('<< /Type /Pages /Count 1 /Kids [3 0 R] >>');
  addObject(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /XObject << /Certificate 4 0 R >> >> /Contents 5 0 R >>`);
  addObject(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.byteLength} >>\nstream\n`, jpeg, '\nendstream');

  const drawImage = encoder.encode(`q\n${PAGE_WIDTH} 0 0 ${PAGE_HEIGHT} 0 0 cm\n/Certificate Do\nQ\n`);
  addObject(`<< /Length ${drawImage.byteLength} >>\nstream\n`, drawImage, 'endstream');
  addObject('<< /Title (Project Management - Certificate of Completion) /Author (PM Learning Lab) >>');

  const xrefStart = length;
  append(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
  for (const offset of offsets.slice(1)) append(`${String(offset).padStart(10, '0')} 00000 n \n`);
  append(`trailer\n<< /Size ${offsets.length} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

export async function downloadCertificate({ id, name, score, awarded_at }) {
  if (typeof id !== 'string' || !id || typeof name !== 'string' || !name.trim() ||
      !Number.isInteger(score) || score < 0 || score > 10 || !Number.isFinite(awarded_at) ||
      Number.isNaN(new Date(awarded_at).getTime())) {
    throw new Error('The certificate is missing required information.');
  }

  const canvas = drawCertificate({ id, name: name.trim(), score, awardedAt: awarded_at });
  const jpeg = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.97));
  if (!jpeg) throw new Error('The certificate could not be saved as a PDF.');

  const pdf = makePdf(new Uint8Array(await jpeg.arrayBuffer()), canvas.width, canvas.height);
  const url = URL.createObjectURL(pdf);
  const link = document.createElement('a');
  link.href = url;
  link.download = `PM-Learning-Lab-${id.replace(/[^a-z\d-]/gi, '')}.pdf`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
