import { fileURLToPath } from 'node:url';
export const packageRoot = fileURLToPath(new URL('../', import.meta.url));
export const referenceRoot = fileURLToPath(new URL('../tests/reference/', import.meta.url));
