import assert from 'node:assert/strict';
import {
  REASON,
  checkProjectPages,
  classifyServed,
  classifySource,
  digest,
  formatReport,
  hasRootEntry,
  hubBodyFromResponse,
  pageUrl,
  runCli,
  summarize
} from './check-project-pages.mjs';

const HUB = '<!doctype html><html><head><title>DM001 · 数据挖掘 Course Hub</title></head><body>hub</body></html>';
const APP = {
  id: 'DM099',
  name: 'Demo',
  slug: 'dm099',
  repo: 'PioneerX-DataMining/DM099-Demo',
  branch: 'main',
  mount: '/projects/dm099/',
  publishEnabled: true,
  basePathReady: true,
  privateRepo: true,
  build: { install: '', command: '', output: '.' }
};
const STATE = { apps: { DM099: { repo: APP.repo, branch: 'main', sha: 'a1b2c3d4e5f6', mount: APP.mount } } };
const HEALTHY_REPO = { sha: 'a1b2c3d4e5f6', rootEntries: ['index.html', 'assets', 'README.md'] };

// 1. Healthy project: source and served side both agree.
{
  const source = classifySource(APP, { state: STATE, repo: HEALTHY_REPO });
  assert.equal(source.code, REASON.READY, 'matching revision and root index.html must be READY');
  const served = classifyServed(APP, { status: 200, body: '<html>project</html>', hubBody: HUB });
  assert.equal(served.code, REASON.READY, 'distinct page body must be READY');
}

// 2. publishEnabled=false is reported instead of silently skipping.
{
  const source = classifySource({ ...APP, publishEnabled: false }, { state: STATE, repo: HEALTHY_REPO });
  assert.equal(source.code, REASON.DISABLED);
}

// 3. A project with no recorded deployment revision.
{
  const source = classifySource(APP, { state: { apps: {} }, repo: HEALTHY_REPO });
  assert.equal(source.code, REASON.NOT_IN_STATE);
}

// 4. Unreadable repository (private repo without token, renamed repo, ...).
{
  const source = classifySource(APP, { state: STATE, repo: { error: 'HTTP 404 reading commits/main' } });
  assert.equal(source.code, REASON.MISSING_REPO);
  assert.match(source.detail, /HTTP 404/);
  const thrown = await checkProjectPages({
    registry: { gateway: { customDomain: 'dm.example.test' }, apps: [APP] },
    state: STATE,
    readRepo: () => { throw new Error('network down'); }
  });
  assert.equal(thrown[0].code, REASON.MISSING_REPO, 'a throwing reader must degrade to MISSING_REPO');
}

// 5. Entry file is not at the repository root: the mount would serve the hub instead.
{
  const source = classifySource(APP, { state: STATE, repo: { sha: 'a1b2c3d4e5f6', rootEntries: ['src', 'docs', 'package.json'] } });
  assert.equal(source.code, REASON.NO_ROOT_INDEX);
  assert.match(source.detail, /src, docs/);
}

// 6. Students pushed to main after the last deployment was recorded.
{
  const source = classifySource(APP, { state: STATE, repo: { sha: 'ffffffffffff', rootEntries: ['index.html'] } });
  assert.equal(source.code, REASON.STALE_DEPLOY);
  assert.match(source.detail, /ffffffff/);
  assert.match(source.detail, /a1b2c3d4/);
}

// 7. The gateway serves the hub page for an unpublished mount: HTTP 200 is not success.
{
  const served = classifyServed(APP, { status: 200, body: HUB, hubBody: HUB });
  assert.equal(served.code, REASON.FALLBACK_PAGE);
  assert.match(served.detail, /hub/);
}

// 8. Fallback detection must compare content, not length.
{
  const sameLength = 'x'.repeat(HUB.length);
  const served = classifyServed(APP, { status: 200, body: sameLength, hubBody: HUB });
  assert.equal(served.code, REASON.READY, 'equal-length but different bytes is a real page');
  assert.equal(digest(sameLength) === digest(HUB), false);
}

// 9. The hub itself is mounted at "/" and must not be compared against itself.
{
  const rootApp = { ...APP, id: 'DM001', mount: '/' };
  const served = classifyServed(rootApp, { status: 200, body: HUB, hubBody: HUB });
  assert.equal(served.code, REASON.READY);
}

// 10. Non-200 responses and probe failures are errors, not successes.
{
  assert.equal(classifyServed(APP, { status: 503, body: 'busy', hubBody: HUB }).code, REASON.HTTP_ERROR);
  const failed = await checkProjectPages({
    registry: { gateway: { customDomain: 'dm.example.test' }, apps: [APP] },
    state: STATE,
    hubBody: HUB,
    readRepo: async () => HEALTHY_REPO,
    probe: async () => { throw new Error('timeout'); }
  });
  assert.equal(failed[0].code, REASON.HTTP_ERROR);
  assert.match(failed[0].served.detail, /timeout/);
}

// 11. Aggregate: the most severe finding wins and both sides are kept for the report.
{
  const results = await checkProjectPages({
    registry: { gateway: { customDomain: 'dm.example.test' }, apps: [APP] },
    state: { apps: {} },
    hubBody: HUB,
    readRepo: async () => HEALTHY_REPO,
    probe: async () => ({ status: 200, body: HUB })
  });
  assert.equal(results[0].code, REASON.NOT_IN_STATE, 'source findings must not be hidden by a 200 response');
  assert.equal(results[0].served.code, REASON.FALLBACK_PAGE, 'served side is still reported');
  assert.equal(pageUrl('dm.example.test', APP.mount), 'https://dm.example.test/projects/dm099/');
}

// 12. Summary and report text are stable for CI logs.
{
  const results = [
    { id: 'DM001', mount: '/', code: REASON.READY, source: { code: REASON.READY, detail: 'ok' }, served: null },
    { id: 'DM099', mount: APP.mount, code: REASON.FALLBACK_PAGE, source: { code: REASON.READY, detail: 'ok' }, served: { code: REASON.FALLBACK_PAGE, detail: 'hub page' } }
  ];
  const summary = summarize(results);
  assert.equal(summary.total, 2);
  assert.equal(summary.ok, 1);
  assert.equal(summary.counts[REASON.FALLBACK_PAGE], 1);
  const report = formatReport(results);
  assert.match(report, /checked 2 project\(s\): 1 ready, 1 need attention/);
  assert.match(report, /FALLBACK_PAGE: 1/);
}

// 13. Root entry detection is case insensitive and tolerates index.htm.
{
  assert.equal(hasRootEntry(['Index.HTML']), true);
  assert.equal(hasRootEntry(['index.htm']), true);
  assert.equal(hasRootEntry(['index.html.bak', 'assets']), false);
  assert.equal(hasRootEntry(undefined), false);
}

// 14. A served-side check requested without a registry domain must never report READY.
// Asking for the probe means "I want the served side verified"; a missing domain
// makes that verification impossible, so the gap has to surface as its own code.
{
  let probed = 0;
  const results = await checkProjectPages({
    registry: { gateway: {}, apps: [APP] },
    state: STATE,
    hubBody: HUB,
    readRepo: async () => HEALTHY_REPO,
    probe: async () => {
      probed += 1;
      return { status: 200, body: '<html>project</html>' };
    }
  });
  assert.equal(results[0].served.code, REASON.NO_CUSTOM_DOMAIN);
  assert.equal(results[0].code, REASON.NO_CUSTOM_DOMAIN, 'a served check that never ran must not aggregate to READY');
  assert.equal(probed, 0, 'no probe should be attempted without a domain to build the URL from');
  assert.match(formatReport(results), /NO_CUSTOM_DOMAIN: 1/);
}

// 15. Source-only mode still works without a domain: no probe was requested.
{
  const results = await checkProjectPages({
    registry: { gateway: {}, apps: [APP] },
    state: STATE,
    readRepo: async () => HEALTHY_REPO
  });
  assert.equal(results[0].code, REASON.READY);
  assert.equal(results[0].served, null, 'the served side is unknown, not failed, when no probe was requested');
}

// 16. An unusable hub body is a hard error: every fallback comparison fails open without it.
{
  assert.match(hubBodyFromResponse({ ok: false, status: 503 }, '').error, /HTTP 503/);
  assert.match(hubBodyFromResponse(undefined, undefined).error, /no response/);
  assert.match(hubBodyFromResponse({ ok: true, status: 200 }, '   ').error, /empty/);
  assert.equal(hubBodyFromResponse({ ok: true, status: 200 }, HUB).hubBody, HUB);

  const broken = hubBodyFromResponse({ ok: false, status: 500 }, '<html>500</html>');
  assert.equal(broken.hubBody, undefined);
  // Demonstration of the exact failure the guard prevents: with no hub body the
  // comparison cannot fire, so an error page served at a mount looks READY.
  const withoutHub = classifyServed(APP, { status: 200, body: '<html>500</html>', hubBody: broken.hubBody });
  assert.equal(withoutHub.code, REASON.READY, 'missing hub body silently disables fallback detection');
  const withHub = classifyServed(APP, { status: 200, body: HUB, hubBody: HUB });
  assert.equal(withHub.code, REASON.FALLBACK_PAGE);
}

// 17. CLI wiring: the hub guard must abort the run, not merely exist.
{
  const seen = [];
  const failedHub = async (url) => {
    seen.push(url);
    return { ok: false, status: 503, text: async () => '<html>503</html>' };
  };
  const rc = await runCli({
    token: 'test-token',
    fetchImpl: failedHub,
    registry: { gateway: { customDomain: 'dm.example.test' }, apps: [APP] },
    state: STATE,
    log: () => {},
    logError: () => {}
  });
  assert.equal(rc, 2, 'an unusable hub page must stop the run instead of reporting READY');
  assert.equal(seen.length, 1, 'no project may be probed after the hub guard failed');
}

// 18. CLI wiring end to end: the same registry exits 1 on a fallback page and 0 on a real page.
{
  const makeTransport = (projectBody) => async (url) => {
    if (url === 'https://dm.example.test/') return { ok: true, status: 200, text: async () => HUB };
    if (url === 'https://dm.example.test/projects/dm099/') return { ok: true, status: 200, text: async () => projectBody };
    if (url.endsWith('/commits/main')) return { ok: true, status: 200, json: async () => ({ sha: 'a1b2c3d4e5f6' }) };
    if (url.includes('/git/trees/')) return { ok: true, status: 200, json: async () => ({ tree: [{ path: 'index.html' }] }) };
    throw new Error(`unexpected url ${url}`);
  };
  const run = async (projectBody) => {
    const lines = [];
    const rc = await runCli({
      token: 'test-token',
      fetchImpl: makeTransport(projectBody),
      registry: { gateway: { customDomain: 'dm.example.test' }, apps: [APP] },
      state: STATE,
      log: (line) => lines.push(line),
      logError: (line) => lines.push(line)
    });
    return { rc, text: lines.join('\n') };
  };

  const fallback = await run(HUB);
  assert.equal(fallback.rc, 1, 'a mount serving the hub page must fail the run');
  assert.match(fallback.text, /FALLBACK_PAGE: 1/);

  const healthy = await run('<html><title>DM099 Demo</title>project</html>');
  assert.equal(healthy.rc, 0, 'a mount serving its own page must pass');
  assert.match(healthy.text, /checked 1 project\(s\): 1 ready, 0 need attention/);
}

// 19. CLI wiring: a registry without a domain stops before any request is made.
{
  let calls = 0;
  const rc = await runCli({
    token: 'test-token',
    fetchImpl: async () => {
      calls += 1;
      throw new Error('no request should be made without a domain');
    },
    registry: { gateway: {}, apps: [APP] },
    state: STATE,
    log: () => {},
    logError: () => {}
  });
  assert.equal(rc, 2);
  assert.equal(calls, 0, 'the missing domain must be detected before the hub fetch');
}

// 20. CLI wiring: without a token the source side cannot be read, so refuse to run.
{
  let calls = 0;
  const lines = [];
  const rc = await runCli({
    token: '',
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, status: 200, text: async () => HUB };
    },
    registry: { gateway: { customDomain: 'dm.example.test' }, apps: [APP] },
    state: STATE,
    log: (line) => lines.push(line),
    logError: (line) => lines.push(line)
  });
  assert.equal(rc, 2);
  assert.equal(calls, 0, 'no request may be attempted without a token');
  assert.match(lines.join('\n'), /is required for source checks/);
}

console.log('Course project page diagnosis checks passed (20 groups).');
