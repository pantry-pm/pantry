/** Exact registry keys, shared by upload validation and operator-issued grants. */
export function isBinaryDomain(value: unknown): value is string {
  return typeof value === 'string'
    && /^[a-z0-9](?:[a-z0-9._-]|\/(?=[a-z0-9])){0,213}$/i.test(value)
    && !value.includes('..') && !value.endsWith('/')
}
