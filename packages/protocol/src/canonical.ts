/**
 * Canonical JSON: object keys sorted by UTF-16 code unit, no whitespace, `undefined`
 * members dropped. Signatures are always computed over this form so that two peers
 * serialising the same value produce the same bytes.
 *
 * Signed records are verified over the object exactly as received (minus `sig`), before
 * schema parsing strips unknown fields, so newer peers can add fields without breaking
 * signatures on older peers.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return (
          '[' +
          value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',') +
          ']'
        );
      }
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) {
        throw new Error('canonicalJson: only plain objects are supported');
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((k) => record[k] !== undefined)
        .sort();
      return (
        '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(record[k])).join(',') + '}'
      );
    }
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof value}`);
  }
}

/** The bytes a signature covers: canonical JSON of the record without its `sig` field. */
export function signingPayload(record: Record<string, unknown>): string {
  const { sig: _sig, ...rest } = record;
  return canonicalJson(rest);
}
