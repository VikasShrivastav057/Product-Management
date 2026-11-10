import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createCourseAccess } from '../lib/course-access.mjs';

const origin = 'https://course.example';
const fixtureCode = Buffer.alloc(32, 7).toString('base64url');
const anotherFixture = Buffer.alloc(32, 8).toString('base64url');
const fixtureHash = (value) => createHash('sha256').update(value, 'ascii').digest('hex');
const gate = createCourseAccess({ accessHash: fixtureHash(fixtureCode) });
const fixtureCookie = `__Host-pm_learning_access=${fixtureCode}`;

function request(path, init) {
  return new Request(`${origin}${path}`, init);
}

function login(body, source = origin) {
  return request('/access', { method: 'POST', headers: { Origin: source }, body });
}

test('access configuration fails closed for both pages and APIs', async () => {
  for (const accessHash of [undefined, '', 'not-a-hash']) {
    const disabled = createCourseAccess({ accessHash });
    const api = request('/api/learning', { headers: { Cookie: fixtureCookie } });
    assert.equal(disabled.authorize(api), false);
    assert.equal((await disabled.handle(api)).status, 503);
    const page = await disabled.handle(request('/access'));
    assert.equal(page.status, 503);
    assert.doesNotMatch(await page.text(), /<form/);
  }
});

test('course, assets, and APIs require the cookie and ignore claimed identity', async () => {
  const headers = { 'oai-authenticated-user-id': 'spoofed-user', Authorization: `Bearer ${fixtureCode}` };
  const start = await gate.handle(request('/', { headers }));
  assert.equal(start.status, 303);
  assert.equal(start.headers.get('location'), '/access');
  assert.equal((await gate.handle(request('/course-content.json', { headers }))).status, 401);
  const api = await gate.handle(request('/api/portfolio', { headers }));
  assert.equal(api.status, 401);
  assert.match(api.headers.get('content-type'), /^application\/json/);
  const form = await gate.handle(request('/access'));
  assert.equal(form.status, 200);
  assert.match(form.headers.get('cache-control'), /no-store/);
  assert.doesNotMatch(await form.text(), new RegExp(fixtureCode));
  assert.equal(await (await gate.handle(request('/access', { method: 'HEAD' }))).text(), '');
});

test('only a valid same-origin form creates a protected cookie', async () => {
  const body = () => new URLSearchParams({ code: fixtureCode });
  for (const [submission, status] of [
    [login(body(), 'https://other.example'), 403],
    [request('/access', { method: 'POST', body: body() }), 403],
    [login(new URLSearchParams({ code: anotherFixture })), 401],
    [login(new URLSearchParams({ code: fixtureCode, extra: 'field' })), 401],
    [login(new URLSearchParams({ code: 'a'.repeat(1024) })), 401],
    [login(`code=${fixtureCode}`), 401],
  ]) {
    const reply = await gate.handle(submission);
    assert.equal(reply.status, status);
    assert.equal(reply.headers.get('set-cookie'), null);
  }
  const success = await gate.handle(login(body()));
  assert.equal(success.status, 303);
  assert.equal(success.headers.get('location'), '/#modules');
  const cookie = success.headers.get('set-cookie');
  assert.ok(cookie.startsWith(`${fixtureCookie};`));
  for (const value of ['Max-Age=43200', 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Secure']) assert.ok(cookie.includes(value));
  assert.equal(await success.text(), '');
  assert.equal(await gate.handle(request('/course-content.json', { headers: { Cookie: fixtureCookie } })), null);
  assert.equal(await gate.handle(request('/api/learning', { headers: { Cookie: fixtureCookie } })), null);
});

test('rotation revokes prior cookies and duplicates are refused', () => {
  const before = request('/', { headers: { Cookie: `theme=green; ${fixtureCookie}` } });
  assert.equal(gate.authorize(before), true);
  assert.equal(createCourseAccess({ accessHash: fixtureHash(anotherFixture) }).authorize(before), false);
  assert.equal(gate.authorize(request('/', { headers: { Cookie: `${fixtureCookie}; ${fixtureCookie}` } })), false);
});

test('sign-out is same-origin POST and removes the access cookie', async () => {
  const noPost = await gate.handle(request('/signout'));
  assert.equal(noPost.status, 405);
  const blocked = await gate.handle(request('/signout', { method: 'POST', headers: { Origin: 'https://other.example' } }));
  assert.equal(blocked.status, 403);
  assert.equal(blocked.headers.get('set-cookie'), null);
  const logout = await gate.handle(request('/signout', { method: 'POST', headers: { Origin: origin, Cookie: fixtureCookie } }));
  assert.equal(logout.status, 303);
  assert.equal(logout.headers.get('location'), '/access');
  assert.match(logout.headers.get('set-cookie'), /^__Host-pm_learning_access=; Max-Age=0;/);
});

test('local mode uses a host-only cookie suitable for HTTP', async () => {
  const local = createCourseAccess({ accessHash: fixtureHash(fixtureCode), secure: false });
  const success = await local.handle(login(new URLSearchParams({ code: fixtureCode })));
  const cookie = success.headers.get('set-cookie');
  assert.match(cookie, /^pm_learning_access=/);
  assert.doesNotMatch(cookie, /; Secure/);
  assert.equal(local.authorize(request('/', { headers: { Cookie: cookie.split(';')[0] } })), true);
});
