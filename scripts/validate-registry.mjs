import { readFile } from 'node:fs/promises';

const registryPath = new URL('../config/apps.json', import.meta.url);
const registry = JSON.parse(await readFile(registryPath, 'utf8'));
const errors = [];
const warnings = [];

if (registry.schemaVersion !== 1) errors.push('schemaVersion must be 1');
if (!registry.gateway?.edgeoneProject) errors.push('gateway.edgeoneProject is required');
if (!registry.gateway?.customDomain) errors.push('gateway.customDomain is required');
if (!Array.isArray(registry.apps) || registry.apps.length === 0) errors.push('apps must be a non-empty array');

const ids = new Set();
const repos = new Set();
const projects = new Set();
const mounts = new Set();
const projectPattern = /^[a-z0-9](?:[a-z0-9-]{3,48}[a-z0-9])$/;

for (const app of registry.apps ?? []) {
  const label = app.id || app.repo || '<unknown app>';

  for (const key of ['id', 'name', 'slug', 'repo', 'branch', 'mount', 'edgeoneProject']) {
    if (!app[key]) errors.push(`${label}: ${key} is required`);
  }

  if (ids.has(app.id)) errors.push(`${label}: duplicate id ${app.id}`);
  ids.add(app.id);

  if (repos.has(app.repo)) errors.push(`${label}: duplicate repo ${app.repo}`);
  repos.add(app.repo);

  if (projects.has(app.edgeoneProject)) errors.push(`${label}: duplicate EdgeOne project ${app.edgeoneProject}`);
  projects.add(app.edgeoneProject);

  if (!projectPattern.test(app.edgeoneProject ?? '')) {
    errors.push(`${label}: edgeoneProject must be 5-50 chars, lowercase letters/digits/hyphens, and not start/end with a hyphen`);
  }

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

  if (app.routeEnabled) {
    if (!app.deployEnabled) errors.push(`${label}: routeEnabled requires deployEnabled=true`);
    if (!app.origin) errors.push(`${label}: routeEnabled requires a non-empty origin`);
    if (app.origin && !/^https:\/\//.test(app.origin)) errors.push(`${label}: origin must use https://`);
    if (app.mount !== '/' && !app.basePathReady) {
      errors.push(`${label}: a non-root route requires basePathReady=true`);
    }
  }

  if (app.deployEnabled && app.privateRepo) {
    warnings.push(`${label}: private repository; central deployment needs COURSEINFRA_REPO_TOKEN`);
  }
  if (!app.deployEnabled) warnings.push(`${label}: deployment is currently disabled`);
}

const activeRootRoutes = (registry.apps ?? []).filter((app) => app.routeEnabled && app.mount === '/');
if (activeRootRoutes.length > 1) errors.push('Only one route can own mount /');
if (activeRootRoutes.length === 0) warnings.push('No active root route yet; Gateway will show its setup page at /.');

if (warnings.length) {
  console.log('Registry warnings:');
  for (const warning of warnings) console.log(`  - ${warning}`);
}

if (errors.length) {
  console.error('Registry validation failed:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`Registry OK: ${registry.apps.length} apps, ${registry.apps.filter((app) => app.deployEnabled).length} deployable, ${registry.apps.filter((app) => app.routeEnabled).length} routed.`);
