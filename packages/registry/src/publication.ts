/** A version is an immutable publication, even when uploads arrive concurrently. */
export class PackageVersionExistsError extends Error {
  constructor(name: string, version: string) {
    super(`Version already exists: ${name}@${version}`)
    this.name = 'PackageVersionExistsError'
  }
}
