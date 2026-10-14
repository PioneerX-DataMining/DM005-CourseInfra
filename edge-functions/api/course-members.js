// GitHub OAuth + course-only project collaborator directory.
// Hosted by EdgeOne Functions; tokens and signing key must ONLY exist in EdgeOne Production env.
const ORG = 'PioneerX-DataMining';
const API_PATH = '/api/course-members';
const SESSION_COOKIE = '__Host-dm-course-session';
const STATE_COOKIE = '__Host-dm-course-oauth';
const CALLBACK = 'https://dm.pioneer-x.cn/api/course-members?action=callback';
const API = 'https://api.github.com';
const enc = new TextEncoder();

const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', ...headers }
});
const redirect = (location, headers = {}) => new Response(null, {
  status: 302, headers: { location, 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer', ...headers }
});
const cookie = (name, value, age) =>
  name + '=' + value + '; Path=/; Max-Age=' + age + '; HttpOnly; Secure; SameSite=Lax';
const cookies = req => Object.fromEntries((req.headers.get('cookie') || '').split(';')
  .map(s => s.trim()).filter(Boolean).map(s => {
    const i = s.indexOf('=');
    return [s.slice(0, i), s.slice(i + 1)];
  }));
const base64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
const unbase64 = str => {
  if (!/^[A-Za-z0-9_-]+$/.test(str)) return null;
  try { return Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - str.length % 4) % 4)), c => c.charCodeAt(0)); }
  catch { return null; }
};
const random = () => base64(crypto.getRandomValues(new Uint8Array(24)));
const safeEqual = (a, b) => {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};
async function hmac(data, secret) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
async function signSession(user, secret) {
  const payload = base64(enc.encode(JSON.stringify({ id: user.id, login: user.login, exp: Date.now() + 8 * 3600000 })));
  return payload + '.' + await hmac(payload, secret);
}
async function parseSession(req, secret) {
  const [payload, sig, ...rest] = (cookies(req)[SESSION_COOKIE] || '').split('.');
  if (!secret || !payload || !sig || rest.length || !(await safeSignature(payload, sig, secret))) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(unbase64(payload)));
    if (!Number.isSafeInteger(data.id) || data.id <= 0 || !/^[\w-]{1,39}$/.test(data.login) || !Number.isSafeInteger(data.exp) || data.exp < Date.now()) return null;
    return { id: data.id, login: data.login };
  } catch { return null; }
}
async function safeSignature(payload, sig, secret) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(sig)) return false;
  return safeEqual(sig, await hmac(payload, secret));
}
function githubHeaders(token) {
  return { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'DM-Course-MemberDirectory' };
}
async function gh(path, token) {
  const res = await fetch(API + path, { headers: githubHeaders(token), redirect: 'manual' });
  return res;
}
async function activeOrgMember(login, token) {
  if (!token) return false;
  const res = await gh('/orgs/' + ORG + '/members/' + encodeURIComponent(login), token);
  if (res.status === 204) return true;
  if (res.status === 404) return false;
  throw new Error('GitHub 组织身份验证失败（HTTP ' + res.status + '）');
}
async function requireMember(req, env) {
  const user = await parseSession(req, env.COURSE_SESSION_SECRET);
  if (!user) return { error: json({ error: 'login_required' }, 401) };
  if (!env.COURSE_MEMBERS_GITHUB_TOKEN) return { error: json({ error: 'service_not_configured' }, 503) };
  try {
    if (!(await activeOrgMember(user.login, env.COURSE_MEMBERS_GITHUB_TOKEN))) {
      return { error: json({ error: 'not_org_member' }, 403, { 'set-cookie': cookie(SESSION_COOKIE, '', 0) }) };
    }
  } catch { return { error: json({ error: 'membership_check_failed' }, 503) }; }
  return { user };
}
async function listAll(path, token, limit = 5) {
  const out = [];
  for (let p = 1; p <= limit; p++) {
    const join = path.includes('?') ? '&' : '?';
    const r = await gh(path + join + 'per_page=100&page=' + p, token);
    if (!r.ok) throw new Error('GitHub API ' + r.status + ' at ' + path);
    const data = await r.json();
    if (!Array.isArray(data)) throw new Error('Invalid GitHub member list');
    out.push(...data);
    if (data.length < 100) return out;
  }
  throw new Error('Member list exceeds supported pagination limit');
}
function validProjectId(id) { return /^DM0[1-9]\d$/.test(id || ''); }
// Only student-project IDs published by DM005 are allowed, never an arbitrary repo name from the URL.
async function registeredProject(id, request) {
  const u = new URL('/__infra/apps.json', request.url);
  const r = await fetch(u, { cache: 'no-store' });
  if (!r.ok) throw new Error('Course registry unavailable');
  const data = await r.json();
  const item = Array.isArray(data.apps) && data.apps.find(a => a.id === id);
  if (!item || !item.repo || !/^PioneerX-DataMining\/DM0[1-9]\d-[A-Za-z0-9-]+$/.test(item.repo)) return null;
  return item;
}
async function collaborators(item, serviceToken) {
  const repo = item.repo.split('/')[1];
  const root = '/repos/' + ORG + '/' + encodeURIComponent(repo);
  const [teams, direct, orgMembers] = await Promise.all([
    listAll(root + '/teams', serviceToken),
    listAll(root + '/collaborators?affiliation=direct', serviceToken),
    listAll('/orgs/' + ORG + '/members', serviceToken)
  ]);
  const orgSet = new Set(orgMembers.map(m => m.login?.toLowerCase()));
  const people = new Map();
  const add = (u, source) => {
    const key = u.login?.toLowerCase();
    if (!key || !orgSet.has(key) || u.type !== 'User') return;
    const existing = people.get(key) || {
      login: u.login,
      avatar: u.avatar_url || '',
      url: 'https://github.com/' + encodeURIComponent(u.login),
      via: []
    };
    if (!existing.via.includes(source)) existing.via.push(source);
    people.set(key, existing);
  };
  // Team membership and explicit direct grants are different access paths.
  for (const team of teams) {
    if (!team.slug) continue;
    const users = await listAll('/orgs/' + ORG + '/teams/' + encodeURIComponent(team.slug) + '/members', serviceToken);
    for (const user of users) add(user, 'Team · ' + team.name);
  }
  for (const user of direct) {
    // Owners and administrators get automatic/management access; not inferred as project students.
    if ((user.role_name || '').toLowerCase() === 'admin') continue;
    add(user, 'Direct access');
  }
  return {
    id: item.id, repo: item.repo,
    members: [...people.values()].sort((a, b) => a.login.localeCompare(b.login)),
    note: '这里显示 GitHub Team / Direct access 的组织内协作者，不等同于正式教学分组。'
  };
}
function projectUrl(id, denied = false) {
  return '/project-members.html?id=' + encodeURIComponent(id) + (denied ? '&denied=1' : '');
}
export async function onRequestGet(context) {
  const req = context.request, env = context.env;
  const query = new URL(req.url).searchParams;
  const action = query.get('action') || 'session';
  const id = query.get('id') || '';
  if (action === 'login') {
    if (!validProjectId(id)) return json({ error: 'invalid_project' }, 400);
    if (!env.COURSE_GITHUB_CLIENT_ID || !env.COURSE_GITHUB_CLIENT_SECRET || !env.COURSE_SESSION_SECRET || !env.COURSE_MEMBERS_GITHUB_TOKEN) {
      return json({ error: 'oauth_not_configured' }, 503);
    }
    const state = random();
    const authorize = new URL('https://github.com/login/oauth/authorize');
    authorize.searchParams.set('client_id', env.COURSE_GITHUB_CLIENT_ID);
    authorize.searchParams.set('redirect_uri', CALLBACK);
    authorize.searchParams.set('scope', 'read:org');
    authorize.searchParams.set('state', state);
    return redirect(authorize.toString(), { 'set-cookie': cookie(STATE_COOKIE, state + '.' + id, 600) });
  }
  if (action === 'callback') {
    const raw = cookies(req)[STATE_COOKIE] || '';
    const [expected, savedId] = raw.split('.');
    const state = query.get('state');
    const headers = { 'set-cookie': cookie(STATE_COOKIE, '', 0) };
    if (!state || !safeEqual(state, expected) || !validProjectId(savedId) || !query.get('code')) {
      return redirect('/projects.html?auth=failed', headers);
    }
    try {
      if (!env.COURSE_GITHUB_CLIENT_ID || !env.COURSE_GITHUB_CLIENT_SECRET || !env.COURSE_SESSION_SECRET || !env.COURSE_MEMBERS_GITHUB_TOKEN) {
        return redirect(projectUrl(savedId, true), headers);
      }
      const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env.COURSE_GITHUB_CLIENT_ID,
          client_secret: env.COURSE_GITHUB_CLIENT_SECRET,
          code: query.get('code'),
          redirect_uri: CALLBACK
        })
      });
      if (!tokenResponse.ok) throw new Error('OAuth token exchange failed');
      const tokenData = await tokenResponse.json();
      if (!tokenData.access_token) throw new Error('OAuth token missing');
      const userResponse = await gh('/user', tokenData.access_token);
      if (!userResponse.ok) throw new Error('OAuth user lookup failed');
      const user = await userResponse.json();
      if (!user.id || !/^[\w-]{1,39}$/.test(user.login)) throw new Error('OAuth user invalid');
      // Check as the signed-in user, then independently with our org-scoped service credential.
      const membership = await gh('/user/memberships/orgs/' + ORG, tokenData.access_token);
      if (!membership.ok || (await membership.json()).state !== 'active' ||
          !(await activeOrgMember(user.login, env.COURSE_MEMBERS_GITHUB_TOKEN))) {
        return redirect(projectUrl(savedId, true), headers);
      }
      headers['set-cookie'] = cookie(SESSION_COOKIE, await signSession(user, env.COURSE_SESSION_SECRET), 8 * 3600);
      headers['set-cookie-2'] = cookie(STATE_COOKIE, '', 0);
      // Responses can have only one Set-Cookie value per key; append both separately.
      const response = redirect(projectUrl(savedId));
      response.headers.append('set-cookie', cookie(STATE_COOKIE, '', 0));
      response.headers.append('set-cookie', headers['set-cookie']);
      return response;
    } catch {
      return redirect(projectUrl(savedId, true), headers);
    }
  }
  if (!['session', 'project'].includes(action)) return json({ error: 'unknown_action' }, 404);
  const auth = await requireMember(req, env);
  if (auth.error) return auth.error;
  if (action === 'session') return json({ loggedIn: true, login: auth.user.login });
  if (!validProjectId(id)) return json({ error: 'invalid_project' }, 400);
  try {
    const item = await registeredProject(id, req);
    if (!item) return json({ error: 'project_not_registered' }, 404);
    return json(await collaborators(item, env.COURSE_MEMBERS_GITHUB_TOKEN));
  } catch {
    return json({ error: 'member_lookup_unavailable' }, 503);
  }
}
export async function onRequestPost(context) {
  const action = new URL(context.request.url).searchParams.get('action');
  if (action !== 'logout') return json({ error: 'method_not_allowed' }, 405);
  // Same-site POST only; no GET logout, prevents third-party image/link sign-outs.
  const origin = context.request.headers.get('origin');
  if (origin !== 'https://dm.pioneer-x.cn') return json({ error: 'invalid_origin' }, 403);
  return json({ loggedOut: true }, 200, { 'set-cookie': cookie(SESSION_COOKIE, '', 0) });
}
