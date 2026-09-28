/**
 * JavaScript runtime copied into every generated `index.js`.
 *
 * It is driven by the `models` metadata table that the generator emits in
 * front of it, so the per-model code stays data, not generated logic.
 *
 * This is a plain string: do not use backticks or `${` inside it.
 */
export const RUNTIME_SOURCE = String.raw`
const BACKTICK = String.fromCharCode(96);

const defaultPoolOptions = {
  supportBigNumbers: true,
  bigNumberStrings: true,
  jsonStrings: true,
  timezone: 'Z',
};

function quote(identifier) {
  return BACKTICK + String(identifier).split(BACKTICK).join(BACKTICK + BACKTICK) + BACKTICK;
}

function fieldMap(model) {
  if (!model._fieldMap) model._fieldMap = new Map(model.fields.map((f) => [f.name, f]));
  return model._fieldMap;
}

function getField(model, name) {
  const field = fieldMap(model).get(name);
  if (!field) throw new Error('Unknown field "' + name + '" on model ' + model.name);
  return field;
}

// ---------------------------------------------------------------------------
// Client-side defaults
// ---------------------------------------------------------------------------

let cuidCounter = crypto.randomInt(0, 1679616);
const cuidFingerprint = (process.pid.toString(36) + require('node:os').hostname().length.toString(36))
  .padStart(4, '0')
  .slice(-4);

function cuid() {
  const timestamp = Date.now().toString(36).padStart(8, '0').slice(-8);
  cuidCounter = (cuidCounter + 1) % 1679616;
  const counter = cuidCounter.toString(36).padStart(4, '0');
  const random =
    crypto.randomInt(0, 1679616).toString(36).padStart(4, '0') +
    crypto.randomInt(0, 1679616).toString(36).padStart(4, '0');
  return 'c' + timestamp + counter + cuidFingerprint + random;
}

/** cuid2-shaped id: a letter followed by 23 random base36 characters. */
function cuid2() {
  let id = String.fromCharCode(97 + crypto.randomInt(0, 26));
  while (id.length < 24) id += crypto.randomInt(0, 36).toString(36);
  return id;
}

const NANOID_ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict';

function nanoid(length) {
  const bytes = crypto.randomBytes(length);
  let id = '';
  for (let i = 0; i < length; i++) id += NANOID_ALPHABET[bytes[i] & 63];
  return id;
}

function uuidv7() {
  const bytes = crypto.randomBytes(16);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

function literalValue(field, value) {
  switch (field.type) {
    case 'DateTime':
      return new Date(value);
    case 'BigInt':
      return BigInt(value);
    case 'Json':
      return typeof value === 'string' ? JSON.parse(value) : value;
    case 'Bytes':
      return Buffer.from(String(value), 'base64');
    default:
      return value;
  }
}

function defaultValue(field) {
  const def = field.default;
  switch (def.kind) {
    case 'uuid':
      return def.version === 7 ? uuidv7() : crypto.randomUUID();
    case 'cuid':
      return def.version === 2 ? cuid2() : cuid();
    case 'nanoid':
      return nanoid(def.length);
    case 'now':
      return new Date();
    case 'literal':
      return literalValue(field, def.value);
  }
  throw new Error('Unknown default kind ' + def.kind);
}

// ---------------------------------------------------------------------------
// Value conversion
// ---------------------------------------------------------------------------

function toDb(field, value) {
  if (value === null || value === undefined) return null;
  if (field.kind === 'enum') {
    const dbValue = Object.prototype.hasOwnProperty.call(field.enumValues, value) ? field.enumValues[value] : undefined;
    if (dbValue === undefined) throw new Error('Invalid value ' + JSON.stringify(value) + ' for enum ' + field.type);
    return dbValue;
  }
  switch (field.type) {
    case 'Json':
      return JSON.stringify(value);
    case 'BigInt':
    case 'Decimal':
      return String(value);
    case 'Bytes':
      return Buffer.isBuffer(value) ? value : Buffer.from(value);
    default:
      return value;
  }
}

function fromDb(field, value) {
  if (value === null || value === undefined) return null;
  if (field.kind === 'enum') {
    if (!field._reverse) field._reverse = new Map(Object.entries(field.enumValues).map(([k, v]) => [v, k]));
    return field._reverse.has(value) ? field._reverse.get(value) : value;
  }
  switch (field.type) {
    case 'Boolean':
      return value === true || value === 1 || value === '1' || (Buffer.isBuffer(value) && value[0] === 1);
    case 'Int':
    case 'Float':
      return Number(value);
    case 'BigInt':
      return BigInt(value);
    case 'Decimal':
      return String(value);
    case 'Json':
      return typeof value === 'string' ? JSON.parse(value) : value;
    case 'DateTime':
      return value instanceof Date ? value : new Date(value);
    default:
      return value;
  }
}

function fromRow(model, row) {
  const result = {};
  for (const field of model.fields) result[field.name] = fromDb(field, row[field.column]);
  return result;
}

// ---------------------------------------------------------------------------
// SQL building
// ---------------------------------------------------------------------------

function columnList(model) {
  return model.fields.map((f) => quote(f.column)).join(', ');
}

function buildWhere(model, where) {
  const clauses = [];
  const params = [];
  for (const [name, value] of Object.entries(where || {})) {
    if (value === undefined) continue;
    const field = getField(model, name);
    if (field.type === 'Json') throw new Error('Filtering on Json field ' + model.name + '.' + name + ' is not supported');
    if (value === null) {
      clauses.push(quote(field.column) + ' IS NULL');
    } else {
      clauses.push(quote(field.column) + ' = ?');
      params.push(toDb(field, value));
    }
  }
  return { sql: clauses.length ? ' WHERE ' + clauses.join(' AND ') : '', params };
}

/** Flattens a unique where ({ id } or { a_b: { a, b } }) into plain field equality. */
function uniqueWhere(model, where) {
  if (!where || typeof where !== 'object') throw new Error(model.name + ': "where" is required');
  for (const key of model.uniqueKeys) {
    const value = where[key.name];
    if (value === undefined || value === null) continue;
    if (key.fields.length === 1 && key.fields[0] === key.name) return { [key.name]: value };
    const flat = {};
    for (const fieldName of key.fields) {
      if (value[fieldName] === undefined || value[fieldName] === null) {
        throw new Error(model.name + ': "' + key.name + '.' + fieldName + '" is required');
      }
      flat[fieldName] = value[fieldName];
    }
    return flat;
  }
  throw new Error(
    model.name + ': "where" must contain one of ' + model.uniqueKeys.map((k) => k.name).join(', '),
  );
}

function buildOrderBy(model, orderBy) {
  if (!orderBy) return '';
  const parts = [];
  for (const entry of Array.isArray(orderBy) ? orderBy : [orderBy]) {
    for (const [name, direction] of Object.entries(entry)) {
      if (direction !== 'asc' && direction !== 'desc') {
        throw new Error('Invalid sort order ' + JSON.stringify(direction) + ' for ' + model.name + '.' + name);
      }
      parts.push(quote(getField(model, name).column) + ' ' + direction.toUpperCase());
    }
  }
  return parts.length ? ' ORDER BY ' + parts.join(', ') : '';
}

function checkCount(name, value) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) throw new Error('"' + name + '" must be a non-negative integer');
  return value;
}

function buildLimit(take, skip) {
  take = checkCount('take', take);
  skip = checkCount('skip', skip);
  // Inlined (validated integers): MySQL prepared statements reject placeholders in LIMIT on some versions.
  if (take === undefined && skip === undefined) return '';
  if (take === undefined) return ' LIMIT 18446744073709551615 OFFSET ' + skip;
  return ' LIMIT ' + take + (skip ? ' OFFSET ' + skip : '');
}

/** Column/value pairs for the defined keys of data, in model field order. */
function assignments(model, data) {
  for (const name of Object.keys(data)) getField(model, name);
  const columns = [];
  const params = [];
  for (const field of model.fields) {
    const value = data[field.name];
    if (value === undefined) continue;
    const name = field.name;
    if (field.isRequired && value === null) throw new Error(model.name + '.' + name + ' cannot be null');
    columns.push(quote(field.column));
    params.push(toDb(field, value));
  }
  return { columns, params };
}

// ---------------------------------------------------------------------------
// Delegates
// ---------------------------------------------------------------------------

async function query(executor, sql, params) {
  const [rows] = await executor.execute(sql, params);
  return rows;
}

function notFound(model) {
  const error = new Error('No ' + model.name + ' record found');
  error.code = 'P2025';
  return error;
}

function createDelegate(model, executor) {
  const table = quote(model.table);
  const select = 'SELECT ' + columnList(model) + ' FROM ' + table;
  const hasUniqueKey = model.uniqueKeys.length > 0;

  async function findWhere(where) {
    const w = buildWhere(model, where);
    const rows = await query(executor, select + w.sql + ' LIMIT 1', w.params);
    return rows.length ? fromRow(model, rows[0]) : null;
  }

  /** Finds a unique key that is fully present in data, to re-read a written row. */
  function lookupFrom(data) {
    for (const key of model.uniqueKeys) {
      if (key.fields.every((n) => data[n] !== undefined && data[n] !== null)) {
        return Object.fromEntries(key.fields.map((n) => [n, data[n]]));
      }
    }
    return null;
  }

  const delegate = {
    async findMany(args) {
      args = args || {};
      const w = buildWhere(model, args.where);
      const sql = select + w.sql + buildOrderBy(model, args.orderBy) + buildLimit(args.take, args.skip);
      const rows = await query(executor, sql, w.params);
      return rows.map((row) => fromRow(model, row));
    },

    async count(args) {
      const w = buildWhere(model, (args || {}).where);
      const rows = await query(executor, 'SELECT COUNT(*) AS count FROM ' + table + w.sql, w.params);
      return Number(rows[0].count);
    },

    async create(args) {
      if (!args || !args.data) throw new Error(model.name + '.create: "data" is required');
      const data = { ...args.data };
      for (const name of Object.keys(data)) getField(model, name);
      for (const field of model.fields) {
        if (data[field.name] !== undefined) continue;
        if (field.default) data[field.name] = defaultValue(field);
        else if (field.isUpdatedAt) data[field.name] = new Date();
        else if (field.isRequired && !field.isDbGenerated) {
          throw new Error(model.name + '.create: "' + field.name + '" is required');
        }
      }

      const a = assignments(model, data);
      const sql = a.columns.length
        ? 'INSERT INTO ' + table + ' (' + a.columns.join(', ') + ') VALUES (' + a.columns.map(() => '?').join(', ') + ')'
        : 'INSERT INTO ' + table + ' () VALUES ()';
      const [result] = await executor.execute(sql, a.params);

      const autoField = model.fields.find((f) => f.isAutoIncrement);
      if (autoField && data[autoField.name] === undefined && result.insertId !== undefined) {
        data[autoField.name] = autoField.type === 'BigInt' ? BigInt(result.insertId) : Number(result.insertId);
      }

      const lookup = lookupFrom(data);
      if (lookup) {
        const created = await findWhere(lookup);
        if (created) return created;
      }
      // No unique key to re-read the row: return what was written.
      const row = {};
      for (const field of model.fields) row[field.name] = data[field.name] === undefined ? null : data[field.name];
      return row;
    },
  };

  if (hasUniqueKey) {
    delegate.findUnique = async (args) => findWhere(uniqueWhere(model, (args || {}).where));

    delegate.update = async (args) => {
      if (!args || !args.data) throw new Error(model.name + '.update: "data" is required');
      const where = uniqueWhere(model, args.where);
      const data = { ...args.data };
      for (const field of model.fields) {
        if (field.isUpdatedAt && data[field.name] === undefined) data[field.name] = new Date();
      }
      const a = assignments(model, data);
      if (a.columns.length) {
        const w = buildWhere(model, where);
        const sql = 'UPDATE ' + table + ' SET ' + a.columns.map((c) => c + ' = ?').join(', ') + w.sql;
        await executor.execute(sql, a.params.concat(w.params));
      }
      // Re-read with new values for any key field the update changed.
      const lookup = { ...where };
      for (const name of Object.keys(lookup)) if (data[name] !== undefined) lookup[name] = data[name];
      const updated = await findWhere(lookup);
      if (!updated) throw notFound(model);
      return updated;
    };

    delegate.delete = async (args) => {
      const where = uniqueWhere(model, (args || {}).where);
      const existing = await findWhere(where);
      if (!existing) throw notFound(model);
      const w = buildWhere(model, where);
      await executor.execute('DELETE FROM ' + table + w.sql, w.params);
      return existing;
    };
  }

  return delegate;
}

function attachDelegates(target, executor) {
  for (const model of models) {
    Object.defineProperty(target, model.accessor, {
      value: createDelegate(model, executor),
      enumerable: true,
    });
  }
}

function isPool(value) {
  return value && typeof value === 'object' && typeof value.getConnection === 'function' && typeof value.execute === 'function';
}

class LeanClient {
  constructor(config) {
    let pool;
    if (typeof config === 'string') pool = mysql.createPool({ uri: config, ...defaultPoolOptions });
    else if (isPool(config)) pool = config;
    else if (config && typeof config === 'object') pool = mysql.createPool({ ...defaultPoolOptions, ...config });
    else throw new Error('LeanClient: expected a connection string, pool options, or a mysql2 pool');

    Object.defineProperty(this, '$pool', { value: pool });
    attachDelegates(this, pool);
  }

  async $transaction(fn) {
    const connection = await this.$pool.getConnection();
    try {
      await connection.beginTransaction();
      const tx = {};
      attachDelegates(tx, connection);
      try {
        const result = await fn(tx);
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    } finally {
      connection.release();
    }
  }

  async $disconnect() {
    await this.$pool.end();
  }
}
`;
