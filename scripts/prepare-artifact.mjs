import { cp, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const [sourceRootArg, outputArg, artifactArg] = process.argv.slice(2);
if (!sourceRootArg || !outputArg || !artifactArg) {
  console.error('Usage: node scripts/prepare-artifact.mjs <source-root> <output-path> <artifact-dir>');
  process.exit(2);
}

const sourceRoot = path.resolve(sourceRootArg);
const outputPath = path.resolve(sourceRoot, outputArg);
const artifactPath = path.resolve(artifactArg);

try {
  const info = await stat(outputPath);
  if (!info.isDirectory()) throw new Error('output is not a directory');
} catch (error) {
  console.error(`Build output does not exist or is not a directory: ${outputPath}`);
  process.exit(1);
}

await rm(artifactPath, { recursive: true, force: true });
await mkdir(artifactPath, { recursive: true });

const excluded = new Set([
  '.git',
  '.github',
  'node_modules',
  '.DS_Store',
  'CNAME',
  'AGENTS.md'
]);

await cp(outputPath, artifactPath, {
  recursive: true,
  filter(source) {
    const name = path.basename(source);
    return !excluded.has(name);
  }
});

console.log(`Prepared deployment artifact: ${artifactPath}`);
