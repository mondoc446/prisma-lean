import { DMMF } from '@prisma/generator-helper';

/** Client-side default applied by the generated runtime on `create`. */
export type DefaultMeta =
    | { kind: 'uuid'; version: 4 | 7 }
    | { kind: 'cuid'; version: 1 | 2 }
    | { kind: 'nanoid'; length: number }
    | { kind: 'now' }
    | { kind: 'literal'; value: unknown };

export interface FieldMeta {
    name: string;
    column: string;
    /** Prisma scalar type (`String`, `Int`, ...) or the enum name. */
    type: string;
    kind: 'scalar' | 'enum';
    isRequired: boolean;
    isId: boolean;
    isUpdatedAt: boolean;
    isAutoIncrement: boolean;
    /** True when the database, not the client, provides the value (autoincrement, dbgenerated). */
    isDbGenerated: boolean;
    default: DefaultMeta | null;
    /** Enum value name -> database value. Only set for enum fields. */
    enumValues?: Record<string, string>;
}

export interface UniqueKeyMeta {
    /** Key used in `where`: the field name, or the compound name (for example `a_b`). */
    name: string;
    fields: string[];
}

export interface ModelMeta {
    name: string;
    accessor: string;
    table: string;
    fields: FieldMeta[];
    uniqueKeys: UniqueKeyMeta[];
}

export interface EnumMeta {
    name: string;
    values: string[];
}

export interface ClientMeta {
    models: ModelMeta[];
    enums: EnumMeta[];
}

/** `UserProfile` -> `userProfile`. */
export function toAccessorName(modelName: string): string {
    return modelName.charAt(0).toLowerCase() + modelName.slice(1);
}

const DB_GENERATED_DEFAULTS = ['autoincrement', 'dbgenerated', 'sequence'];

/**
 * Splits a default function into name and numeric argument.
 * Prisma encodes the argument either in `args` or in the name itself, for example `uuid(4)`.
 */
function defaultFunction(field: DMMF.Field): { name: string; arg?: number } | null {
    const def = field.default;
    if (typeof def !== 'object' || def === null || Array.isArray(def) || !('name' in def)) return null;
    const match = /^(\w+)(?:\((\d*)\))?$/.exec(def.name);
    const arg = Number(match?.[2] || (def.args as unknown[] | undefined)?.[0]) || undefined;
    return { name: match?.[1] ?? def.name, arg };
}

function toDefaultMeta(field: DMMF.Field): DefaultMeta | null {
    const def = field.default;
    if (def === undefined || def === null || Array.isArray(def)) return null;

    const fn = defaultFunction(field);
    if (!fn) return { kind: 'literal', value: def };

    switch (fn.name) {
        case 'uuid':
            return { kind: 'uuid', version: fn.arg === 7 ? 7 : 4 };
        case 'cuid':
            return { kind: 'cuid', version: fn.arg === 2 ? 2 : 1 };
        case 'nanoid':
            return { kind: 'nanoid', length: fn.arg ?? 21 };
        case 'now':
            return { kind: 'now' };
        default:
            // autoincrement(), dbgenerated(), sequence(): the database provides the value.
            return null;
    }
}

function toFieldMeta(field: DMMF.Field, enums: readonly DMMF.DatamodelEnum[]): FieldMeta {
    const meta: FieldMeta = {
        name: field.name,
        column: field.dbName ?? field.name,
        type: field.type,
        kind: field.kind === 'enum' ? 'enum' : 'scalar',
        isRequired: field.isRequired,
        isId: field.isId,
        isUpdatedAt: field.isUpdatedAt ?? false,
        isAutoIncrement: defaultFunction(field)?.name === 'autoincrement',
        isDbGenerated: DB_GENERATED_DEFAULTS.includes(defaultFunction(field)?.name ?? ''),
        default: toDefaultMeta(field),
    };

    if (field.kind === 'enum') {
        const enumDef = enums.find((e) => e.name === field.type);
        if (!enumDef) throw new Error(`Enum ${field.type} used by field ${field.name} is not defined`);
        meta.enumValues = Object.fromEntries(enumDef.values.map((v) => [v.name, v.dbName ?? v.name]));
    }

    return meta;
}

/** Fields the generated client reads and writes: scalars and enums, never relations or `Unsupported`. */
export function clientFields(model: DMMF.Model): DMMF.Field[] {
    return model.fields.filter((f) => (f.kind === 'scalar' || f.kind === 'enum') && !f.isList);
}

function toUniqueKeys(model: DMMF.Model): UniqueKeyMeta[] {
    const keys: UniqueKeyMeta[] = [];
    const add = (name: string, fields: readonly string[]) => {
        if (!keys.some((k) => k.name === name)) keys.push({ name, fields: [...fields] });
    };

    for (const field of model.fields) {
        if (field.isId || field.isUnique) add(field.name, [field.name]);
    }
    if (model.primaryKey) {
        add(model.primaryKey.name ?? model.primaryKey.fields.join('_'), model.primaryKey.fields);
    }
    for (const index of model.uniqueIndexes ?? []) {
        add(index.name ?? index.fields.join('_'), index.fields);
    }
    for (const fields of model.uniqueFields ?? []) {
        add(fields.join('_'), fields);
    }

    return keys;
}

export function buildClientMeta(dmmf: DMMF.Document): ClientMeta {
    const enums = dmmf.datamodel.enums ?? [];

    const models = dmmf.datamodel.models.map((model) => {
        const fields = clientFields(model).map((f) => toFieldMeta(f, enums));

        for (const field of model.fields) {
            if (field.kind === 'scalar' && field.isList) {
                throw new Error(`${model.name}.${field.name}: scalar lists are not supported on MySQL`);
            }
        }

        return {
            name: model.name,
            accessor: toAccessorName(model.name),
            table: model.dbName ?? model.name,
            fields,
            uniqueKeys: toUniqueKeys(model),
        };
    });

    const accessors = new Set<string>();
    for (const model of models) {
        if (accessors.has(model.accessor)) {
            throw new Error(`Two models map to the same client accessor "${model.accessor}"`);
        }
        accessors.add(model.accessor);
    }

    return {
        models,
        enums: enums.map((e) => ({ name: e.name, values: e.values.map((v) => v.name) })),
    };
}
