// Runs the generated client against a real MySQL database.
// Skipped unless DATABASE_URL is set. WARNING: the database is reset.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { generate, prismaCli, prismaEnv, root } = require('./helpers.cjs');

const url = process.env.DATABASE_URL;

test('generated client against MySQL', { skip: !url && 'DATABASE_URL not set' }, async (t) => {
  const { outputDir, schemaPath } = generate();
  execFileSync(
    process.execPath,
    [prismaCli, 'db', 'push', '--force-reset', '--skip-generate', '--accept-data-loss', '--schema', schemaPath],
    {
      cwd: root,
      env: prismaEnv,
      stdio: 'pipe',
    },
  );

  const { LeanClient, Role } = require(path.join(outputDir, 'index.js'));
  const db = new LeanClient(url);
  t.after(() => db.$disconnect());

  await t.test('create and findUnique round-trip types', async () => {
    const user = await db.user.create({ data: { email: 'ada@example.com', name: 'Ada', role: Role.ADMIN } });
    assert.equal(typeof user.id, 'number');
    assert.equal(user.role, 'ADMIN', 'caller value for a defaulted field is kept');
    assert.equal(user.isActive, true, 'TINYINT(1) is mapped to boolean');
    assert.ok(user.createdAt instanceof Date);
    assert.deepEqual(await db.user.findUnique({ where: { email: 'ada@example.com' } }), user);
    assert.equal(await db.user.findUnique({ where: { id: 999999 } }), null);
  });

  await t.test('uuid ids, Json and Bytes', async () => {
    const user = await db.user.findUnique({ where: { email: 'ada@example.com' } });
    const profile = await db.profile.create({
      data: { userId: user.id, settings: { theme: 'dark', n: [1, 2] }, avatar: Buffer.from([1, 2, 3]) },
    });
    assert.match(profile.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(profile.settings, { theme: 'dark', n: [1, 2] });
    assert.deepEqual([...profile.avatar], [1, 2, 3]);
  });

  await t.test('BigInt ids, cuid defaults and Decimal precision', async () => {
    const user = await db.user.findUnique({ where: { email: 'ada@example.com' } });
    const order = await db.order.create({ data: { userId: user.id, total: '12345678.91' } });
    assert.equal(typeof order.id, 'bigint');
    assert.match(order.ref, /^c[0-9a-z]{24}$/);
    assert.equal(order.total, '12345678.91');
  });

  await t.test('compound ids and reserved-word tables', async () => {
    await db.membership.create({ data: { groupId: 1, userId: 2, role: 'USER' } });
    const m = await db.membership.findUnique({ where: { groupId_userId: { groupId: 1, userId: 2 } } });
    assert.equal(m.role, 'USER');
    await db.key.create({ data: { name: 'k', value: 'v' } });
    assert.equal((await db.key.update({ where: { name: 'k' }, data: { value: 'w' } })).value, 'w');
    assert.deepEqual(await db.key.delete({ where: { name: 'k' } }), { name: 'k', value: 'w' });
    assert.equal(await db.key.count(), 0);
  });

  await t.test('findMany and transactions', async () => {
    await db.user.create({ data: { email: 'bob@example.com' } });
    const users = await db.user.findMany({ orderBy: { email: 'desc' }, take: 1 });
    assert.deepEqual(
      users.map((u) => u.email),
      ['bob@example.com'],
    );

    await assert.rejects(
      db.$transaction(async (tx) => {
        await tx.user.create({ data: { email: 'rolled-back@example.com' } });
        throw new Error('abort');
      }),
      /abort/,
    );
    assert.equal(await db.user.findUnique({ where: { email: 'rolled-back@example.com' } }), null);
  });
});
