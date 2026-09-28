// Compiles src/ with tsc, then runs every test/*.test.cjs file with node:test.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const tmpDir = path.join(__dirname, '.tmp');
const buildDir = path.join(tmpDir, 'build');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    return false;
  }
  return true;
}

try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  const testFiles = fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith('.test.cjs'))
    .map((f) => path.join(__dirname, f));

  if (run(process.execPath, [tsc, '--project', path.join(root, 'tsconfig.json'), '--outDir', buildDir])) {
    run(process.execPath, ['--test', ...testFiles]);
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
