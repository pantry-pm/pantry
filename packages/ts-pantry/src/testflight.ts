import type { AppStoreConnectClient, AppStoreConnectResource, AppStoreVersionPlatform, WaitForAppStoreBuildsOptions } from './app-store-connect'

interface ListResponse<T extends Record<string, unknown>> {
  data: Array<AppStoreConnectResource<T>>
  links?: { next?: string }
}

export interface BetaGroupAttributes extends Record<string, unknown> {
  name: string
  isInternalGroup: boolean
  hasAccessToAllBuilds?: boolean
}

export interface TestFlightBuild {
  id: string
  buildNumber: string
  version: string
  platform: AppStoreVersionPlatform
}

export interface DistributeTestFlightBuildOptions extends WaitForAppStoreBuildsOptions {
  appId: string
  /** The marketing version the build was uploaded under (CFBundleShortVersionString). */
  version: string
  /** The build number (CFBundleVersion). */
  buildNumber: string
  platform?: AppStoreVersionPlatform
  /** Beta group names. Every one must already exist on the app. */
  groups: string[]
  /** "What to Test", shown to testers in the TestFlight app. */
  whatsNew?: string
  locale?: string
}

export interface DistributeTestFlightBuildResult {
  build: TestFlightBuild
  groups: Array<{ id: string, name: string, automatic: boolean }>
  whatsNew: boolean
}

/** Every page of a collection, following Apple's `links.next`. */
async function listAll<T extends Record<string, unknown>>(client: AppStoreConnectClient, path: string): Promise<Array<AppStoreConnectResource<T>>> {
  const items: Array<AppStoreConnectResource<T>> = []
  let next: string | undefined = path
  while (next) {
    const page: ListResponse<T> = await client.request<ListResponse<T>>(next)
    items.push(...page.data)
    next = page.links?.next
  }
  return items
}

/**
 * The build number one past every build the app has ever uploaded, on any
 * version and platform.
 *
 * Apple only demands a build number be new within its version, but one count
 * across the whole app is what makes "1.0.0 (7)" mean the seventh build anyone
 * could have installed, and it can never collide. Numbers that are not plain
 * integers (`1.2.3`) are skipped: they cannot be ordered against a counter.
 * An app with no builds starts at 1.
 */
export async function nextBuildNumber(client: AppStoreConnectClient, appId: string): Promise<string> {
  const query = new URLSearchParams({ 'filter[app]': appId, 'fields[builds]': 'version', 'limit': '200' })
  const builds = await listAll<{ version: string }>(client, `/builds?${query}`)
  const highest = builds
    .map(build => build.attributes.version)
    .filter(version => /^\d+$/.test(version))
    .reduce((max, version) => Math.max(max, Number(version)), 0)
  return String(highest + 1)
}

export async function listBetaGroups(client: AppStoreConnectClient, appId: string): Promise<Array<AppStoreConnectResource<BetaGroupAttributes>>> {
  return await listAll<BetaGroupAttributes>(client, `/apps/${appId}/betaGroups?limit=200`)
}

/** Wait until App Store Connect has processed the build, and return it. */
export async function waitForTestFlightBuild(
  client: AppStoreConnectClient,
  options: Pick<DistributeTestFlightBuildOptions, 'appId' | 'version' | 'buildNumber' | 'platform'> & WaitForAppStoreBuildsOptions,
): Promise<TestFlightBuild> {
  const platform = options.platform ?? 'MAC_OS'
  const timeoutMs = options.timeoutMs ?? 30 * 60_000
  const pollIntervalMs = options.pollIntervalMs ?? 15_000
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
  const deadline = now() + timeoutMs

  while (true) {
    // An upload takes a few minutes to appear at all, so "not listed yet" and
    // "still processing" are the same answer: wait.
    const build = (await client.listBuilds(options.appId, options.buildNumber))
      .find(item => item.platform === platform && item.version === options.version)
    if (build?.processingState === 'FAILED' || build?.processingState === 'INVALID')
      throw new Error(`[pantry] ${options.version} (${options.buildNumber}) failed App Store Connect processing (${build.processingState})`)
    if (build?.processingState === 'VALID')
      return { id: build.id, buildNumber: build.buildNumber, version: build.version, platform: build.platform }
    if (now() >= deadline)
      throw new Error(`[pantry] timed out waiting for ${options.version} (${options.buildNumber}) to finish App Store Connect processing`)
    await sleep(pollIntervalMs)
  }
}

/** Set the build's "What to Test" for one locale, creating or replacing it. */
export async function setTestFlightWhatsNew(client: AppStoreConnectClient, buildId: string, whatsNew: string, locale = 'en-US'): Promise<void> {
  const existing = (await client.request<ListResponse<{ locale: string }>>(`/builds/${buildId}/betaBuildLocalizations`))
    .data.find(item => item.attributes.locale === locale)
  if (existing) {
    await client.request(`/betaBuildLocalizations/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ data: { type: 'betaBuildLocalizations', id: existing.id, attributes: { whatsNew } } }),
    })
    return
  }
  await client.request('/betaBuildLocalizations', {
    method: 'POST',
    body: JSON.stringify({
      data: {
        type: 'betaBuildLocalizations',
        attributes: { locale, whatsNew },
        relationships: { build: { data: { type: 'builds', id: buildId } } },
      },
    }),
  })
}

/**
 * Hand an uploaded build to TestFlight testers: wait for processing, add it to
 * each named beta group, and set "What to Test".
 *
 * The groups are looked up, never created. Who tests an app is a decision made
 * once in App Store Connect, and a misspelt name that quietly made a new, empty
 * group would ship the build to nobody while reporting success.
 */
export async function distributeTestFlightBuild(client: AppStoreConnectClient, options: DistributeTestFlightBuildOptions): Promise<DistributeTestFlightBuildResult> {
  if (!options.groups.length)
    throw new Error('[pantry] name at least one TestFlight beta group')
  const available = await listBetaGroups(client, options.appId)
  const groups = options.groups.map((name) => {
    const group = available.find(item => item.attributes.name === name)
    if (!group) {
      const names = available.map(item => `"${item.attributes.name}"`).join(', ') || 'none'
      throw new Error(`[pantry] TestFlight group "${name}" does not exist on this app (groups: ${names}). Create it in App Store Connect first.`)
    }
    return group
  })

  const build = await waitForTestFlightBuild(client, options)
  // A group with automatic distribution already has every build, and Apple
  // answers an explicit add to one with a 422 ("Cannot add internal group to a
  // build") rather than a no-op. The rest are added per group: the build-side
  // relationship refuses internal groups the same way.
  const manual = groups.filter(group => !(group.attributes.isInternalGroup && group.attributes.hasAccessToAllBuilds))
  for (const group of manual) {
    await client.request(`/betaGroups/${group.id}/relationships/builds`, {
      method: 'POST',
      body: JSON.stringify({ data: [{ type: 'builds', id: build.id }] }),
    })
  }
  if (options.whatsNew?.trim())
    await setTestFlightWhatsNew(client, build.id, options.whatsNew.trim(), options.locale)

  return {
    build,
    groups: groups.map(group => ({ id: group.id, name: group.attributes.name, automatic: !manual.includes(group) })),
    whatsNew: Boolean(options.whatsNew?.trim()),
  }
}
