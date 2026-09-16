import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const registryPath = path.join(repoRoot, 'config', 'apps.json');
const statePath = path.join(repoRoot, 'state', 'deployments.json');
const registry = JSON.parse(await readFile(registryPath, 'utf8'));
const activeApps = registry.apps.filter((app) => app.publishEnabled);
const edgeoneToken = process.env.EDGEONE_API_TOKEN?.trim();
const repoToken = process.env.COURSEINFRA_REPO_TOKEN?.trim();
const forceDeploy = process.env.FORCE_DEPLOY === 'true';

if (!edgeoneToken) throw new Error('EDGEONE_API_TOKEN is required');
if (activeApps.length === 0) throw new Error('No publish-enabled apps');

let previousState = { schemaVersion: 1, apps: {} };
try {
  previousState = JSON.parse(await readFile(statePath, 'utf8'));
} catch {
  // First deployment: empty state intentionally forces a build.
}

function githubHeaders(app) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'DM005-CourseInfra'
  };
  if (repoToken) headers.Authorization = `Bearer ${repoToken}`;
  if (app.privateRepo && !repoToken) {
    throw new Error(`${app.id} is private but COURSEINFRA_REPO_TOKEN is not configured`);
  }
  return headers;
}

async function latestSha(app) {
  const url = `https://api.github.com/repos/${app.repo}/commits/${encodeURIComponent(app.branch)}`;
  const response = await fetch(url, { headers: githubHeaders(app), redirect: 'follow' });
  if (!response.ok) throw new Error(`${app.id}: unable to read ${app.repo}@${app.branch}: HTTP ${response.status}`);
  const data = await response.json();
  return data.sha;
}

async function downloadSource(app, destination) {
  const tarPath = `${destination}.tar.gz`;
  const url = `https://api.github.com/repos/${app.repo}/tarball/${encodeURIComponent(app.branch)}`;
  const response = await fetch(url, { headers: githubHeaders(app), redirect: 'follow' });
  if (!response.ok) throw new Error(`${app.id}: unable to download source: HTTP ${response.status}`);
  await mkdir(path.dirname(tarPath), { recursive: true });
  await writeFile(tarPath, Buffer.from(await response.arrayBuffer()));
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await runProcess('tar', ['-xzf', tarPath, '-C', destination, '--strip-components=1']);
  await rm(tarPath, { force: true });
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}

async function runShell(command, cwd) {
  if (!command?.trim()) return;
  console.log(`Running in ${cwd}: ${command}`);
  await runProcess('/bin/bash', ['-lc', command], { cwd });
}

const excluded = new Set(['.git', '.github', 'node_modules', '.DS_Store', 'CNAME', 'AGENTS.md']);

async function prepareArtifact(sourceRoot, outputRelative, artifactDir) {
  const outputPath = path.resolve(sourceRoot, outputRelative);
  const info = await stat(outputPath).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`Build output does not exist: ${outputPath}`);
  await rm(artifactDir, { recursive: true, force: true });
  await mkdir(artifactDir, { recursive: true });
  for (const entry of await readdir(outputPath, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    await cp(path.join(outputPath, entry.name), path.join(artifactDir, entry.name), {
      recursive: true,
      filter(source) {
        return !excluded.has(path.basename(source));
      }
    });
  }
}

async function copyDirectoryContents(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source)) {
    await cp(path.join(source, entry), path.join(destination, entry), { recursive: true });
  }
}

const latest = {};
for (const app of activeApps) {
  latest[app.id] = await latestSha(app);
  console.log(`${app.id}: ${latest[app.id].slice(0, 12)} (${app.repo})`);
}

const changedApps = activeApps.filter((app) => previousState.apps?.[app.id]?.sha !== latest[app.id]);
if (!forceDeploy && changedApps.length === 0) {
  console.log('No source changes detected; deployment skipped.');
  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(process.env.GITHUB_STEP_SUMMARY, '### Course site deployment\n\nNo source changes detected; nothing deployed.\n', { flag: 'a' });
  }
  process.exit(0);
}

console.log(forceDeploy ? 'Forced full deployment.' : `Changes detected: ${changedApps.map((app) => app.id).join(', ')}`);

const workRoot = path.join(os.tmpdir(), `courseinfra-${Date.now()}`);
const siteDir = path.join(workRoot, 'site');
await rm(workRoot, { recursive: true, force: true });
await mkdir(siteDir, { recursive: true });

const orderedApps = [...activeApps].sort((a, b) => {
  if (a.mount === '/') return -1;
  if (b.mount === '/') return 1;
  return a.mount.localeCompare(b.mount);
});

for (const app of orderedApps) {
  const appRoot = path.join(workRoot, app.id.toLowerCase());
  const sourceDir = path.join(appRoot, 'source');
  const artifactDir = path.join(appRoot, 'artifact');
  console.log(`\n=== Building ${app.id} -> ${app.mount} ===`);
  await downloadSource(app, sourceDir);
  await runShell(app.build?.install, sourceDir);
  await runShell(app.build?.command, sourceDir);
  await prepareArtifact(sourceDir, app.build.output, artifactDir);

  const relativeMount = app.mount === '/' ? '' : app.mount.replace(/^\/+|\/+$/g, '');
  const targetDir = path.join(siteDir, relativeMount);
  if (!targetDir.startsWith(siteDir)) throw new Error(`${app.id}: invalid mount ${app.mount}`);
  await copyDirectoryContents(artifactDir, targetDir);
}

// Makers Functions must be included in the manually built deployment directory.
const edgeFunctionsSource = path.join(repoRoot, 'edge-functions');
const edgeFunctionsInfo = await stat(edgeFunctionsSource).catch(() => null);
if (edgeFunctionsInfo?.isDirectory()) {
  await cp(edgeFunctionsSource, path.join(siteDir, 'edge-functions'), { recursive: true });
  await writeFile(
    path.join(siteDir, 'package.json'),
    JSON.stringify({ name: 'dm-course-gateway', private: true, type: 'module' }, null, 2) + '\n'
  );
  console.log('Bundled EdgeOne webhook receiver at /api/course-webhook.');
}

const infraDir = path.join(siteDir, '__infra');
await mkdir(infraDir, { recursive: true });
const publicStatus = {
  generatedAt: new Date().toISOString(),
  domain: registry.gateway.customDomain,
  edgeoneProject: registry.gateway.edgeoneProject,
  webhookPath: '/api/course-webhook',
  apps: orderedApps.map((app) => ({
    id: app.id,
    name: app.name,
    repo: app.repo,
    mount: app.mount,
    revision: latest[app.id].slice(0, 12)
  }))
};
await writeFile(path.join(infraDir, 'apps.json'), JSON.stringify(publicStatus, null, 2) + '\n');
await writeFile(path.join(infraDir, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DM CourseInfra</title><style>body{font-family:system-ui,sans-serif;max-width:900px;margin:40px auto;padding:0 20px;line-height:1.6}code{background:#f3f4f6;padding:2px 6px;border-radius:5px}li{margin:8px 0}</style><h1>DM CourseInfra</h1><p>统一课程站点由 DM005 集中构建并部署到 EdgeOne。</p><p>Webhook: <code>/api/course-webhook</code></p><ul>${orderedApps.map((app) => `<li><strong>${app.id}</strong> ${app.name} → <code>${app.mount}</code> · ${latest[app.id].slice(0, 12)}</li>`).join('')}</ul></html>`);

console.log(`\nDeploying assembled site to EdgeOne project ${registry.gateway.edgeoneProject}...`);
await runProcess('edgeone', [
  'makers', 'deploy', siteDir,
  '-n', registry.gateway.edgeoneProject,
  '-t', edgeoneToken,
  '-e', registry.gateway.environment || 'production',
  '--site', registry.gateway.site || 'china'
]);

const deployedAt = new Date().toISOString();
const nextState = {
  schemaVersion: 1,
  gatewayProject: registry.gateway.edgeoneProject,
  lastSuccessfulDeployment: deployedAt,
  apps: Object.fromEntries(orderedApps.map((app) => [app.id, {
    repo: app.repo,
    branch: app.branch,
    sha: latest[app.id],
    mount: app.mount
  }]))
};
await mkdir(path.dirname(statePath), { recursive: true });
await writeFile(statePath, JSON.stringify(nextState, null, 2) + '\n');

if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = orderedApps.map((app) => `| ${app.id} | \`${app.mount}\` | \`${latest[app.id].slice(0, 12)}\` |`).join('\n');
  await writeFile(process.env.GITHUB_STEP_SUMMARY, `### Course site deployed to EdgeOne\n\nProject: \`${registry.gateway.edgeoneProject}\`\n\n| App | Mount | Revision |\n|---|---|---|\n${rows}\n`, { flag: 'a' });
}

console.log(`Deployment completed at ${deployedAt}`);
