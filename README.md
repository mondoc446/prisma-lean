# prisma-lean

A tiny [Prisma](https://www.prisma.io/) generator that turns your `schema.prisma` into a small, typed client for **MySQL**, built directly on [`mysql2`](https://github.com/sidorares/node-mysql2).

No query engine binary and no runtime schema parsing. The generator writes one `index.js` and one `index.d.ts` with plain parameterized SQL.

> **Status:** v1.1.0. The client covers single-table CRUD: `findUnique`, `findMany`, `count`, `create`, `update`, `delete` and `$transaction`. See [Limitations](#limitations) for what it does not do.

## Why

The official Prisma Client is powerful, but it ships a query engine and a large runtime. Small services, scripts and serverless functions often need only typed single-table reads and writes. `prisma-lean` keeps your Prisma schema as the source of truth and generates the minimum code for those operations.

## Features

- A TypeScript interface for every model, plus `CreateInput`, `UpdateInput`, `WhereInput`, `WhereUniqueInput` and `OrderByInput` types.
- String-literal union types and frozen value objects for every enum.
- `@map` and `@@map` support. Table and column names are quoted with backticks, so reserved words such as `Order` or `Key` work.
- Unique lookups by `@id`, `@unique`, compound `@@id([a, b])` and `@@unique([a, b])`.
- Client-side defaults, applied in `create`: `uuid()`, `uuid(7)`, `cuid()`, `cuid(2)`, `nanoid()`, `now()`, `@updatedAt`, and literal defaults such as `@default(USER)` or `@default(true)`.
- Values you pass for fields with a default are always written.
- Row mapping that returns the declared types: `TINYINT(1)` becomes `boolean`, `BIGINT` becomes `bigint`, `DECIMAL` stays a precise `string`, `Json` is parsed, and enum `@map` values are translated both ways.
- A `LeanClient` that accepts a connection string, `mysql2` pool options, or an existing pool, and a `$disconnect()` method.
- A generator error when the datasource provider is not `mysql`.

## Requirements

- Node.js 18 or later
- Prisma 5.x
- MySQL 5.7+ or 8.x (MariaDB and other MySQL-compatible databases should work but are not tested in CI)
- `mysql2` 3.x installed in the project that uses the generated client

## Installation

`prisma-lean` is not published to npm yet. Build it from source:

```sh
git clone <this-repo-url> prisma-lean
cd prisma-lean
npm install
npm run build
```

Then, in your application:

```sh
npm install mysql2
npm install --save-dev prisma
```

## Usage

Add the generator to your `schema.prisma`. Point `provider` at the built binary:

```prisma
datasource db {
  provider = "mysql"
  url      = env("DATABASE_URL")
}

generator lean {
  provider = "node ../prisma-lean/dist/bin.js"
  output   = "../generated/lean-client"
}

enum Role {
  USER
  ADMIN
}

model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  name      String?
  role      Role     @default(USER)
  createdAt DateTime @default(now()) @map("created_at")

  @@map("users")
}
```

Generate the client:

```sh
npx prisma generate
```

Use it:

```ts
import { LeanClient, Role } from './generated/lean-client';

const db = new LeanClient(process.env.DATABASE_URL!);

const user = await db.user.create({
  data: { email: 'ada@example.com', name: 'Ada', role: Role.ADMIN },
});

const found = await db.user.findUnique({ where: { email: 'ada@example.com' } }); // User | null

const admins = await db.user.findMany({
  where: { role: Role.ADMIN, name: null },
  orderBy: { createdAt: 'desc' },
  take: 10,
  skip: 0,
});

const total = await db.user.count({ where: { role: Role.USER } });

await db.user.update({ where: { id: user.id }, data: { name: 'Ada Lovelace' } });
await db.user.delete({ where: { id: user.id } });

await db.$transaction(async (tx) => {
  const a = await tx.user.create({ data: { email: 'a@example.com' } });
  await tx.user.update({ where: { id: a.id }, data: { role: Role.ADMIN } });
});

await db.$disconnect();
```

A complete schema that uses every supported feature is in [`example/schema.prisma`](example/schema.prisma).

### Operations

| Method                                         | Returns         | Notes                                                                    |
| ---------------------------------------------- | --------------- | ------------------------------------------------------------------------ |
| `findUnique({ where })`                        | `Model \| null` | `where` is one unique key: `{ id }`, `{ email }`, or `{ a_b: { a, b } }` |
| `findMany({ where?, orderBy?, take?, skip? })` | `Model[]`       | `where` is field equality, joined with `AND`. `null` means `IS NULL`.    |
| `count({ where? })`                            | `number`        |                                                                          |
| `create({ data })`                             | `Model`         | Re-reads the row by its ID or another unique key.                        |
| `update({ where, data })`                      | `Model`         | Sets `@updatedAt` fields. Throws when no row matches.                    |
| `delete({ where })`                            | `Model`         | Returns the deleted row. Throws when no row matches.                     |
| `$transaction(fn)`                             | result of `fn`  | Commits when `fn` resolves. Rolls back when `fn` throws.                 |
| `$disconnect()`                                | `void`          | Closes the pool.                                                         |

`findUnique`, `update` and `delete` exist only on models that have at least one unique key. Prisma requires one on every model, so in practice this is every model.

When `update` or `delete` finds no row, the error has `code: 'P2025'`, the same code Prisma Client uses.

Model accessors use camelCase: `User` becomes `db.user`, `UserProfile` becomes `db.userProfile`.

### Connecting

```ts
new LeanClient('mysql://user:password@localhost:3306/app'); // connection string
new LeanClient({ host: 'localhost', user: 'app', database: 'app', connectionLimit: 5 }); // mysql2 PoolOptions
new LeanClient(existingPool); // a mysql2/promise Pool
```

When `LeanClient` creates the pool, it applies `defaultPoolOptions`:

```ts
{ supportBigNumbers: true, bigNumberStrings: true, jsonStrings: true, timezone: 'Z' }
```

These options keep `BIGINT` and `DECIMAL` values exact, let the client parse `Json` itself, and read and write `DateTime` values in UTC, like Prisma does. If you pass your own pool, create it with the same options:

```ts
import * as mysql from 'mysql2/promise';
import { LeanClient, defaultPoolOptions } from './generated/lean-client';

const db = new LeanClient(mysql.createPool({ ...defaultPoolOptions, uri: process.env.DATABASE_URL }));
```

`$disconnect()` ends the pool, also a pool you passed in.

## Type mapping

| Prisma     | Returned type | Accepted input     | Notes                              |
| ---------- | ------------- | ------------------ | ---------------------------------- |
| `String`   | `string`      | `string`           |                                    |
| `Int`      | `number`      | `number`           |                                    |
| `Float`    | `number`      | `number`           |                                    |
| `Decimal`  | `string`      | `string \| number` | A string keeps the full precision. |
| `BigInt`   | `bigint`      | `bigint \| number` |                                    |
| `Boolean`  | `boolean`     | `boolean`          | Converted from `TINYINT(1)`.       |
| `DateTime` | `Date`        | `Date`             | UTC.                               |
| `Json`     | `JsonValue`   | `JsonValue`        | `null` is stored as SQL `NULL`.    |
| `Bytes`    | `Buffer`      | `Uint8Array`       |                                    |
| enum       | union type    | union type         | `@map` values are translated.      |

Nullable fields are typed as `field: T | null` in models. Relation fields and `Unsupported(...)` fields are not part of the generated types.

## Limitations

prisma-lean is a single-table client on purpose. It does not implement these Prisma Client features:

- **MySQL only.** Other providers are rejected at generate time.
- **No relations.** There is no `include`, `select`, nested read or nested write. Relation scalar fields (for example `userId`) are regular fields, so you can set and filter them.
- **Equality filters only.** `where` in `findMany` and `count` supports `field: value` and `field: null`. There are no operators such as `gt`, `contains`, `in`, `OR` or `NOT`, and `Json` fields cannot be filtered.
- **No bulk or upsert operations:** no `createMany`, `updateMany`, `deleteMany` or `upsert`.
- **No raw queries.** Use `mysql2` directly for those.
- **`cuid(2)` ids are random**, not the hashed values of the reference `@paralleldrive/cuid2` library. They have the same shape (24 lowercase base36 characters).
- **`create` without a readable key.** When a created row has no auto-increment ID and no unique key value in the written data (for example an ID from `dbgenerated()`), `create` returns the values it wrote instead of re-reading the row.
- **Pools you create yourself** must use `defaultPoolOptions` to get exact `BIGINT` / `DECIMAL` values and UTC dates.
- **CommonJS output.** The generated `index.js` is CommonJS. ESM projects can import it through Node's CommonJS interop.
- **Prisma 5 only.** Other Prisma majors are not tested.

## Development

```sh
npm install
npm run build          # bundle src/ to dist/bin.js with tsup
npm run dev            # rebuild on change
npm test               # type-check and run the test suite
npm run typecheck      # tsc --noEmit
npm run format         # prettier --write .
npm run example:generate   # generate a client from example/schema.prisma
```

`npm test` does not need a database. It runs `prisma generate` on the example schema and checks the generated SQL, row mapping and types against a fake pool. To also run the integration tests, set `DATABASE_URL` to an empty MySQL database. **The integration tests reset that database.**

```sh
DATABASE_URL=mysql://root:root@127.0.0.1:3306/prisma_lean npm test
```

CI (`.github/workflows/ci.yml`) runs the full suite, including the integration tests, against a `mysql:8` service on Node 18, 20 and 22.

Project layout:

```
src/
  bin.ts          # Prisma generator entry point (manifest + onGenerate)
  generator.ts    # provider check, writes index.js and index.d.ts
  metadata.ts     # DMMF -> model metadata (columns, defaults, unique keys, enums)
  type-mapper.ts  # Prisma -> TypeScript types, index.d.ts
  runtime.ts      # runtime code embedded in index.js (SQL building, row mapping)
example/
  schema.prisma   # example schema, also used by the tests
test/
  run.cjs         # compiles src/ and runs the tests
  generator.test.cjs
  integration.test.cjs
```

## Contributing

Issues and pull requests are welcome. Please keep the generated client small and free of dependencies other than `mysql2`. Run `npm test` and `npm run format:check` before you open a pull request.

## License

[MIT](LICENSE)
