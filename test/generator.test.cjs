const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildDir, generate, typeCheck, fakePool } = require('./helpers.cjs');

const { generateClient } = require(path.join(buildDir, 'generator.js'));
const { mapPrismaTypeToTS } = require(path.join(buildDir, 'type-mapper.js'));
const { toAccessorName } = require(path.join(buildDir, 'metadata.js'));

const { outputDir } = generate();
const client = require(path.join(outputDir, 'index.js'));

function newClient(handlers) {
  const pool = fakePool(handlers);
  return { db: new client.LeanClient(pool), calls: pool.calls };
}

test('maps Prisma scalar types to TypeScript types', () => {
  assert.equal(mapPrismaTypeToTS('String'), 'string');
  assert.equal(mapPrismaTypeToTS('Int'), 'number');
  assert.equal(mapPrismaTypeToTS('Float'), 'number');
  assert.equal(mapPrismaTypeToTS('Decimal'), 'string');
  assert.equal(mapPrismaTypeToTS('Decimal', 'input'), 'string | number');
  assert.equal(mapPrismaTypeToTS('BigInt'), 'bigint');
  assert.equal(mapPrismaTypeToTS('Boolean'), 'boolean');
  assert.equal(mapPrismaTypeToTS('DateTime'), 'Date');
  assert.equal(mapPrismaTypeToTS('Json'), 'JsonValue');
  assert.equal(mapPrismaTypeToTS('Bytes'), 'Buffer');
  assert.equal(mapPrismaTypeToTS('UnsupportedType'), 'unknown');
});

test('uses camelCase model accessors', () => {
  assert.equal(toAccessorName('UserProfile'), 'userProfile');
  assert.equal(toAccessorName('User'), 'user');
});

test('requires an output directory', async () => {
  await assert.rejects(
    generateClient({
      generator: {},
      datasources: [{ activeProvider: 'mysql' }],
      dmmf: { datamodel: { models: [], enums: [] } },
    }),
    /No output path specified/,
  );
});

test('rejects datasource providers other than mysql', async () => {
  await assert.rejects(
    generateClient({
      generator: { output: { value: path.join(outputDir, 'unused') } },
      datasources: [{ activeProvider: 'postgresql' }],
      dmmf: { datamodel: { models: [], enums: [] } },
    }),
    /only supports the "mysql" datasource provider \(found "postgresql"\)/,
  );
});

test('emits index.js and index.d.ts, no index.ts', () => {
  assert.ok(fs.existsSync(path.join(outputDir, 'index.js')));
  assert.ok(fs.existsSync(path.join(outputDir, 'index.d.ts')));
  assert.ok(!fs.existsSync(path.join(outputDir, 'index.ts')));
});

test('generated types compile and match intended usage', () => {
  const usage = path.join(outputDir, 'usage.ts');
  fs.writeFileSync(
    usage,
    `
import { LeanClient, Role, User, Profile, Order, JsonValue } from './index';
async function main(db: LeanClient) {
  const user: User = await db.user.create({ data: { email: 'a@b.c' } });
  const role: Role = user.role;
  const same: User | null = await db.user.findUnique({ where: { email: 'a@b.c' } });
  await db.user.findUnique({ where: { id: 1 } });
  await db.membership.findUnique({ where: { groupId_userId: { groupId: 1, userId: 2 } } });
  await db.key.findUnique({ where: { name: 'k' } });
  const profile: Profile = await db.profile.create({ data: { userId: user.id, settings: { a: [1, 'x'] } } });
  const settings: JsonValue | null = profile.settings;
  const order: Order = await db.order.create({ data: { total: '10.50', userId: user.id } });
  const id: bigint = order.id;
  const total: string = order.total;
  const many: User[] = await db.user.findMany({ where: { role: Role.ADMIN, name: null }, orderBy: [{ createdAt: 'desc' }], take: 10 });
  const n: number = await db.user.count();
  await db.user.update({ where: { id: 1 }, data: { name: null } });
  await db.user.delete({ where: { id: 1 } });
  await db.$transaction(async (tx) => tx.user.create({ data: { email: 'x' } }));
  await db.$disconnect();
  // @ts-expect-error email is required
  await db.user.create({ data: {} });
  // @ts-expect-error Json fields are not filterable
  await db.profile.findMany({ where: { settings: {} } });
  return [role, same, settings, id, total, many, n];
}
new LeanClient('mysql://localhost/db');
new LeanClient({ host: 'localhost' });
export { main };
`,
  );
  typeCheck([usage]);
});

test('findUnique returns null (not undefined) when no row matches', async () => {
  const { db, calls } = newClient();
  assert.equal(await db.user.findUnique({ where: { id: 1 } }), null);
  assert.equal(
    calls[0].sql,
    'SELECT `id`, `email`, `name`, `role`, `isActive`, `created_at`, `updated_at` FROM `users` WHERE `id` = ? LIMIT 1'.replace(
      '`isActive`',
      '`is_active`',
    ),
  );
  assert.deepEqual(calls[0].params, [1]);
});

test('findUnique supports @unique fields and compound ids', async () => {
  const { db, calls } = newClient();
  await db.user.findUnique({ where: { email: 'a@b.c' } });
  await db.membership.findUnique({ where: { groupId_userId: { groupId: 1, userId: 2 } } });
  await db.key.findUnique({ where: { name: 'k' } });
  assert.match(calls[0].sql, /FROM `users` WHERE `email` = \? LIMIT 1$/);
  assert.match(calls[1].sql, /FROM `Membership` WHERE `groupId` = \? AND `userId` = \? LIMIT 1$/);
  assert.deepEqual(calls[1].params, [1, 2]);
  assert.match(calls[2].sql, /FROM `Key` WHERE `name` = \? LIMIT 1$/);
  await assert.rejects(db.user.findUnique({ where: { name: 'x' } }), /must contain one of id, email/);
});

test('maps rows: @map columns, TINYINT booleans, enums, BigInt, Decimal, Json', async () => {
  const { db } = newClient([
    [
      /FROM `users`/,
      [
        {
          id: 1,
          email: 'a',
          name: null,
          role: 'admin',
          is_active: 0,
          created_at: new Date(0),
          updated_at: new Date(0),
        },
      ],
    ],
    [/FROM `Order`/, [{ id: '9007199254740993', ref: 'c1', total: '10.50', userId: 1 }]],
    [/FROM `Profile`/, [{ id: 'p', bio: null, settings: '{"theme":"dark"}', avatar: null, user_id: 1 }]],
  ]);
  const user = await db.user.findUnique({ where: { id: 1 } });
  assert.deepEqual(user, {
    id: 1,
    email: 'a',
    name: null,
    role: 'ADMIN',
    isActive: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
  const order = await db.order.findUnique({ where: { id: 9007199254740993n } });
  assert.equal(order.id, 9007199254740993n);
  assert.equal(order.total, '10.50');
  const profile = await db.profile.findUnique({ where: { id: 'p' } });
  assert.deepEqual(profile.settings, { theme: 'dark' });
  assert.equal(profile.userId, 1);
});

test('create inserts caller values for defaulted fields and applies client defaults', async () => {
  const { db, calls } = newClient([
    [/^INSERT/, { insertId: 7 }],
    [
      /FROM `users`/,
      (sql, params) => [
        {
          id: params[0],
          email: 'a@b.c',
          name: null,
          role: 'admin',
          is_active: 1,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
    ],
  ]);
  const user = await db.user.create({ data: { email: 'a@b.c', role: 'ADMIN' } });
  const insert = calls[0];
  assert.match(
    insert.sql,
    /^INSERT INTO `users` \(`email`, `role`, `is_active`, `created_at`, `updated_at`\) VALUES \(\?, \?, \?, \?, \?\)$/,
  );
  assert.equal(insert.params[0], 'a@b.c');
  assert.equal(insert.params[1], 'admin', 'enum written with its @map value');
  assert.equal(insert.params[2], true, 'literal @default applied');
  assert.ok(insert.params[3] instanceof Date, 'now() applied');
  assert.ok(insert.params[4] instanceof Date, '@updatedAt applied');
  assert.deepEqual(calls[1].params, [7], 're-read by insertId');
  assert.equal(user.id, 7);
  assert.equal(user.role, 'ADMIN');
});

test('create generates uuid() and cuid() ids in the client', async () => {
  const { db, calls } = newClient([[/^INSERT INTO `Order`/, { insertId: '9007199254740993' }]]);
  const profile = await db.profile.create({ data: { userId: 1, settings: { a: 1 } } });
  assert.equal(calls[0].sql, 'INSERT INTO `Profile` (`id`, `settings`, `user_id`) VALUES (?, ?, ?)');
  const [idParam, settingsParam] = calls[0].params;
  assert.match(idParam, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'uuid v4 generated');
  assert.equal(settingsParam, '{"a":1}', 'Json serialized');
  assert.match(calls[1].sql, /FROM `Profile` WHERE `id` = \?/);
  assert.equal(profile.id, idParam, 'falls back to written data when the re-read finds nothing');

  await db.order.create({ data: { total: 10.5, userId: 1 } });
  const orderInsert = calls[2];
  assert.match(orderInsert.params[0], /^c[0-9a-z]{24}$/, 'cuid generated');
  assert.equal(orderInsert.params[1], '10.5');
  assert.deepEqual(calls[3].params, ['9007199254740993'], 'BigInt insertId keeps precision');
});

test('create rejects unknown fields and missing required fields', async () => {
  const { db } = newClient();
  await assert.rejects(db.user.create({ data: { email: 'a', emial: 'b' } }), /Unknown field "emial" on model User/);
  await assert.rejects(db.user.create({ data: {} }), /"email" is required/);
  await assert.rejects(db.user.create({ data: { email: 'a', role: 'OWNER' } }), /Invalid value "OWNER" for enum Role/);
});

test('findMany and count build filters, ordering and paging', async () => {
  const { db, calls } = newClient([[/COUNT/, [{ count: 3 }]]]);
  await db.user.findMany({
    where: { role: 'ADMIN', name: null },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: 5,
    skip: 10,
  });
  assert.match(
    calls[0].sql,
    / WHERE `role` = \? AND `name` IS NULL ORDER BY `created_at` DESC, `id` ASC LIMIT 5 OFFSET 10$/,
  );
  assert.deepEqual(calls[0].params, ['admin']);
  assert.equal(await db.user.count({ where: { isActive: true } }), 3);
  assert.equal(calls[1].sql, 'SELECT COUNT(*) AS count FROM `users` WHERE `is_active` = ?');
  await assert.rejects(db.user.findMany({ take: -1 }), /"take" must be a non-negative integer/);
  await assert.rejects(db.user.findMany({ orderBy: { id: 'up' } }), /Invalid sort order/);
});

test('update sets @updatedAt and re-reads with changed key values', async () => {
  const { db, calls } = newClient([
    [
      /FROM `users`/,
      [
        {
          id: 1,
          email: 'new@b.c',
          name: 'N',
          role: 'USER',
          is_active: 1,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
    ],
  ]);
  const user = await db.user.update({ where: { email: 'old@b.c' }, data: { email: 'new@b.c', name: 'N' } });
  assert.match(calls[0].sql, /^UPDATE `users` SET `email` = \?, `name` = \?, `updated_at` = \? WHERE `email` = \?$/);
  assert.equal(calls[0].params[3], 'old@b.c');
  assert.deepEqual(calls[1].params, ['new@b.c']);
  assert.equal(user.name, 'N');
});

test('update and delete throw P2025 when the record does not exist', async () => {
  const { db } = newClient();
  await assert.rejects(db.user.update({ where: { id: 1 }, data: { name: 'x' } }), (e) => e.code === 'P2025');
  await assert.rejects(db.user.delete({ where: { id: 1 } }), (e) => e.code === 'P2025');
});

test('delete returns the deleted row', async () => {
  const { db, calls } = newClient([[/FROM `Key`/, [{ name: 'k', value: 'v' }]]]);
  assert.deepEqual(await db.key.delete({ where: { name: 'k' } }), { name: 'k', value: 'v' });
  assert.equal(calls[1].sql, 'DELETE FROM `Key` WHERE `name` = ?');
});

test('$transaction commits on success and rolls back on error', async () => {
  const { db, calls } = newClient();
  await db.$transaction(async (tx) => tx.key.findMany());
  assert.deepEqual(
    calls.map((c) => c.sql.split(' ')[0]),
    ['BEGIN', 'SELECT', 'COMMIT', 'RELEASE'],
  );

  calls.length = 0;
  await assert.rejects(
    db.$transaction(async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.deepEqual(
    calls.map((c) => c.sql),
    ['BEGIN', 'ROLLBACK', 'RELEASE'],
  );
});

test('$disconnect ends the pool', async () => {
  const { db, calls } = newClient();
  await db.$disconnect();
  assert.deepEqual(
    calls.map((c) => c.sql),
    ['END'],
  );
});

test('exports enum objects and default pool options', () => {
  assert.deepEqual(client.Role, { USER: 'USER', ADMIN: 'ADMIN' });
  assert.equal(client.defaultPoolOptions.bigNumberStrings, true);
  assert.equal(client.defaultPoolOptions.timezone, 'Z');
});
