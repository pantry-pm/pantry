import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const workflowDir = resolve(import.meta.dir, '../../../.github/workflows')

interface Workflow {
  /** The file, for naming the failure. */
  file: string
  /** The `name:` other workflows have to spell exactly to depend on it. */
  name: string
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
        triggersOn: Array.isArray(listed) ? listed.filter((w: unknown) => typeof w === 'string') : [],
      }
    })
}

/**
 * `workflow_run.workflows` is a list of display names, matched as strings.
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
    const known = new Set(all.map(w => w.name).filter(Boolean))
    const dangling = all.flatMap(w =>
      w.triggersOn.filter(t => !known.has(t)).map(t => `${w.file} triggers on "${t}", which no workflow is named`),
    )

    expect(dangling).toEqual([])
  })

  it('does not trigger on itself', () => {
    // A workflow in its own list either never fires or fires forever, and
    // which one it is depends on GitHub rather than on anything reviewable.
    const selfReferencing = workflows()
      .filter(w => w.name && w.triggersOn.includes(w.name))
      .map(w => w.file)

    expect(selfReferencing).toEqual([])
  })

  it('covers the workflows that carry a reference', () => {
    // Guards the parse rather than the workflows: if `on:` ever stops landing
    // where this looks for it, every list reads as empty and both tests above
    // pass by finding nothing to check.
    const referencing = workflows().filter(w => w.triggersOn.length > 0).map(w => w.file).sort()

    expect(referencing).toEqual(['ci-failure-issue.yml', 'drain-release-queue.yml'])
  })
})
