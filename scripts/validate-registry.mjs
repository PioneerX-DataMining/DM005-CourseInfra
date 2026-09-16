import { readFile } from 'node:fs/promises';

const registryPath = new URL('../config/apps.json', import.meta.url);
const registry = JSON.parse(await readFile(registryPath, 'utf8'));
const errors = [];
const warnings = [];

if (registry.schemaVersion !== 2) errors.push('schemaVersion must be 2');
if (!registry.gateway?.edgeoneProject) errors.push('gateway.edgeoneProject is required');
if (!registry.gateway?.customDomain) errors.push('gateway.customDomain is required');
if (!registry.gateway?.site) errors.push('gateway.site is required');
if (!Array.isArray(registry.apps) || registry.apps.length === 0) errors.push('apps must be a non-empty array');

const ids = new Set();
const repos = new Set();
const mounts = new Set();

for (const app of registry.apps ?? []) {
  const label = app.id || app.repo || '<unknown app>';

  for (const key of ['id', 'name', 'slug', 'repo', 'branch', 'mount']) {
    if (!app[key]) errors.push(`${label}: ${key} is required`);
  }

  if (ids.has(app.id)) errors.push(`${label}: duplicate id ${app.id}`);
  ids.add(app.id);

  if (repos.has(app.repo)) errors.push(`${label}: duplicate repo ${app.repo}`);
  repos.add(app.repo);

  if (typeof app.mount !== 'string' || !app.mount.startsWith('/')) {
    errors.push(`${label}: mount must start with /`);
  }
  if (app.mount !== '/' && !app.mount.endsWith('/')) {
    errors.push(`${label}: non-root mount must end with /`);
  }
  if (mounts.has(app.mount)) errors.push(`${label}: duplicate mount ${app.mount}`);
  mounts.add(app.mount);

  if (!app.build || typeof app.build.output !== 'string' || app.build.output.length === 0) {
    errors.push(`${label}: build.output is required`);
  }

  if (app.publishEnabled && app.mount !== '/' && !app.basePathReady) {
    errors.push(`${label}: publishing at a non-root mount requires basePathReady=true`);
  }

  if (app.publishEnabled && app.privateRepo) {
    warnings.push(`${label}: private repository; COURSEINFRA_REPO_TOKEN with Contents: read is required.`);
  }
  if (!app.publishEnabled) warnings.push(`${label}: publishing is currently disabled`);
}

const activeRootApps = (registry.apps ?? []).filter((app) => app.publishEnabled && app.mount === '/');
if (activeRootApps.length !== 1) {
  errors.push(`Exactly one publish-enabled app must own mount /; found ${activeRootApps.length}`);
}

if (warnings.length) {
  console.log('Registry warnings:');
  for (const warning of warnings) console.log(`  - ${warning}`);
}

if (errors.length) {
  console.error('Registry validation failed:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`Registry OK: ${registry.apps.length} apps, ${registry.apps.filter((app) => app.publishEnabled).length} published.`);
