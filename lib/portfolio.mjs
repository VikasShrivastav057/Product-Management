const portfolioMaxFileBytes = 4 * 1024 * 1024;
const portfolioMaxRequestBytes = portfolioMaxFileBytes + 64 * 1024;
const portfolioMaxEntries = 20;
const portfolioFields = new Set(['caseId', 'title', 'demoUrl', 'file']);
const portfolioEntryColumns = 'id, case_id, title, demo_url, filename, size, created_at';
const portfolioPrivateHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

function portfolioJson(value, status = 200, headers = {}) {
  return Response.json(value, { status, headers: { ...portfolioPrivateHeaders, ...headers } });
}

function portfolioError(error, status) {
  return portfolioJson({ error }, status);
}

function portfolioPublicEntry({ id, case_id, title, demo_url, filename, size, created_at }) {
  return { id, case_id, title, demo_url, filename, size, created_at };
}

function portfolioSizeError() {
  return portfolioError('Choose one file up to 4 MiB.', 413);
}

async function portfolioReadForm(request) {
  const type = request.headers.get('Content-Type');
  if (!request.body || !/^multipart\/form-data\s*;/i.test(type ?? '')) {
    return portfolioError('Send the entry as multipart form data.', 415);
  }
  if (Number(request.headers.get('Content-Length')) > portfolioMaxRequestBytes) return portfolioSizeError();

  const reader = request.body.getReader();
  let bytes = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes <= portfolioMaxRequestBytes) chunks.push(value);
    }
    if (bytes > portfolioMaxRequestBytes) return portfolioSizeError();
    return await new Response(new Blob(chunks), { headers: { 'Content-Type': type } }).formData();
  } catch {
    return bytes > portfolioMaxRequestBytes ? portfolioSizeError() : portfolioError('The upload could not be read.', 400);
  } finally {
    reader.releaseLock();
  }
}

function portfolioValidateForm(form, caseIds) {
  const fields = new Map();
  for (const [field, value] of form) {
    if (!portfolioFields.has(field) || fields.has(field)) return portfolioError('Send each portfolio field once.', 400);
    fields.set(field, value);
  }

  const caseId = fields.get('caseId');
  const rawTitle = fields.get('title');
  const rawDemo = fields.get('demoUrl') ?? '';
  const file = fields.get('file') ?? null;
  const title = typeof rawTitle === 'string' ? rawTitle.normalize('NFC').trim() : '';
  if (typeof caseId !== 'string' || !/^[a-z\d][a-z\d_-]{0,79}$/i.test(caseId) || (caseIds && !caseIds.has(caseId))) {
    return portfolioError('Choose a valid case.', 400);
  }
  if (!title || [...title].length > 120 || /[\p{Cc}\p{Cf}]/u.test(title)) {
    return portfolioError('Enter a title up to 120 characters.', 400);
  }
  if (typeof rawDemo !== 'string' || rawDemo.length > 2048 || /[\p{Cc}\p{Cf}]/u.test(rawDemo)) {
    return portfolioError('Enter a valid HTTPS demo link.', 400);
  }
  let demoUrl = null;
  if (rawDemo.trim()) {
    try {
      const url = new URL(rawDemo.trim());
      if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 2048) throw new TypeError();
      demoUrl = url.href;
    } catch {
      return portfolioError('Enter a valid HTTPS demo link.', 400);
    }
  }

  if (file !== null && !(file instanceof File)) return portfolioError('Choose a valid file.', 400);
  if (file?.size > portfolioMaxFileBytes) return portfolioSizeError();
  if (file?.size === 0 && file.name) return portfolioError('Choose a file that contains data.', 400);
  if (!file?.size && !demoUrl) return portfolioError('Add a file or an HTTPS demo link.', 400);

  const filename = file?.size ? file.name.split(/[\\/]/u).at(-1).normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, '').trim() : null;
  if (file?.size && (!filename || filename === '.' || filename === '..' || [...filename].length > 180)) {
    return portfolioError('Choose a file with a name up to 180 characters.', 400);
  }
  return { caseId, title, demoUrl, file: file?.size ? file : null, filename };
}

async function portfolioFinishDelete(db, bucket, user, row) {
  if (row.object_key) {
    if (!bucket) throw new Error('Portfolio file storage is unavailable.');
    await bucket.delete(row.object_key);
  }
  await db.prepare('DELETE FROM portfolio_entries WHERE user_id = ? AND id = ? AND deleting = 1').bind(user, row.id).run();
}

async function portfolioDiscardBlob(bucket, key) {
  if (!key) return;
  try { await bucket.delete(key); }
  catch { console.error('Could not remove an uncommitted portfolio object.'); }
}

async function portfolioCreate(request, db, bucket, user, caseIds) {
  const requestKey = request.headers.get('Idempotency-Key');
  if (requestKey !== null && !/^[a-z\d][a-z\d_.:-]{0,127}$/i.test(requestKey)) {
    return portfolioError('Invalid upload retry key.', 400);
  }
  const getRetry = () => requestKey === null ? null : db.prepare(`SELECT ${portfolioEntryColumns}, deleting
    FROM portfolio_entries WHERE user_id = ? AND idempotency_key = ?`).bind(user, requestKey).first();
  const retryResult = (row) => row.deleting
    ? portfolioError('This entry is being deleted. Start a new upload.', 409)
    : portfolioJson(portfolioPublicEntry(row));

  const prior = await getRetry();
  if (prior) return retryResult(prior);

  const form = await portfolioReadForm(request);
  if (form instanceof Response) return form;
  const parsed = portfolioValidateForm(form, caseIds);
  if (parsed instanceof Response) return parsed;
  const { caseId, title, demoUrl, file, filename } = parsed;
  if (file && !bucket) return portfolioError('File storage is temporarily unavailable. Please try again.', 503);

  const { results: pending } = await db.prepare('SELECT id, object_key FROM portfolio_entries WHERE user_id = ? AND deleting = 1').bind(user).all();
  await Promise.allSettled(pending.map((row) => portfolioFinishDelete(db, bucket, user, row)));
  const atCapacity = () => portfolioError(`You can save up to ${portfolioMaxEntries} entries. Delete an entry before adding another.`, 409);
  const { total } = await db.prepare('SELECT COUNT(*) AS total FROM portfolio_entries WHERE user_id = ?').bind(user).first();
  if (total >= portfolioMaxEntries) {
    const retry = await getRetry();
    return retry ? retryResult(retry) : atCapacity();
  }

  const id = crypto.randomUUID();
  const key = file ? `portfolio/${id}` : null;
  const size = file?.size ?? 0;
  const createdAt = Date.now();
  if (file) {
    try {
      await bucket.put(key, file, { httpMetadata: { contentType: 'application/octet-stream' } });
    } catch (error) {
      await portfolioDiscardBlob(bucket, key);
      throw error;
    }
  }

  let inserted;
  try {
    // One SQLite statement enforces the cap even if several creates race.
    inserted = await db.prepare(`INSERT INTO portfolio_entries
      (id, user_id, case_id, title, demo_url, filename, size, object_key, idempotency_key, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE (SELECT COUNT(*) FROM portfolio_entries WHERE user_id = ?) < ?
      ON CONFLICT (user_id, idempotency_key) DO NOTHING`).bind(
      id, user, caseId, title, demoUrl, filename, size, key, requestKey, createdAt, user, portfolioMaxEntries,
    ).run();
  } catch (error) {
    // If the database response failed after commit, preserve the referenced file.
    const saved = await db.prepare(`SELECT ${portfolioEntryColumns}, deleting FROM portfolio_entries WHERE user_id = ? AND id = ?`).bind(user, id).first();
    if (saved) return retryResult(saved);
    await portfolioDiscardBlob(bucket, key);
    throw error;
  }

  if ((inserted.meta?.changes ?? inserted.changes) === 1) {
    return portfolioJson({ id, case_id: caseId, title, demo_url: demoUrl, filename, size, created_at: createdAt }, 201);
  }
  await portfolioDiscardBlob(bucket, key);
  const retry = await getRetry();
  return retry ? retryResult(retry) : atCapacity();
}

function portfolioAttachment(filename) {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/gu, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function portfolioItem(db, bucket, user, id, method) {
  const row = await db.prepare('SELECT id, filename, size, object_key, deleting FROM portfolio_entries WHERE user_id = ? AND id = ?').bind(user, id).first();
  if (method === 'DELETE') {
    if (row) {
      if (row.object_key && !bucket) return portfolioError('File storage is temporarily unavailable. Please try again.', 503);
      await db.prepare('UPDATE portfolio_entries SET deleting = 1 WHERE user_id = ? AND id = ?').bind(user, id).run();
      await portfolioFinishDelete(db, bucket, user, row);
    }
    return portfolioJson({ deleted: true });
  }

  if (!row?.object_key || row.deleting) return portfolioError('Portfolio file not found.', 404);
  if (!bucket) return portfolioError('File storage is temporarily unavailable. Please try again.', 503);
  const object = await bucket.get(row.object_key);
  if (!object?.body) return portfolioError('Portfolio file not found.', 404);
  return new Response(object.body, { headers: {
    ...portfolioPrivateHeaders,
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(row.size),
    'Content-Disposition': portfolioAttachment(row.filename),
    'Content-Security-Policy': "sandbox; default-src 'none'; frame-ancestors 'none'",
    'Cross-Origin-Resource-Policy': 'same-origin',
  } });
}

export async function handlePortfolio(request, db, bucket, caseIds) {
  const user = request.headers.get('oai-authenticated-user-id');
  if (!user) return portfolioError('Sign in to save and access your portfolio.', 401);
  const url = new URL(request.url);
  const route = /^\/api\/portfolio(?:\/([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}))?\/?$/i.exec(url.pathname);
  if (!route) return portfolioError('Portfolio entry not found.', 404);

  const id = route[1];
  const method = request.method;
  const writeMethod = id ? 'DELETE' : 'POST';
  if (method !== 'GET' && method !== writeMethod) {
    return portfolioJson({ error: 'This portfolio action is unavailable.' }, 405, { Allow: `GET, ${writeMethod}` });
  }
  if (method === writeMethod && request.headers.get('Origin') !== url.origin) {
    return portfolioError('This action must come from the course website.', 403);
  }
  if (!db) return portfolioError('Portfolio storage is temporarily unavailable. Please try again.', 503);

  try {
    if (id) return await portfolioItem(db, bucket, user, id, method);
    if (method === 'POST') return await portfolioCreate(request, db, bucket, user, caseIds);
    const { results } = await db.prepare(`SELECT ${portfolioEntryColumns} FROM portfolio_entries
      WHERE user_id = ? AND deleting = 0 ORDER BY created_at DESC, id DESC`).bind(user).all();
    return portfolioJson({ entries: results });
  } catch (error) {
    console.error('Portfolio storage operation failed.', error?.name);
    return portfolioError('Portfolio storage is temporarily unavailable. Please try again.', 503);
  }
}
