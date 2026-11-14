/** Android TV specifics: key codes, power-state parsing and HDMI input command building. */

export const KEYCODE = {
	HOME: 3,
	BACK: 4,
	DPAD_UP: 19,
	DPAD_DOWN: 20,
	DPAD_LEFT: 21,
	DPAD_RIGHT: 22,
	DPAD_CENTER: 23,
	VOLUME_UP: 24,
	VOLUME_DOWN: 25,
	POWER: 26,
	VOLUME_MUTE: 164,
	SLEEP: 223,
	WAKEUP: 224,
	TV_INPUT_HDMI_1: 243,
	TV_INPUT_HDMI_2: 244,
	TV_INPUT_HDMI_3: 245,
	TV_INPUT_HDMI_4: 246,
} as const

export type PowerState = 'on' | 'off' | 'offline' | 'unknown'

/**
 * Shell command used to read the power state. Output is filtered on the TV to keep polling light.
 * (`grep` is part of toybox on every Android TV we know of; if missing we still parse the full output.)
 */
export const POWER_QUERY =
	'dumpsys power | grep -E "mWakefulness=|Display Power: state=|mHoldingDisplaySuspendBlocker="'

/**
 * Interpret `dumpsys power` output.
 * mWakefulness: Awake | Asleep | Dozing | Dreaming (Dreaming = screensaver, screen still on).
 * Falls back to "Display Power: state=ON|OFF" when mWakefulness is absent.
 */
export function parsePowerState(dumpsys: string): PowerState {
	const wake = /mWakefulness=(\w+)/.exec(dumpsys)?.[1]?.toLowerCase()
	if (wake === 'awake' || wake === 'dreaming') return 'on'
	if (wake === 'asleep' || wake === 'dozing') return 'off'
	const disp = /Display Power: state=(\w+)/.exec(dumpsys)?.[1]?.toUpperCase()
	if (disp === 'ON') return 'on'
	if (disp === 'OFF' || disp === 'DOZE' || disp === 'DOZE_SUSPEND') return 'off'
	return 'unknown'
}

export function keyeventCommand(code: number): string {
	if (!Number.isInteger(code) || code < 0 || code > 9999) throw new Error(`invalid keycode ${code}`)
	return `input keyevent ${code}`
}

/** Accept a numeric keycode or a KEYCODE_* name (e.g. "KEYCODE_HOME" or "HOME"). Returns the input keyevent argument. */
export function normalizeKeycode(input: string): string {
	const s = input.trim()
	if (/^\d+$/.test(s)) return s
	const name = s.toUpperCase().replace(/^KEYCODE_/, '')
	if (!/^[A-Z0-9_]+$/.test(name)) throw new Error(`invalid keycode "${input}"`)
	return `KEYCODE_${name}`
}

export type HdmiMethod = 'auto' | 'keycode' | 'passthrough' | 'custom'

/**
 * Build the shell command that selects an input.
 * - auto:        passthrough to `value` (the TV input discovered for that HDMI port, see
 *                parseHdmiInputMap); falls back to the key event when nothing is known.
 * - keycode:    KEYCODE_TV_INPUT_HDMI_n (243..246). Works on many TVs (used by the original relay).
 * - passthrough: open the TV input framework passthrough URI for a TV input ID, e.g.
 *                "com.mediatek.tvinput/.hdmi.HDMIInputService/HW5" (find IDs with "dumpsys tv_input").
 * - custom:      run the given shell command verbatim.
 */
export function hdmiCommand(method: HdmiMethod, input: number, value?: string): string {
	switch (method) {
		case 'auto':
			if ((value ?? '').trim()) return passthroughCommand(value as string)
			return hdmiCommand('keycode', input)
		case 'keycode':
			if (!Number.isInteger(input) || input < 1 || input > 4) throw new Error('HDMI input must be 1-4')
			return keyeventCommand(KEYCODE.TV_INPUT_HDMI_1 + input - 1)
		case 'passthrough': {
			const id = (value ?? '').trim()
			if (!id) throw new Error(`no TV input ID configured for HDMI ${input}`)
			return passthroughCommand(id)
		}
		case 'custom': {
			const cmd = (value ?? '').trim()
			if (!cmd) throw new Error(`no custom command configured for HDMI ${input}`)
			return cmd
		}
	}
}

export function passthroughCommand(inputId: string): string {
	const uri = `content://android.media.tv/passthrough/${encodeURIComponent(inputId.trim())}`
	return `am start -a android.intent.action.VIEW -d '${uri}'`
}

/** Extract TV input IDs from `dumpsys tv_input` output (e.g. "com.mediatek.tvinput/.hdmi.HDMIInputService/HW5"). */
export function parseTvInputIds(dumpsys: string): string[] {
	const ids = new Set<string>()
	for (const m of dumpsys.matchAll(/\bid=([\w.]+\/[\w.$]+\/[\w.$]+)/g)) ids.add(m[1])
	for (const m of dumpsys.matchAll(/inputId=([\w.]+\/[\w.$]+\/[\w.$]+)/g)) ids.add(m[1])
	return [...ids]
}

/**
 * Map HDMI port numbers to TV input IDs using `dumpsys tv_input`.
 * The Android TV input framework names hardware inputs "<service>/HW<deviceId>", and the hardware
 * list reports "TvInputHardwareInfo {id=<deviceId>, type=9 (HDMI), ..., hdmi_port=<n>, ...}".
 */
export function parseHdmiInputMap(dumpsys: string): Record<number, string> {
	const portByDevice = new Map<string, number>()
	for (const m of dumpsys.matchAll(/TvInputHardwareInfo \{id=(\d+), type=9\b[^}]*?hdmi_port=(\d+)/g)) {
		portByDevice.set(m[1], Number(m[2]))
	}
	const out: Record<number, string> = {}
	for (const id of parseTvInputIds(dumpsys)) {
		const dev = /\/HW(\d+)$/.exec(id)?.[1]
		const port = dev ? portByDevice.get(dev) : undefined
		if (port && !out[port]) out[port] = id
	}
	return out
}

/** Pull "ro.product.model=..." etc. out of the CNXN banner. */
export function parseBanner(banner: string): Record<string, string> {
	const out: Record<string, string> = {}
	const props = banner.split('::')[1] ?? ''
	for (const part of props.split(';')) {
		const i = part.indexOf('=')
		if (i > 0) out[part.slice(0, i)] = part.slice(i + 1)
	}
	return out
}
