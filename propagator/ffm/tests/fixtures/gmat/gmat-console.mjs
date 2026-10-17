// Running NASA GMAT's GmatConsole from a fixture generator: its startup file
// with every path absolute (optionally another EOP file), and one script run.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const gmatRootOf = (gmat) => path.resolve(path.dirname(gmat), '..');

// <work>/gmat_startup_file.txt: GMAT's own, every path absolute, output into
// <work>, the Python/MATLAB/OpenFrames plugins left out, and `eopFile` (if
// given) as the EOP file.
export function writeStartupFile(gmat, work, eopFile) {
  const gmatRoot = gmatRootOf(gmat);
  const startup = fs.readFileSync(path.join(gmatRoot, 'bin/gmat_startup_file.txt'), 'utf8').split('\n').map((line) => {
    if (/^PLUGIN\s/.test(line)) return /libPythonInterface|libMatlabInterface|libOpenFrames/.test(line) ? `# ${line}` : line.replace('../', `${gmatRoot}/`);
    if (/^ROOT_PATH\s/.test(line)) return `ROOT_PATH                = ${gmatRoot}/`;
    if (/^OUTPUT_PATH\s/.test(line)) return `OUTPUT_PATH              = ${path.resolve(work)}/`;
    if (eopFile && /^EOP_FILE\s/.test(line)) return `EOP_FILE                 = ${path.resolve(eopFile)}`;
    return line;
  }).join('\n');
  const file = path.join(work, 'gmat_startup_file.txt');
  fs.writeFileSync(file, startup);
  return file;
}

export const gmatVersion = (gmat) => execFileSync(gmat, ['--version'], { cwd: path.dirname(gmat), encoding: 'utf8' }).match(/Build Date:[^\n]*/)?.[0] ?? 'unknown';

// Runs one script; its log is <script>.log beside it.
export function runScript(gmat, startupFile, script) {
  execFileSync(gmat, ['--startup_file', startupFile, '--logfile', script.replace(/\.script$/, '.log'), '--verbose', 'off', '--run', script], { cwd: path.dirname(gmat), stdio: 'ignore' });
}
