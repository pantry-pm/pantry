/**
 * Package deprecation.
 *
 * A registry keeps every version it has published: there is no unpublish. An
 * owner retires a package by deprecating it instead. Its versions stay
 * installable, but every metadata document a client reads carries
 * `deprecated: "<message>"` - npm's convention, which the Pantry CLI follows -
 * and the package page says so.
 *
 * Deprecation is stored in the package's publisher settings
 * (`deprecated` / `deprecationMessage`), so the publisher dashboard and
 * `pantry deprecate` write the same thing.
 */

import type { PackagePublisherSettings } from './types'

/** What a deprecated package says when its owner gave no reason. */
export const DEFAULT_DEPRECATION_MESSAGE = 'This package is deprecated'

/** Long enough for a sentence and a link; a message is not a README. */
export const MAX_DEPRECATION_MESSAGE_LENGTH = 1024

/**
 * One line of plain text: control characters (newlines included) become
 * spaces and runs of whitespace collapse, so a message can't forge extra
 * lines in a terminal.
 */
function singleLine(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * The message a deprecated package shows, or null when it isn't deprecated.
 * Never empty: npm reads an empty `deprecated` string as "not deprecated".
 */
export function deprecationMessage(settings?: Pick<PackagePublisherSettings, 'deprecated' | 'deprecationMessage'> | null): string | null {
  if (!settings?.deprecated) return null
  const message = typeof settings.deprecationMessage === 'string' ? singleLine(settings.deprecationMessage) : ''
  return message || DEFAULT_DEPRECATION_MESSAGE
}

/**
 * A metadata document with `deprecated` set when the package is deprecated.
 * Any `deprecated` field already on the document is left alone otherwise, so a
 * document that is not deprecated never claims to be.
 */
export function withDeprecation<T extends object>(
  metadata: T,
  settings?: Pick<PackagePublisherSettings, 'deprecated' | 'deprecationMessage'> | null,
): T & { deprecated?: string } {
  const message = deprecationMessage(settings)
  if (!message) return metadata
  return { ...metadata, deprecated: message }
}

/**
 * Validate a deprecation message from a request body. Absent, null or blank
 * means "no reason given" (the default message is shown).
 */
export function parseDeprecationMessage(raw: unknown): { message: string | undefined } | { error: string } {
  if (raw === undefined || raw === null) return { message: undefined }
  if (typeof raw !== 'string') return { error: 'message must be a string' }
  const message = singleLine(raw)
  if (message.length > MAX_DEPRECATION_MESSAGE_LENGTH)
    return { error: `message must be at most ${MAX_DEPRECATION_MESSAGE_LENGTH} characters` }
  return { message: message || undefined }
}
