import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/**
 * Diagnose why a published course project page does or does not show the code
 * that students pushed to the project repository.
 *
 * The course gateway serves the course hub page for any unmatched path, so an
 * HTTP 200 alone never proves that a project page was published. This module
 * therefore classifies both the source side (registry / branch / entry file /
 * recorded deployment revision) and the served side (is the response actually
 * the project, or the hub fallback page).
 */

export const REASON = {
  READY: 'READY',
  DISABLED: 'DISABLED',
  NOT_IN_STATE: 'NOT_IN_STATE',
  MISSING_REPO: 'MISSING_REPO',
  NO_ROOT_INDEX: 'NO_ROOT_INDEX',
  STALE_DEPLOY: 'STALE_DEPLOY',
  FALLBACK_PAGE: 'FALLBACK_PAGE',
  NO_CUSTOM_DOMAIN: 'NO_CUSTOM_DOMAIN',
  HTTP_ERROR: 'HTTP_ERROR'
};

export const REGISTRY_PATH = new URL('../config/apps.json', import.meta.url);
export const STATE_PATH = new URL('../state/deployments.json', import.meta.url);

const ROOT_INDEX_NAMES = new Set(['index.html', 'index.htm']);

export function digest(value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ''), 'utf8');
  return createHash('sha256').update(body).digest('hex');
}

export function hasRootEntry(rootEntries) {
  if (!Array.isArray(rootEntries)) return false;
  return rootEntries.some((name) => ROOT_INDEX_NAMES.has(String(name).toLowerCase()));
}

/**
 * Source-side classification: does the registry, the repository and the last
 * recorded deployment agree that this project is publishable right now?
 */
export function classifySource(app, { state, repo } = {}) {
  if (!app || typeof app !== 'object') {
    return { code: REASON.MISSING_REPO, detail: 'registry entry is missing' };
  }
  if (app.publishEnabled !== true) {
    return { code: REASON.DISABLED, detail: 'publishEnabled is not true in config/apps.json' };
  }
  if (!repo || repo.error) {
    return { code: REASON.MISSING_REPO, detail: `cannot read ${app.repo}@${app.branch}: ${repo?.error || 'no repository data'}` };
  }
  const recorded = state?.apps?.[app.id]?.sha;
  if (!recorded) {
    return { code: REASON.NOT_IN_STATE, detail: 'no deployment revision recorded for this app' };
  }
  if (!hasRootEntry(repo.rootEntries)) {
    return {
      code: REASON.NO_ROOT_INDEX,
      detail: `repository root has no index.html (found: ${(repo.rootEntries || []).slice(0, 6).join(', ') || 'empty'})`
    };
  }
  if (repo.sha !== recorded) {
    return {
      code: REASON.STALE_DEPLOY,
      detail: `main is at ${String(repo.sha).slice(0, 8)} but the last deployment recorded ${String(recorded).slice(0, 8)}`
    };
  }
  return { code: REASON.READY, detail: `source at ${String(recorded).slice(0, 8)} is the deployed revision` };
}

/**
 * Served-side classification. A 200 response is only trustworthy when the body
 * is not the course hub fallback page; the hub is served for unknown paths.
 */
export function classifyServed(app, { status, body, hubBody } = {}) {
  if (status !== 200) {
    return { code: REASON.HTTP_ERROR, detail: `HTTP ${status}` };
  }
  const isRootApp = app?.mount === '/';
  if (!isRootApp && hubBody != null && body != null && digest(body) === digest(hubBody)) {
    return {
      code: REASON.FALLBACK_PAGE,
      detail: 'response is byte-identical to the course hub page; the mount path is not served by this project'
    };
  }
  return { code: REASON.READY, detail: 'served page is not the hub fallback' };
}

export function pageUrl(customDomain, mount) {
  const base = `https://${customDomain}`;
  return base + (mount || '/');
}

/**
 * Read the hub body that the fallback detector depends on.
 *
 * The detector compares every project response against the hub page, so a hub
 * body that is an error page or an empty document makes every comparison fail
 * open: nothing would ever look like the fallback. The callers must therefore
 * treat an unusable hub body as a hard error instead of continuing.
 */
export function hubBodyFromResponse(response, body) {
  if (!response || response.ok !== true) {
    const reason = response ? `HTTP ${response.status}` : 'no response';
    return { error: `cannot read the course hub page (${reason}); the fallback check would silently pass` };
  }
  if (body == null || String(body).trim() === '') {
    return { error: 'the course hub page body is empty; the fallback check would silently pass' };
  }
  return { hubBody: body };
}

/**
 * Run both checks for every registry app.
 *
 * @param {object} options
 * @param {object} options.registry parsed config/apps.json
 * @param {object} options.state parsed state/deployments.json
 * @param {(app: object) => Promise<{sha?: string, rootEntries?: string[], error?: string}>} options.readRepo
 * @param {(url: string) => Promise<{status: number, body: string|Buffer}>} [options.probe]
 * @param {string} [options.hubBody] body of the course hub page, used to detect the fallback
 */
export async function checkProjectPages({ registry, state, readRepo, probe, hubBody } = {}) {
  const apps = Array.isArray(registry?.apps) ? registry.apps : [];
  const domain = registry?.gateway?.customDomain;
  const results = [];
  for (const app of apps) {
    let repo;
    try {
      repo = await readRepo(app);
    } catch (error) {
      repo = { error: error?.message || String(error) };
    }
    const source = classifySource(app, { state, repo });
    let served = null;
    if (probe && !domain) {
      // Requested a served-side check but the registry has no domain to build a
      // URL from. Reporting READY here would hide every project behind a check
      // that never ran, so the missing input is surfaced as its own finding.
      served = {
        code: REASON.NO_CUSTOM_DOMAIN,
        detail: 'gateway.customDomain is missing from the registry, so no page was probed'
      };
    } else if (probe) {
      const url = pageUrl(domain, app.mount);
      try {
        const response = await probe(url);
        served = classifyServed(app, {
          status: response?.status,
          body: response?.body,
          hubBody
        });
      } catch (error) {
        served = { code: REASON.HTTP_ERROR, detail: `probe failed: ${error?.message || String(error)}` };
      }
    }
    const codes = [source.code, served?.code].filter(Boolean);
    const worst = codes.find((code) => code !== REASON.READY) || REASON.READY;
    results.push({
      id: app.id,
      mount: app.mount,
      code: worst,
      source,
      served,
      repo: app.repo,
      branch: app.branch
    });
  }
  return results;
}

export function summarize(results) {
  const counts = {};
  for (const row of results) counts[row.code] = (counts[row.code] || 0) + 1;
  return { total: results.length, ok: counts.READY || 0, counts };
}

export function formatReport(results) {
  const lines = ['project  mount                code             detail'];
  for (const row of results) {
    const detail = row.code === REASON.READY
      ? row.source.detail
      : [row.source.code !== REASON.READY ? row.source.detail : null,
         row.served && row.served.code !== REASON.READY ? row.served.detail : null]
        .filter(Boolean).join(' | ');
    lines.push(`${String(row.id).padEnd(8)} ${String(row.mount).padEnd(20)} ${row.code.padEnd(16)} ${detail}`);
  }
  const { total, ok, counts } = summarize(results);
  lines.push('');
  lines.push(`checked ${total} project(s): ${ok} ready, ${total - ok} need attention`);
  for (const [code, count] of Object.entries(counts)) {
    if (code !== REASON.READY) lines.push(`  ${code}: ${count}`);
  }
  return lines.join('\n');
}

async function githubRootEntries(repo, branch, token, fetchImpl = fetch) {
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'dm005-courseinfra-diagnose',
    authorization: `Bearer ${token}`
  };
  const commitResponse = await fetchImpl(`https://api.github.com/repos/${repo}/commits/${branch}`, { headers });
  if (!commitResponse.ok) {
    return { error: `HTTP ${commitResponse.status} reading commits/${branch}` };
  }
  const commit = await commitResponse.json();
  const treeResponse = await fetchImpl(`https://api.github.com/repos/${repo}/git/trees/${commit.sha}`, { headers });
  if (!treeResponse.ok) {
    return { sha: commit.sha, error: `HTTP ${treeResponse.status} reading tree` };
  }
  const tree = await treeResponse.json();
  return { sha: commit.sha, rootEntries: (tree.tree || []).map((entry) => entry.path) };
}

/**
 * Command-line body, kept separate from `main()` so the wiring itself (hub guard
 * included) can be asserted offline instead of only by running the real site.
 *
 * @returns {Promise<number>} process exit code: 0 all READY, 1 findings, 2 cannot diagnose
 */
export async function runCli({
  token = process.env.COURSEINFRA_REPO_TOKEN || process.env.GITHUB_TOKEN,
  fetchImpl = fetch,
  log = (line) => console.log(line),
  logError = (line) => console.error(line),
  registry,
  state
} = {}) {
  if (!token) {
    logError('COURSEINFRA_REPO_TOKEN or GITHUB_TOKEN is required for source checks.');
    return 2;
  }
  const reg = registry ?? JSON.parse(await readFile(REGISTRY_PATH, 'utf8'));
  const st = state ?? JSON.parse(await readFile(STATE_PATH, 'utf8'));
  const domain = reg?.gateway?.customDomain;
  if (!domain) {
    logError('config/apps.json has no gateway.customDomain: the served-side check cannot run.');
    return 2;
  }
  const hubUrl = pageUrl(domain, '/');
  let hubResponse;
  let hubText;
  try {
    hubResponse = await fetchImpl(hubUrl, { headers: { 'cache-control': 'no-cache' } });
    hubText = await hubResponse.text();
  } catch (error) {
    logError(`cannot reach the course hub page ${hubUrl}: ${error?.message || String(error)}`);
    return 2;
  }
  const hub = hubBodyFromResponse(hubResponse, hubText);
  if (hub.error) {
    logError(`${hub.error} (${hubUrl})`);
    return 2;
  }
  const results = await checkProjectPages({
    registry: reg,
    state: st,
    hubBody: hub.hubBody,
    readRepo: (app) => githubRootEntries(app.repo, app.branch, token, fetchImpl),
    probe: async (url) => {
      const response = await fetchImpl(url, { headers: { 'cache-control': 'no-cache' } });
      return { status: response.status, body: await response.text() };
    }
  });
  log(formatReport(results));
  const { ok, total } = summarize(results);
  return ok === total ? 0 : 1;
}

async function main() {
  process.exit(await runCli());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
