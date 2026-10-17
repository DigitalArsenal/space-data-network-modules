#!/usr/bin/env node
// Keep the standard module's SDK, exception, and lifetime handling authoritative.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { standardRoot } from './standard.mjs';

// C7 applies to every compile and final link; the standard driver owns the rest.
process.argv.push('-msimd128');
await import(pathToFileURL(path.join(standardRoot, 'build-driver.mjs')).href);
