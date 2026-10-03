import type { ReleaseClient, ReleaseLike } from './release-draft'
import { describe, expect, it } from 'bun:test'
import { canonicalDraft, findReleaseForTag, settleCreatedDraft } from './release-draft'

const draft = (id: number, tag = 'v1.0.0'): ReleaseLike => ({ id, draft: true, tag_name: tag, html_url: `https://x/${id}` })

function client(releases: ReleaseLike[], published?: ReleaseLike): ReleaseClient & { deleted: number[] } {
  const deleted: number[] = []
  return {
    deleted,
    getPublishedByTag: async () => published,
    listRecent: async () => releases.filter(release => !deleted.includes(release.id)),
    deleteRelease: async (id) => { deleted.push(id) },
  }
}

describe('release drafts shared by matrix legs', () => {
  it('finds another leg\'s draft, which the tag lookup never returns', async () => {
    expect((await findReleaseForTag(client([draft(7), draft(9, 'v0.9.0')]), 'v1.0.0'))?.id).toBe(7)
  })

  it('prefers the published release', async () => {
    const published = { ...draft(3), draft: false }
    expect((await findReleaseForTag(client([draft(7)], published), 'v1.0.0'))?.id).toBe(3)
  })

  it('finds nothing for a new tag', async () => {
    expect(await findReleaseForTag(client([draft(9, 'v0.9.0')]), 'v1.0.0')).toBeUndefined()
  })

  it('defers to the older draft when two legs created one at once, removing its own', async () => {
    const releases = [draft(12), draft(11)]
    const api = client(releases)
    const settled = await settleCreatedDraft(api, 'v1.0.0', releases[0]!)
    expect(settled).toEqual({ release: releases[1], own: false })
    expect(api.deleted).toEqual([12])
  })

  it('keeps its draft when it is the only one, or the oldest', async () => {
    const releases = [draft(12), draft(11)]
    const api = client(releases)
    expect((await settleCreatedDraft(api, 'v1.0.0', releases[1]!)).own).toBe(true)
    expect(api.deleted).toEqual([])
    expect(canonicalDraft([draft(5, 'other')], 'v1.0.0')).toBeUndefined()
  })
})
