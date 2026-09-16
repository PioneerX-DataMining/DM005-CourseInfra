import { appendFile, readFile } from 'node:fs/promises';

const appId = process.argv[2];
if (!appId) {
  console.error('Usage: node scripts/get-app-config.mjs <APP_ID>');
  process.exit(2);
}

const registry = JSON.parse(await readFile(new URL('../config/apps.json', import.meta.url), 'utf8'));
const app = registry.apps.find((item) => item.id.toUpperCase() === appId.toUpperCase());

if (!app) {
  console.error(`Unknown app id: ${appId}`);
  process.exit(1);
}

if (!app.deployEnabled) {
  console.error(`${app.id} is registered but deployEnabled=false`);
  process.exit(1);
}

const outputs = {
  id: app.id,
  repo: app.repo,
  branch: app.branch,
  project: app.edgeoneProject,
  install: app.build?.install ?? '',
  build: app.build?.command ?? '',
  output: app.build?.output ?? '.',
  mount: app.mount,
  private_repo: String(Boolean(app.privateRepo))
};

for (const [key, value] of Object.entries(outputs)) {
  if (String(value).includes('\n')) throw new Error(`${key} must not contain newlines`);
}

if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
} else {
  console.log(JSON.stringify(outputs, null, 2));
}
