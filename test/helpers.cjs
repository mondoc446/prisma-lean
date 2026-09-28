const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const tmpDir = path.join(__dirname, '.tmp');
const buildDir = path.join(tmpDir, 'build');
const prismaCli = path.join(root, 'node_modules', 'prisma', 'build', 'index.js');
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const exampleSchema = path.join(root, 'example', 'schema.prisma');

const prismaEnv = {
  ...process.env,
  CHECKPOINT_DISABLE: '1',
  PRISMA_HIDE_UPDATE_MESSAGE: '1',
  DATABASE_URL: process.env.DATABASE_URL || 'mysql://user:password@localhost:3306/prisma_lean',
};

/**
 * Runs `prisma generate` with the compiled generator on a copy of `schemaSource`.
 * Returns the output directory that holds index.js and index.d.ts.
 */
function generate(schemaSource = fs.readFileSync(exampleSchema, 'utf8')) {
  fs.mkdirSync(tmpDir, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tmpDir, 'gen-'));
  const outputDir = path.join(dir, 'client');
  const schema = schemaSource
    .replace(/provider\s*=\s*"node [^"]*"/, `provider = ${JSON.stringify(`node ${path.join(buildDir, 'bin.js')}`)}`)
    .replace(/output\s*=\s*"[^"]*"/, `output = ${JSON.stringify(outputDir)}`);
  const schemaPath = path.join(dir, 'schema.prisma');
  fs.writeFileSync(schemaPath, schema);

  execFileSync(process.execPath, [prismaCli, 'generate', '--schema', schemaPath], {
    cwd: root,
    env: prismaEnv,
    stdio: 'pipe',
  });
  return { dir, outputDir, schemaPath };
}

/** Type-checks `files` with strict settings. Throws with the compiler output on error. */
function typeCheck(files) {
  try {
    execFileSync(
      process.execPath,
      [
        tsc,
        '--noEmit',
        '--strict',
        '--target',
        'ES2022',
        '--module',
        'commonjs',
        '--moduleResolution',
        'node',
        '--esModuleInterop',
        '--skipLibCheck',
        ...files,
      ],
      { cwd: root, stdio: 'pipe' },
    );
  } catch (error) {
    throw new Error(`tsc failed:\n${error.stdout}${error.stderr}`);
  }
}

/**
 * Minimal stand-in for a mysql2 pool. Records every statement and answers
 * with the first handler whose pattern matches the SQL.
 */
function fakePool(handlers = []) {
  const calls = [];
  const execute = async (sql, params) => {
    calls.push({ sql, params });
    for (const [pattern, reply] of handlers) {
      if (pattern.test(sql)) return [typeof reply === 'function' ? reply(sql, params) : reply, []];
    }
    return [sql.startsWith('SELECT') ? [] : { insertId: 0, affectedRows: 1 }, []];
  };
  const connection = {
    execute,
    beginTransaction: async () => calls.push({ sql: 'BEGIN' }),
    commit: async () => calls.push({ sql: 'COMMIT' }),
    rollback: async () => calls.push({ sql: 'ROLLBACK' }),
    release: () => calls.push({ sql: 'RELEASE' }),
  };
  return {
    calls,
    execute,
    getConnection: async () => connection,
    end: async () => calls.push({ sql: 'END' }),
  };
}

module.exports = { root, buildDir, prismaCli, prismaEnv, exampleSchema, generate, typeCheck, fakePool };
