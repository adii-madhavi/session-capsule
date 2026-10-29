// Minimal JSON Schema validator covering the subset used by schemas/v1.
// Kept in-house so the engine has no runtime dependencies.

import fs from 'node:fs';
import path from 'node:path';

export interface Schema {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  $ref?: string;
  definitions?: Record<string, Schema>;
}

export type SchemaName = 'manifest' | 'files' | 'conversation' | 'environment' | 'handoff';

const SCHEMA_DIR = path.join(import.meta.dirname, '..', '..', 'schemas', 'v1');
const cache = new Map<SchemaName, Schema>();

export function loadSchema(name: SchemaName): Schema {
  let schema = cache.get(name);
  if (!schema) {
    schema = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, `${name}.schema.json`), 'utf8')) as Schema;
    cache.set(name, schema);
  }
  return schema;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

export function validate(schema: Schema, value: unknown, maxErrors = 20): string[] {
  const errors: string[] = [];
  const patterns = new Map<string, RegExp>();

  const walk = (s: Schema, v: unknown, at: string): void => {
    if (errors.length >= maxErrors) return;
    const where = at || '/';
    if (s.$ref) {
      const target = schema.definitions?.[s.$ref.replace('#/definitions/', '')];
      if (!target) errors.push(`${where}: unknown reference ${s.$ref}`);
      else walk(target, v, at);
      return;
    }
    const t = typeOf(v);
    if (s.type) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      if (!types.includes(t) && !(t === 'integer' && types.includes('number'))) {
        errors.push(`${where}: expected ${types.join(' or ')}, got ${t}`);
        return;
      }
    }
    if (s.const !== undefined && v !== s.const) errors.push(`${where}: must be ${JSON.stringify(s.const)}`);
    if (s.enum && !s.enum.includes(v)) errors.push(`${where}: must be one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}`);
    if (typeof v === 'string') {
      if (s.minLength !== undefined && v.length < s.minLength) errors.push(`${where}: shorter than ${s.minLength}`);
      if (s.maxLength !== undefined && v.length > s.maxLength) errors.push(`${where}: longer than ${s.maxLength}`);
      if (s.pattern) {
        let re = patterns.get(s.pattern);
        if (!re) patterns.set(s.pattern, (re = new RegExp(s.pattern, 'u')));
        if (!re.test(v)) errors.push(`${where}: does not match ${s.pattern}`);
      }
    }
    if (typeof v === 'number') {
      if (s.minimum !== undefined && v < s.minimum) errors.push(`${where}: below ${s.minimum}`);
      if (s.maximum !== undefined && v > s.maximum) errors.push(`${where}: above ${s.maximum}`);
    }
    if (Array.isArray(v)) {
      if (s.maxItems !== undefined && v.length > s.maxItems) errors.push(`${where}: more than ${s.maxItems} items`);
      else if (s.items) v.forEach((item, i) => walk(s.items as Schema, item, `${at}/${i}`));
    }
    if (t === 'object') {
      const obj = v as Record<string, unknown>;
      for (const key of s.required ?? []) if (!Object.hasOwn(obj, key)) errors.push(`${where}: missing "${key}"`);
      for (const [key, child] of Object.entries(obj)) {
        const ps = s.properties?.[key];
        if (ps) walk(ps, child, `${at}/${key}`);
        else if (s.additionalProperties === false) errors.push(`${where}: unexpected property "${key}"`);
        else if (typeof s.additionalProperties === 'object') walk(s.additionalProperties, child, `${at}/${key}`);
      }
    }
  };

  walk(schema, value, '');
  return errors;
}

export function validateNamed(name: SchemaName, value: unknown): string[] {
  return validate(loadSchema(name), value);
}
