import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { onRequestGet, onRequestPost } from '../edge-functions/api/course-members.js';

const API = 'https://dm.pioneer-x.cn/api/course-members';
const org = 'PioneerX-DataMining';
const env = {
  COURSE_SESSION_SECRET: 'test-secret-this-is-not-a-production-secret',
  COURSE_MEMBERS_GITHUB_TOKEN: 'test-token',
  COURSE_GITHUB_CLIENT_ID: 'test-client',
  COURSE_GITHUB_CLIENT_SECRET: 'test-client-secret'
};
async function session(login = 'student') {
  const body = Buffer.from(JSON.stringify({ id: 42, login, exp: Date.now() + 3600000 })).toString('base64url');
  const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(env.COURSE_SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = Buffer.from(await webcrypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))).toString('base64url');
  return '__Host-dm-course-session=' + body + '.' + signature;
}
function req(action, id = 'DM012', headers = {}) {
  return new Request(API + '?action=' + action + '&id=' + id, { headers });
}
async function call(action, id, headers, usingEnv = env) {
  return onRequestGet({ request: req(action, id, headers), env: usingEnv });
}
const unauth = await call('project');
assert.equal(unauth.status, 401, 'No cookie must not return identities');
assert.equal((await unauth.json()).error, 'login_required');
const badId = await call('login', 'DM005');
assert.equal(badId.status, 400, 'Infra repo must not be queryable as a student project');
const unconfigured = await call('login', 'DM012', {}, {});
assert.equal(unconfigured.status, 503, 'OAuth must fail closed when secrets are absent');
const forged = await call('project', 'DM012', { cookie: '__Host-dm-course-session=forged.value' });
assert.equal(forged.status, 401, 'Cookie signature must be validated');

const loggedIn = await session();
const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (input) => {
  const u = new URL(input);
  calls.push(u.pathname);
  if (u.pathname === '/__infra/apps.json') return Response.json({ apps: [{ id: 'DM012', repo: org + '/DM012-Calorie-Calculator' }] });
  if (u.pathname === '/orgs/' + org + '/members/student') return new Response(null, { status: 204 });
  if (u.pathname === '/orgs/' + org + '/members/outsider') return new Response(null, { status: 404 });
  if (u.pathname === '/orgs/' + org + '/members') return Response.json([
    { login: 'student' }, { login: 'teammate' }, { login: 'teacher' }
  ]);
  if (u.pathname === '/repos/' + org + '/DM012-Calorie-Calculator/teams') return Response.json([{ slug: 'dm012', name: 'DM012' }]);
  if (u.pathname === '/repos/' + org + '/DM012-Calorie-Calculator/collaborators') {
    assert.equal(u.searchParams.get('affiliation'), 'direct');
    return Response.json([
      { login: 'student', type: 'User', role_name: 'write', avatar_url: '' },
      { login: 'teacher', type: 'User', role_name: 'admin', avatar_url: '' },
      { login: 'outside', type: 'User', role_name: 'write', avatar_url: '' }
    ]);
  }
  if (u.pathname === '/orgs/' + org + '/teams/dm012/members') return Response.json([
    { login: 'teammate', type: 'User', avatar_url: '' },
    { login: 'student', type: 'User', avatar_url: '' }
  ]);
  throw new Error('Unexpected URL: ' + u);
};
try {
  const ok = await call('project', 'DM012', { cookie: loggedIn });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).members.map(m => m.login), ['student', 'teammate']);
  assert.ok(!calls.some(p => /private|secret/i.test(p)), 'No arbitrary repository lookups');
  const other = await call('project', 'DM013', { cookie: loggedIn });
  assert.equal(other.status, 404, 'Only published registered projects may be queried');
  const denied = await call('project', 'DM012', { cookie: await session('outsider') });
  assert.equal(denied.status, 403, 'Revoked or outside org account must be denied');
  const notMember = await call('session', 'DM012', { cookie: await session('outsider') });
  assert.equal(notMember.status, 403, 'Session endpoint must re-check organization membership');
} finally { globalThis.fetch = originalFetch; }

const logout = await onRequestPost({
  request: new Request(API + '?action=logout', { method: 'POST', headers: { origin: 'https://dm.pioneer-x.cn' } }),
  env
});
assert.equal(logout.status, 200);
assert.ok(logout.headers.get('set-cookie').includes('Max-Age=0'));
const wrongOrigin = await onRequestPost({
  request: new Request(API + '?action=logout', { method: 'POST', headers: { origin: 'https://evil.example' } }),
  env
});
assert.equal(wrongOrigin.status, 403);
console.log('Course membership auth and GitHub directory checks passed.');
