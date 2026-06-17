import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageJsonPath = require.resolve('@spotify/basic-pitch/package.json');
const packageRoot = path.dirname(packageJsonPath);
const modelSource = path.join(packageRoot, 'model');
const modelDestination = path.resolve('public', 'basic-pitch-model');

await mkdir(path.dirname(modelDestination), { recursive: true });
await rm(modelDestination, { recursive: true, force: true });
await cp(modelSource, modelDestination, { recursive: true });

console.log(`Copied Basic Pitch model to ${modelDestination}`);
