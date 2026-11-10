import { createHash, timingSafeEqual } from 'node:crypto';

const codePattern = /^[A-Za-z0-9_-]{43}$/;
const hashPattern = /^[a-f0-9]{64}$/i;
const maxFormBytes = 128;
const cookieLifetime = 12 * 60 * 60;

const pageHeaders = {
  'Cache-Control': 'private, no-store',
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

function accessPage(request, status, message = '', configured = true) {
  const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>PM Learning Lab · Course access</title>
  <style>
    * { box-sizing: border-box }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; color: #18382e; background: #f2f4ec; font: 16px/1.5 system-ui, sans-serif }
    main { width: min(100%, 490px); padding: clamp(24px, 6vw, 46px); border: 1px solid #cbd5c7; border-radius: 20px; background: #fff; box-shadow: 0 18px 50px #18382e15 }
    .brand { margin: 0 0 8px; color: #39604f; font-size: .79rem; font-weight: 750; letter-spacing: .14em; text-transform: uppercase }
    h1 { margin: 0; line-height: 1.14; font-size: clamp(1.85rem, 5vw, 2.55rem); letter-spacing: -.03em }
    p { margin: 14px 0 0 }
    form { margin-top: 25px; display: grid; gap: 10px }
    label { font-weight: 650 }
    input, button { width: 100%; min-height: 48px; padding: 10px 14px; border-radius: 9px; font: inherit }
    input { border: 1px solid #789286; color: #18382e; background: #fff }
    button { margin-top: 6px; border: 1px solid #18382e; color: #fff; background: #18382e; font-weight: 650; cursor: pointer }
    button:hover { background: #285341 }
    :focus-visible { outline: 3px solid #396f58; outline-offset: 3px }
    .message { padding: 10px 13px; border: 1px solid #b97558; border-radius: 8px; color: #752f1d; background: #fff3eb }
  </style>
</head>
<body>
  <main>
    <p class="brand">PM Learning Lab</p>
    <h1>${configured ? 'Open the course' : 'Course access is being set up'}</h1>
    ${configured ? '<p>Enter the course access code to continue.</p>' : '<p>Try again after the course owner finishes setting up access.</p>'}
    ${message ? `<p class="message" role="alert">${message}</p>` : ''}
    ${configured ? `<form action="/access" method="post">
      <label for="course-code">Access code</label>
      <input id="course-code" name="code" type="password" autocomplete="current-password" autocapitalize="none" spellcheck="false" maxlength="64" required>
      <button type="submit">Continue to the course</button>
    </form>` : ''}
  </main>
</body>
</html>`;
  return new Response(request.method === 'HEAD' ? null : body, { status, headers: pageHeaders });
}

function accessJson(request, status, error) {
  return new Response(request.method === 'HEAD' ? null : JSON.stringify({ error }), {
    status,
    headers: { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
  });
}

function redirectTo(location, cookie) {
  const headers = { 'Cache-Control': 'private, no-store', Location: location, 'Referrer-Policy': 'no-referrer' };
  if (cookie) headers['Set-Cookie'] = cookie;
  return new Response(null, { status: 303, headers });
}

async function readAccessCode(request) {
  const contentType = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/x-www-form-urlencoded' || !request.body) return null;
  if (Number(request.headers.get('content-length')) > maxFormBytes) return null;

  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxFormBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const fields = [...new URLSearchParams(Buffer.concat(chunks, size).toString('utf8'))];
    return fields.length === 1 && fields[0][0] === 'code' ? fields[0][1].trim() : null;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

/** accessHash is the hex SHA-256 digest of the ASCII base64url access code. */
export function createCourseAccess({ accessHash, secure = true } = {}) {
  const hash = typeof accessHash === 'string' && hashPattern.test(accessHash) ? Buffer.from(accessHash, 'hex') : null;
  const cookieName = secure ? '__Host-pm_learning_access' : 'pm_learning_access';
  const cookieAttributes = `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;

  function matchesCode(code) {
    if (!hash || typeof code !== 'string' || !codePattern.test(code)) return false;
    if (Buffer.from(code, 'base64url').toString('base64url') !== code) return false;
    return timingSafeEqual(createHash('sha256').update(code, 'ascii').digest(), hash);
  }

  function authorize(request) {
    const candidates = (request.headers.get('cookie') || '').split(';')
      .map((field) => field.trim()).filter((field) => field.startsWith(`${cookieName}=`));
    return candidates.length === 1 && matchesCode(candidates[0].slice(cookieName.length + 1));
  }

  async function handle(request) {
    const url = new URL(request.url);
    const { method } = request;
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
    if (!hash) return isApi
      ? accessJson(request, 503, 'Course access is being set up.')
      : accessPage(request, 503, '', false);

    if (url.pathname === '/access') {
      if (method === 'GET' || method === 'HEAD') return authorize(request) ? redirectTo('/#modules') : accessPage(request, 200);
      if (method !== 'POST') return new Response(null, { status: 405, headers: { ...pageHeaders, Allow: 'GET, HEAD, POST' } });
      if (request.headers.get('origin') !== url.origin) return accessPage(request, 403, 'Open this page directly to enter the access code.');
      const code = await readAccessCode(request);
      if (!matchesCode(code)) return accessPage(request, 401, 'The access code did not match. Check the code and try again.');
      return redirectTo('/#modules', `${cookieName}=${code}; Max-Age=${cookieLifetime}; ${cookieAttributes}`);
    }

    if (url.pathname === '/signout') {
      if (method !== 'POST') return new Response(null, { status: 405, headers: { ...pageHeaders, Allow: 'POST' } });
      if (request.headers.get('origin') !== url.origin) return accessPage(request, 403, 'Open the course directly to sign out.');
      return redirectTo('/access', `${cookieName}=; Max-Age=0; ${cookieAttributes}`);
    }

    if (authorize(request)) return null;
    if (!isApi && (method === 'GET' || method === 'HEAD') && (url.pathname === '/' || request.headers.get('sec-fetch-mode') === 'navigate')) {
      return redirectTo('/access');
    }
    return accessJson(request, 401, 'Enter the course access code to continue.');
  }

  return { authorize, handle };
}
