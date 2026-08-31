import { describe, expect, it } from 'bun:test'
import { UpstreamUnavailable } from './version-fetcher'

/**
 * Telling "nothing new upstream" apart from "could not ask upstream".
 *
 * Both used to be an empty array. The sweep counted that as a clean check, so a
 * run that exhausted its GitHub rate limit reported `631 checked, 0 errors` and
 * committed "no new versions" for every package it never reached — indexing
 * that guess as fact, and going green while doing it. The workflow then hid
 * whatever was left behind `|| true`.
 *
 * This is the type that keeps the two apart, and the rate-limit predicate that
 * decides whether a sweep is merely incomplete or entirely void.
 */
describe('UpstreamUnavailable', () => {
  it('carries the repo, the status, and whether the limit was the cause', () => {
    const err = new UpstreamUnavailable('craft-native/craft', 403, true)
    expect(err.repo).toBe('craft-native/craft')
    expect(err.status).toBe(403)
    expect(err.rateLimited).toBe(true)
    expect(err.message).toContain('403')
    expect(err.message).toContain('rate limit exhausted')
  })

  it('is an Error, so an unprepared caller still fails loudly', () => {
    expect(new UpstreamUnavailable('a/b', 500, false)).toBeInstanceOf(Error)
  })

  it('does not claim a rate limit for an ordinary failure', () => {
    expect(new UpstreamUnavailable('a/b', 404, false).message).not.toContain('rate limit')
  })
})
