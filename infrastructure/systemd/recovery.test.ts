import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const workflow = readFileSync(
  join(import.meta.dir, '../../.github/workflows/deploy-registry.yml'),
  'utf8',
)

describe('Pantry Registry recovery timer', () => {
  // Regression guard for a silent, total watchdog failure.
  //
  // The timer previously used OnBootSec=1min + OnUnitActiveSec=1min. systemd
  // derives the next OnUnitActiveSec elapse from the ActiveEnterTimestamp of the
  // unit the timer activates. For a Type=oneshot service that timestamp is empty
  // after a reboot, so systemd resolved NextElapseUSecMonotonic=infinity — the
  // timer reported "active"/"enabled" forever while never firing again.
  //
  // It died at the 2026-07-31 reboot. When the registry wedged on 2026-08-03,
  // nothing recovered it and pantry.dev stayed down until found by hand.
  test('schedules on an absolute calendar, never OnUnitActiveSec', () => {
    expect(workflow).toContain("'OnCalendar=*:0/1'")
    expect(workflow).not.toContain("'OnUnitActiveSec=1min'")
    expect(workflow).not.toContain("'OnBootSec=1min'")
  })

  test('restarts clamav as well as the registry, since clamd saturation is the trigger', () => {
    // Restarting the registry alone leaves the saturated daemon in place and it
    // wedges again on the next large upload.
    expect(workflow).toContain('systemctl restart clamav-daemon.service')
    expect(workflow).toContain('systemctl restart ${SERVICE}.service')
  })

  test('logs every recovery so flapping cannot go unnoticed', () => {
    expect(workflow).toContain('[recover] UNHEALTHY')
    expect(workflow).toContain('[recover] RECOVERED')
    expect(workflow).toContain('[recover] STILL UNHEALTHY after restart')
  })

  test('re-probes after restarting and does not mark the unit failed on a bad probe', () => {
    // A failed probe is reported and retried next minute; a non-zero exit would
    // otherwise flood the journal with unit-failure noise.
    expect(workflow).toContain("'SuccessExitStatus=0 1'")
  })
})
