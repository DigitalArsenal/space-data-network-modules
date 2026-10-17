import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Shared standard source location for the build, driver, and E2E.
export const STANDARD = '../hpop';
export const packageRoot = fileURLToPath(new URL('.', import.meta.url));
export const standardRoot = path.resolve(packageRoot, STANDARD);
