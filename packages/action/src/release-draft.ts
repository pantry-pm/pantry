/**
 * Finding the release a matrix leg should attach its assets to.
 *
 * Each leg of a release matrix stages assets into one draft per tag. GitHub's
 * `GET /releases/tags/{tag}` never returns drafts, so a leg that looked the
 * tag up that way found nothing and created its own: craft-native v0.0.106
 * ended up with two drafts, darwin assets in one and linux/windows in the
 * other, and its asset gate refused to publish either. Legs that start
 * together can also both create one before either is visible, so a leg that
 * created a draft checks again and defers to the oldest.
 */

export interface ReleaseLike {
  id: number
  draft: boolean
  tag_name: string
  html_url: string
  body?: string | null
}

export interface ReleaseClient {
  /** The published release for a tag, or undefined when there is none. */
  getPublishedByTag: (tag: string) => Promise<ReleaseLike | undefined>
  /** The most recent releases, drafts included, newest first. */
  listRecent: () => Promise<ReleaseLike[]>
  deleteRelease: (id: number) => Promise<void>
}

/** The draft every leg should share for a tag: the oldest one. */
export function canonicalDraft(releases: readonly ReleaseLike[], tag: string): ReleaseLike | undefined {
  return releases
    .filter(release => release.draft && release.tag_name === tag)
    .sort((a, b) => a.id - b.id)[0]
}

/** The existing release for a tag, published or draft. */
export async function findReleaseForTag(client: ReleaseClient, tag: string): Promise<ReleaseLike | undefined> {
  const published = await client.getPublishedByTag(tag)
  if (published)
    return published
  return canonicalDraft(await client.listRecent(), tag)
}

/**
 * After creating a draft, defer to an older one another leg created at the
 * same moment, removing the empty draft this leg just made.
 *
 * @returns The draft to attach assets to, and whether it is this leg's own.
 */
export async function settleCreatedDraft(client: ReleaseClient, tag: string, created: ReleaseLike): Promise<{ release: ReleaseLike, own: boolean }> {
  const canonical = canonicalDraft(await client.listRecent(), tag)
  if (!canonical || canonical.id === created.id)
    return { release: created, own: true }
  await client.deleteRelease(created.id)
  return { release: canonical, own: false }
}
