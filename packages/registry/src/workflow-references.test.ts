import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const workflowDir = resolve(import.meta.dir, '../../../.github/workflows')

interface Workflow {
  /** The file, for naming the failure. */
  file: string
  /** The `name:` other workflows have to spell exactly to depend on it. */
  name: string
  runNameExample?: string
  /** Every workflow this one triggers on, by that same name. */
  triggersOn: string[]
}

function workflows(): Workflow[] {
  return readdirSync(workflowDir)
    .filter(file => file.endsWith('.yml') || file.endsWith('.yaml'))
    .map((file) => {
      const parsed = Bun.YAML.parse(readFileSync(resolve(workflowDir, file), 'utf8')) as any
      // `on:` is the YAML 1.1 boolean, so it arrives under the key `true`.
      const on = parsed?.on ?? parsed?.true ?? parsed?.[true as unknown as string]
      const listed = on?.workflow_run?.workflows
      return {
        file,
        name: typeof parsed?.name === 'string' ? parsed.name : '',
        runNameExample: typeof parsed?.['run-name'] === 'string'
          ? parsed['run-name'].match(/format\(['"]([^{}'"]+)\{/u)?.[1]?.concat('example') : undefined,
        triggersOn: Array.isArray(listed) ? listed.filter((w: unknown) => typeof w === 'string') : [],
      }
    })
}

/**
 * `workflow_run.workflows` accepts display names and glob patterns. Dynamic
 * run names must remain covered by their producer's declared format prefix.
 *
 * A name that matches nothing is not an error anywhere: the trigger is
 * accepted, the workflow is valid, and it simply never fires. That is the same
 * silence `drain-release-queue.yml` exists to fix — a schedule that reads as
 * every ten minutes and is delivered twice a day — so the fix should not be
 * one rename away from being just as quiet.
 *
 * Renaming a workflow is the way this breaks. `name:` is display text and
 * looks free to change; every dependant is a string in another file that no
 * editor cross-references.
 */
describe('workflow_run references', () => {
  it('names a workflow that exists', () => {
    const all = workflows()
    const known = all.flatMap(w => [w.name, w.runNameExample]).filter((name): name is string => Boolean(name))
    const dangling = all.flatMap(w =>
      w.triggersOn.filter(t => !known.some(name => new Bun.Glob(t).match(name))).map(t => `${w.file} triggers on "${t}", which no workflow is named`),
    )

    expect(dangling).toEqual([])
  })

  it('does not trigger on itself', () => {
    // A workflow in its own list either never fires or fires forever, and
    // which one it is depends on GitHub rather than on anything reviewable.
    const selfReferencing = workflows()
      .filter(w => [w.name, w.runNameExample].some(name => name && w.triggersOn.some(pattern => new Bun.Glob(pattern).match(name))))
      .map(w => w.file)

    expect(selfReferencing).toEqual([])
  })

  it('covers the workflows that carry a reference', () => {
    // Guards the parse rather than the workflows: if `on:` ever stops landing
    // where this looks for it, every list reads as empty and both tests above
    // pass by finding nothing to check.
    const referencing = workflows().filter(w => w.triggersOn.length > 0).map(w => w.file).sort()

    expect(referencing).toEqual(['ci-failure-issue.yml', 'drain-release-queue.yml', 'recover-catalog-publications.yml'])
  })
})
