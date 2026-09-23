import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { Makers } from '@edgeone/makers-sdk';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const registryPath = path.join(repoRoot, 'config', 'apps.json');
const statePath = path.join(repoRoot, 'state', 'deployments.json');
const registry = JSON.parse(await readFile(registryPath, 'utf8'));
const activeApps = registry.apps.filter((app) => app.publishEnabled);
const edgeoneToken = process.env.EDGEONE_API_TOKEN?.trim();
const repoToken = process.env.COURSEINFRA_REPO_TOKEN?.trim();
const forceDeploy = process.env.FORCE_DEPLOY === 'true';
const buildRunId = process.env.GITHUB_RUN_ID || null;

if (!edgeoneToken) throw new Error('EDGEONE_API_TOKEN is required');
if (activeApps.length === 0) throw new Error('No publish-enabled apps');

const apiRegion = registry.gateway.site === 'china' ? 'china' : 'global';
const makers = new Makers({
  token: edgeoneToken,
  region: apiRegion,
  timeout: 30,
  retries: 3
});

let previousState = { schemaVersion: 2, apps: {} };
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

async function resolveProjectId() {
  if (registry.gateway.projectId) return registry.gateway.projectId;
  const page = await makers.projects.list({
    name: registry.gateway.edgeoneProject,
    page: 0,
    pageSize: 20
  });
  const exact = page.items.find((project) => project.name === registry.gateway.edgeoneProject);
  if (!exact) throw new Error(`EdgeOne project not found: ${registry.gateway.edgeoneProject}`);
  return exact.projectId;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchLiveStatus() {
  const infraPath = registry.gateway.infraPath || '/__infra/';
  const base = infraPath.endsWith('/') ? infraPath : `${infraPath}/`;
  const url = `https://${registry.gateway.customDomain}${base}apps.json?ts=${Date.now()}`;
  try {
    const response = await fetch(url, {
      headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
      redirect: 'follow'
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.warn(`Unable to read live deployment status: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function liveStatusMatchesLatest(liveStatus, latest) {
  if (!liveStatus?.apps || !Array.isArray(liveStatus.apps)) return false;
  const live = new Map(liveStatus.apps.map((app) => [app.id, app.revision]));
  return activeApps.every((app) => live.get(app.id) === latest[app.id].slice(0, 12));
}

const latest = {};
for (const app of activeApps) {
  latest[app.id] = await latestSha(app);
  console.log(`${app.id}: ${latest[app.id].slice(0, 12)} (${app.repo})`);
}

const orderedApps = [...activeApps].sort((a, b) => {
  if (a.mount === '/') return -1;
  if (b.mount === '/') return 1;
  return a.mount.localeCompare(b.mount);
});

function makeState({ deployedAt, deploymentId = null, deploymentStatus = 'Success' }) {
  return {
    schemaVersion: 2,
    gatewayProject: registry.gateway.edgeoneProject,
    gatewayProjectId: registry.gateway.projectId || null,
    lastSuccessfulDeployment: deployedAt,
    lastDeploymentId: deploymentId,
    lastDeploymentStatus: deploymentStatus,
    apps: Object.fromEntries(orderedApps.map((app) => [app.id, {
      repo: app.repo,
      branch: app.branch,
      sha: latest[app.id],
      mount: app.mount
    }]))
  };
}

async function writeState(state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2) + '\n');
}

const changedApps = activeApps.filter((app) => previousState.apps?.[app.id]?.sha !== latest[app.id]);
if (!forceDeploy && changedApps.length === 0) {
  console.log('No source changes detected; deployment skipped.');
  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(process.env.GITHUB_STEP_SUMMARY, '### Course site deployment\n\nNo source changes detected; nothing deployed.\n', { flag: 'a' });
  }
  process.exit(0);
}

if (!forceDeploy) {
  const liveStatus = await fetchLiveStatus();
  if (liveStatusMatchesLatest(liveStatus, latest)) {
    const reconciledAt = liveStatus.generatedAt || new Date().toISOString();
    console.log('Live site already matches all latest repository revisions; repairing local deployment state without redeploying.');
    await writeState(makeState({
      deployedAt: reconciledAt,
      deploymentId: previousState.lastDeploymentId || null,
      deploymentStatus: 'Success'
    }));
    if (process.env.GITHUB_STEP_SUMMARY) {
      await writeFile(process.env.GITHUB_STEP_SUMMARY, '### Course site reconciliation\n\nLive site already matches the latest repository revisions. Local deployment state was repaired; no new EdgeOne deployment was created.\n', { flag: 'a' });
    }
    process.exit(0);
  }
}

console.log(forceDeploy ? 'Forced full deployment.' : `Changes detected: ${changedApps.map((app) => app.id).join(', ')}`);

const workRoot = path.join(os.tmpdir(), `courseinfra-${Date.now()}`);
const siteDir = path.join(workRoot, 'site');
await rm(workRoot, { recursive: true, force: true });
await mkdir(siteDir, { recursive: true });

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
const generatedAt = new Date().toISOString();
const triggerInfo = {
  repository: process.env.TRIGGER_REPOSITORY || null,
  revision: process.env.TRIGGER_REVISION ? process.env.TRIGGER_REVISION.slice(0, 12) : null,
  forceDeploy,
  githubRunId: buildRunId
};
const publicStatus = {
  generatedAt,
  lastSuccessfulDeployment: previousState.lastSuccessfulDeployment || null,
  domain: registry.gateway.customDomain,
  edgeoneProject: registry.gateway.edgeoneProject,
  edgeoneProjectId: registry.gateway.projectId || null,
  webhookPath: '/api/course-webhook',
  deploymentPolicy: {
    mode: 'single-flight-latest-state',
    transport: 'EdgeOne Makers SDK',
    selfHealSchedule: 'every 30 minutes',
    note: 'One production deployment runs at a time; concurrent pushes collapse into the latest pending deployment.'
  },
  trigger: triggerInfo,
  changedApps: changedApps.map((app) => app.id),
  apps: orderedApps.map((app) => {
    const previousRevision = previousState.apps?.[app.id]?.sha || null;
    return {
      id: app.id,
      name: app.name,
      repo: app.repo,
      mount: app.mount,
      revision: latest[app.id].slice(0, 12),
      previousRevision: previousRevision ? previousRevision.slice(0, 12) : null,
      changed: previousRevision !== latest[app.id]
    };
  })
};
await writeFile(path.join(infraDir, 'apps.json'), JSON.stringify(publicStatus, null, 2) + '\n');

const changedLabel = changedApps.length ? changedApps.map((app) => app.id).join(', ') : '无（强制部署 / 基础设施变更）';
const statusRows = publicStatus.apps.map((app) => `<tr><td><strong>${app.id}</strong><br><span>${app.name}</span></td><td><code>${app.mount}</code></td><td><code>${app.revision}</code></td><td>${app.changed ? '更新' : '未变'}</td></tr>`).join('');
await writeFile(path.join(infraDir, 'index.html'), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DM CourseInfra Status</title><style>body{font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;max-width:1000px;margin:40px auto;padding:0 20px;line-height:1.6;color:#172033}h1{margin-bottom:6px}.muted,td span{color:#667085}code{background:#f3f4f6;padding:2px 6px;border-radius:5px}table{width:100%;border-collapse:collapse;margin-top:22px}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #e5e7eb;font-size:14px}.box{background:#f8fafc;border:1px solid #e5e7eb;border-radius:12px;padding:16px 18px;margin:18px 0}.ok{font-weight:700;color:#067647}@media(max-width:640px){th:nth-child(2),td:nth-child(2){display:none}}</style></head><body><h1>DM CourseInfra</h1><p class="muted">课程站点统一部署状态</p><div class="box"><div class="ok">当前页面来自一次成功发布</div><div>本页生成时间：<code>${generatedAt}</code></div><div>上一次记录的成功部署：<code>${previousState.lastSuccessfulDeployment || '首次部署'}</code></div><div>本次检测到变化：<code>${changedLabel}</code></div><div>部署策略：单通道串行；并发提交合并为最新待部署状态；每 30 分钟自动自愈检查。</div><div>发布通道：EdgeOne Makers SDK（deploymentId 跟踪）。</div></div><p>Webhook：<code>/api/course-webhook</code> · JSON 状态：<code>/__infra/apps.json</code></p><table><thead><tr><th>项目</th><th>路径</th><th>当前版本</th><th>本次</th></tr></thead><tbody>${statusRows}</tbody></table></body></html>`);

const projectId = await resolveProjectId();
console.log(`\nDeploying assembled site to EdgeOne project ${registry.gateway.edgeoneProject} (${projectId}) via Makers SDK...`);

async function createDeploymentWithSafeUploadRetry() {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await makers.deployments.deploy({
        projectId,
        artifact: { directory: siteDir },
        env: 'Production'
      });
    } catch (error) {
      const isUploadFailure = error?.name === 'UploadError';
      if (!isUploadFailure || attempt === 2) throw error;
      console.warn(`Artifact upload failed before a deployment was created; safe retry ${attempt}/1 in 10 seconds: ${error.message || error}`);
      await sleep(10000);
    }
  }
  throw new Error('Unable to create EdgeOne deployment');
}

const deployment = await createDeploymentWithSafeUploadRetry();
console.log(`EdgeOne deployment created: ${deployment.deploymentId}`);

let result;
try {
  result = await makers.deployments.wait({
    projectId,
    deploymentId: deployment.deploymentId,
    timeout: 600,
    pollInterval: 5,
    onStatusChange(event) {
      const current = event?.deployment?.status || 'Unknown';
      const previous = event?.previousStatus || 'initial';
      console.log(`EdgeOne deployment status: ${previous} -> ${current}`);
    }
  });
} catch (error) {
  if (error?.name === 'DeploymentTimeoutError') {
    const current = await makers.deployments.get({
      projectId,
      deploymentId: deployment.deploymentId
    }).catch(() => null);
    console.error(`Local wait timed out for deployment ${deployment.deploymentId}; remote status is ${current?.status || 'unknown'}. No second deployment will be created in this run.`);
  }
  throw error;
}

if (result.status !== 'Success') {
  throw new Error(`EdgeOne deployment ${deployment.deploymentId} ended with status ${result.status}${result.code ? ` (${result.code})` : ''}`);
}

const deployedAt = new Date().toISOString();
await writeState(makeState({
  deployedAt,
  deploymentId: deployment.deploymentId,
  deploymentStatus: result.status
}));

if (process.env.GITHUB_STEP_SUMMARY) {
  const summaryRows = orderedApps.map((app) => `| ${app.id} | \`${app.mount}\` | \`${latest[app.id].slice(0, 12)}\` |`).join('\n');
  await writeFile(process.env.GITHUB_STEP_SUMMARY, `### Course site deployed to EdgeOne\n\nProject: \`${registry.gateway.edgeoneProject}\`\n\nDeployment: \`${deployment.deploymentId}\`\n\nStatus: \`${result.status}\`\n\n| App | Mount | Revision |\n|---|---|---|\n${summaryRows}\n`, { flag: 'a' });
}

console.log(`Deployment ${deployment.deploymentId} completed successfully at ${deployedAt}`);
