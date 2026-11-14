/**
 * "Restore power state after outage": decide what to do when the TV is reached again.
 *
 * A reboot is detected only by a change of the kernel boot id (/proc/sys/kernel/random/boot_id),
 * which is a fresh random UUID on every boot. Network drops, Companion restarts and module upgrades
 * keep the same boot id, so they can never trigger a restore.
 */
import type { PowerState } from './android.js'

/** Prints the boot id. Empty output if it can't be read (then no restore is ever attempted). */
export const BOOT_ID_QUERY = 'cat /proc/sys/kernel/random/boot_id 2>/dev/null'

export type RestoreAction = 'none' | 'power_off' | 'wake'

export interface RestoreInput {
	enabled: boolean
	/** Boot id seen the last time the TV was reachable ('' if never seen). */
	previousBootId: string
	/** Boot id now. */
	currentBootId: string
	/** Last power state observed while the TV was reachable before ('' if unknown). */
	lastKnown: '' | 'on' | 'off'
	/** Power state right now. */
	current: PowerState
}

export interface RestoreDecision {
	action: RestoreAction
	rebooted: boolean
	reason: string
}

export function parseBootId(out: string): string {
	const m = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(out)
	return m ? m[0].toLowerCase() : ''
}

export function decideRestore(i: RestoreInput): RestoreDecision {
	if (!i.currentBootId) return { action: 'none', rebooted: false, reason: 'boot id not readable on this TV' }
	if (!i.previousBootId) return { action: 'none', rebooted: false, reason: 'first contact: boot id recorded' }
	if (i.previousBootId === i.currentBootId)
		return { action: 'none', rebooted: false, reason: 'same boot: reconnect only' }
	// The TV rebooted (power loss, or a restart) since we last saw it.
	if (!i.enabled) return { action: 'none', rebooted: true, reason: 'TV rebooted; restore is disabled' }
	if (i.lastKnown === 'off' && i.current === 'on') {
		return { action: 'power_off', rebooted: true, reason: 'TV rebooted and came up on; it was off before' }
	}
	if (i.lastKnown === 'on' && i.current === 'off') {
		return { action: 'wake', rebooted: true, reason: 'TV rebooted into standby; it was on before' }
	}
	return {
		action: 'none',
		rebooted: true,
		reason: i.lastKnown
			? `TV rebooted; already in its previous state (${i.lastKnown})`
			: 'TV rebooted; previous state unknown',
	}
}
