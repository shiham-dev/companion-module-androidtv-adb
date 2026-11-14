/**
 * Companion-independent TV controller: owns the ADB client, polls power state,
 * implements power on (with Wake-on-LAN), off, toggle, inputs and keys.
 */
import { EventEmitter } from 'node:events'
import type { KeyObject } from 'node:crypto'
import { AdbClient, AdbError, type AdbConnectionState } from './adb/client.js'
import {
	KEYCODE,
	NETWORK_QUERY,
	POWER_QUERY,
	hdmiCommand,
	keyeventCommand,
	parseHdmiInputMap,
	parseBanner,
	parseNetworkInfo,
	parsePowerState,
	type NetworkInfo,
	type HdmiMethod,
	type PowerState,
} from './android.js'
import { sendWol } from './wol.js'
import { BOOT_ID_QUERY, decideRestore, parseBootId, type RestoreAction } from './restore.js'

export interface TvOptions {
	host: string
	port: number
	key: KeyObject
	keyName: string
	mac?: string
	/** Where to send magic packets: directed broadcast(s) and/or the TV's unicast address. */
	wolAddresses?: string[]
	wolPort?: number
	wolCount?: number
	/** After WoL, keep retrying ADB for this long before giving up (cold boots can take 30-90 s). */
	wakeWindowMs?: number
	/** Power-state poll interval (0 disables polling). */
	pollIntervalMs: number
	/** Keep the ADB connection open between commands (faster; occupies the TV's single ADB slot). */
	keepConnected: boolean
	connectTimeoutMs?: number
	commandTimeoutMs?: number
	authTimeoutMs?: number
	debug?: (msg: string) => void
	/** Restore the last known power state when the TV rebooted (e.g. after a power cut). */
	restoreEnabled?: boolean
	/** Wait this long after detecting the reboot before restoring (lets the TV finish booting). */
	restoreDelayMs?: number
	/** Boot id persisted from the last time the TV was reachable. */
	knownBootId?: string
	/** Power state persisted from the last time the TV was reachable. */
	lastKnownPower?: '' | 'on' | 'off'
}

export type ConnectionStatus =
	'disconnected' | 'connecting' | 'awaiting_approval' | 'connected' | 'offline' | 'auth_failed' | 'error'

export interface TvSnapshot {
	connection: ConnectionStatus
	power: PowerState
	model: string
	manufacturer: string
	androidVersion: string
	lastError: string
	waking: boolean
}

export interface TvEvents {
	update: [TvSnapshot]
	log: ['info' | 'warn' | 'error' | 'debug', string]
	/** Network details read from the TV (MAC, subnet broadcast) after a successful connection. */
	network: [NetworkInfo]
	/** Values to persist so reboot detection survives Companion restarts. */
	persist: [{ bootId?: string; lastPower?: 'on' | 'off' }]
	/** Human-readable outcome of the power-state restore (for a variable). */
	restore: [string]
}

const UNREACHABLE = new Set(['CONNECT_FAILED', 'TIMEOUT', 'CLOSED'])
const isUnreachable = (e: unknown) => e instanceof AdbError && UNREACHABLE.has(e.code)

const sleep = async (ms: number) => new Promise((r) => setTimeout(r, ms))
const stamp = () => new Date().toLocaleString('sv-SE')

export class TvController extends EventEmitter<TvEvents> {
	readonly opts: TvOptions
	readonly client: AdbClient
	#snap: TvSnapshot = {
		connection: 'disconnected',
		power: 'unknown',
		model: '',
		manufacturer: '',
		androidVersion: '',
		lastError: '',
		waking: false,
	}
	#pollTimer: NodeJS.Timeout | undefined
	#polling = false
	#stopped = true
	#destroyed = false
	#infoFetched = false
	/** Boot id checked since the current ADB connection was made. */
	#bootChecked = false
	/** Pending power-state restore after a detected reboot. */
	#restore: { timer: NodeJS.Timeout | undefined; action: RestoreAction } | null = null
	#authFailedAt = 0

	constructor(opts: TvOptions) {
		super()
		this.opts = opts
		this.client = new AdbClient({
			host: opts.host,
			port: opts.port,
			key: opts.key,
			keyName: opts.keyName,
			connectTimeoutMs: opts.connectTimeoutMs ?? 4000,
			ioTimeoutMs: 8000,
			authTimeoutMs: opts.authTimeoutMs ?? 60000,
			debug: opts.debug,
		})
		this.client.on('state', (s) => this.#onAdbState(s))
	}

	get snapshot(): TvSnapshot {
		return { ...this.#snap }
	}

	#update(patch: Partial<TvSnapshot>): void {
		let changed = false
		for (const [k, v] of Object.entries(patch) as [keyof TvSnapshot, never][]) {
			if (this.#snap[k] !== v) {
				this.#snap[k] = v
				changed = true
			}
		}
		if (changed) this.emit('update', this.snapshot)
	}

	#onAdbState(s: AdbConnectionState): void {
		switch (s) {
			case 'connecting':
				// Only from a neutral state: re-tries while offline / unapproved must not make the status flap.
				if (this.#snap.connection === 'disconnected') this.#update({ connection: 'connecting' })
				break
			case 'awaiting_auth':
				this.#update({ connection: 'awaiting_approval', power: 'unknown' })
				this.emit('log', 'warn', 'Waiting for "Allow USB debugging" approval on the TV (tick "Always allow")')
				break
			case 'connected':
				this.#update({ connection: 'connected', lastError: '' })
				break
			case 'disconnected':
				// Keep offline/auth_failed etc.; plain drops show as disconnected until the next poll.
				if (this.#snap.connection === 'connected' || this.#snap.connection === 'connecting')
					this.#update({ connection: 'disconnected' })
				this.#infoFetched = false
				this.#bootChecked = false
				break
		}
	}

	start(): void {
		this.#stopped = false
		this.#schedulePoll(0)
	}

	stop(): void {
		this.#stopped = true
		this.#destroyed = true
		if (this.#restore?.timer) clearTimeout(this.#restore.timer)
		this.#restore = null
		if (this.#pollTimer) clearTimeout(this.#pollTimer)
		this.#pollTimer = undefined
		this.client.close()
	}

	#schedulePoll(delayMs: number): void {
		if (this.#stopped) return
		if (this.#pollTimer) clearTimeout(this.#pollTimer)
		const interval = this.opts.pollIntervalMs
		if (delayMs < 0) {
			if (interval <= 0) return
			delayMs = interval
		}
		this.#pollTimer = setTimeout(() => {
			this.#pollTimer = undefined
			void this.poll().finally(() => this.#schedulePoll(-1))
		}, delayMs)
	}

	/** Ask for a fresh poll soon (e.g. after a power command). */
	refreshSoon(delayMs = 1500): void {
		this.#schedulePoll(delayMs)
	}

	/** Query power state once. Never throws. */
	async poll(): Promise<void> {
		if (this.#polling || this.#snap.waking) return
		// Don't stack polls behind user commands, and don't spam the approval prompt.
		if (this.client.state === 'awaiting_auth' || this.client.queued > 0) return
		if (this.#snap.connection === 'auth_failed' && Date.now() - this.#authFailedAt < 120000) return
		this.#polling = true
		try {
			const checkBoot = !this.#bootChecked
			const out = await this.client.shell(
				checkBoot ? BOOT_ID_QUERY + '; echo @@; ' + POWER_QUERY : POWER_QUERY,
				this.opts.commandTimeoutMs ?? 8000,
			)
			const sep = checkBoot ? out.indexOf('@@') : -1
			const power = parsePowerState(sep >= 0 ? out.slice(sep + 2) : out)
			this.#update({ connection: 'connected', power, lastError: '' })
			if (checkBoot) {
				this.#bootChecked = true
				this.#onBootChecked(parseBootId(sep >= 0 ? out.slice(0, sep) : ''), power)
			}
			this.#trackPower(power)
			if (!this.#infoFetched) await this.#fetchInfo()
		} catch (e) {
			this.#handleError(e)
		} finally {
			this.#polling = false
			this.#maybeIdleClose()
		}
	}

	async #fetchInfo(): Promise<void> {
		const props = parseBanner(this.client.banner)
		let model = props['ro.product.model'] ?? ''
		let manufacturer = ''
		let androidVersion = ''
		try {
			const out = await this.client.shell(
				'getprop ro.product.manufacturer; getprop ro.product.model; getprop ro.build.version.release',
				this.opts.commandTimeoutMs ?? 8000,
			)
			const lines = out.split(/\r?\n/).map((l) => l.trim())
			manufacturer = lines[0] ?? ''
			model = lines[1] || model
			androidVersion = lines[2] ?? ''
			this.#infoFetched = true
		} catch (e) {
			this.emit('log', 'debug', `getprop failed: ${(e as Error).message}`)
		}
		this.#update({ model, manufacturer, androidVersion })
		try {
			const info = parseNetworkInfo(
				await this.client.shell(NETWORK_QUERY, this.opts.commandTimeoutMs ?? 8000),
				this.opts.host,
			)
			if (info) this.emit('network', info)
		} catch (e) {
			this.emit('log', 'debug', `network info failed: ${(e as Error).message}`)
		}
	}

	/** Update the Wake-on-LAN target (e.g. after the MAC was learned from the TV). */
	setWakeTarget(mac: string | undefined, addresses: string[]): void {
		this.opts.mac = mac
		this.opts.wolAddresses = addresses
	}

	#handleError(e: unknown): void {
		const err = e as Error
		const code = e instanceof AdbError ? e.code : undefined
		switch (code) {
			case 'CONNECT_FAILED':
			case 'TIMEOUT':
				this.#update({ connection: 'offline', power: 'offline', lastError: err.message })
				break
			case 'AUTH_REJECTED':
			case 'AUTH_TIMEOUT':
				this.#authFailedAt = Date.now()
				this.#update({ connection: 'auth_failed', power: 'unknown', lastError: err.message })
				break
			case 'TLS_REQUIRED':
			case 'PROTOCOL':
				this.#update({ connection: 'error', power: 'unknown', lastError: err.message })
				break
			case 'COMMAND_TIMEOUT':
				// The TV accepted the connection but was slow to finish (e.g. "input keyevent" while waking up).
				// That is not "offline": keep the power state and re-poll shortly.
				this.#update({ lastError: err.message })
				this.refreshSoon(1500)
				break
			default:
				this.#update({ connection: 'disconnected', lastError: err.message })
		}
	}

	#maybeIdleClose(): void {
		if (!this.opts.keepConnected && this.client.queued === 0 && this.client.state === 'connected') {
			this.client.close()
		}
	}

	/** Run a shell command on the TV and return its output. Updates status on failure and rethrows. */
	async shell(command: string, timeoutMs?: number): Promise<string> {
		try {
			const out = await this.client.shell(command, timeoutMs ?? this.opts.commandTimeoutMs ?? 8000)
			if (this.#snap.connection !== 'connected') this.#update({ connection: 'connected', lastError: '' })
			return out
		} catch (e) {
			this.#handleError(e)
			throw e
		} finally {
			this.#maybeIdleClose()
		}
	}

	async key(code: number | string): Promise<void> {
		// Generous timeout: some TVs only return from "input keyevent" once they finished waking up.
		await this.shell(typeof code === 'number' ? keyeventCommand(code) : `input keyevent ${code}`, 20000)
	}

	/** Called once per ADB connection with the TV's boot id: detects reboots and schedules a restore. */
	#onBootChecked(bootId: string, power: PowerState): void {
		const d = decideRestore({
			enabled: this.opts.restoreEnabled ?? false,
			previousBootId: this.opts.knownBootId ?? '',
			currentBootId: bootId,
			lastKnown: this.opts.lastKnownPower ?? '',
			current: power,
		})
		this.emit('log', 'debug', 'boot check: ' + d.reason)
		if (bootId && bootId !== this.opts.knownBootId) {
			this.opts.knownBootId = bootId
			this.emit('persist', { bootId })
		}
		if (d.rebooted)
			this.emit('log', 'info', 'TV rebooted since it was last reachable (power loss or restart): ' + d.reason)
		if (d.action !== 'none') this.#scheduleRestore(d.action)
	}

	/** Remember the power state observed while reachable (Companion commands and remote control alike). */
	#trackPower(power: PowerState): void {
		if (this.#restore || this.#snap.waking) return
		if ((power === 'on' || power === 'off') && power !== this.opts.lastKnownPower) {
			this.opts.lastKnownPower = power
			this.emit('persist', { lastPower: power })
		}
	}

	#scheduleRestore(action: RestoreAction): void {
		const target = action === 'power_off' ? 'off' : 'on'
		const delay = Math.max(0, this.opts.restoreDelayMs ?? 15000)
		const secs = Math.round(delay / 1000)
		this.emit('log', 'info', 'TV rebooted after power loss; restoring previous state: ' + target + ' in ' + secs + ' s')
		this.emit('restore', stamp() + ' rebooted; restoring ' + target + ' in ' + secs + ' s')
		const entry: { timer: NodeJS.Timeout | undefined; action: RestoreAction } = { timer: undefined, action }
		entry.timer = setTimeout(() => void this.#runRestore(entry), delay)
		this.#restore = entry
	}

	async #runRestore(entry: { action: RestoreAction }): Promise<void> {
		const target = entry.action === 'power_off' ? 'off' : 'on'
		try {
			if (entry.action === 'power_off') await this.#sleepAndVerify()
			else await this.#wakeAndVerify()
			if (this.#restore !== entry) return // cancelled while running
			this.emit('log', 'info', 'Restored previous power state after reboot: ' + target)
			this.emit('restore', stamp() + ' rebooted; restored ' + target)
		} catch (e) {
			if (this.#restore !== entry) return
			this.emit('log', 'warn', 'Restoring power state (' + target + ') failed: ' + (e as Error).message)
			this.emit('restore', stamp() + ' rebooted; restore to ' + target + ' failed: ' + (e as Error).message)
		} finally {
			if (this.#restore === entry) this.#restore = null
		}
	}

	/** Cancel a pending restore because someone used a power action: never fight the user. */
	#cancelRestore(reason: string): void {
		const r = this.#restore
		if (!r) return
		if (r.timer) clearTimeout(r.timer)
		this.#restore = null
		this.emit('log', 'info', 'Power-state restore cancelled: ' + reason)
		this.emit('restore', stamp() + ' restore cancelled: ' + reason)
	}

	/** True while a restore is scheduled or running. */
	get restorePending(): boolean {
		return this.#restore !== null
	}

	/** Send KEYCODE_SLEEP until dumpsys power reports the TV asleep (2 attempts). */
	async #sleepAndVerify(): Promise<void> {
		let state: PowerState = 'unknown'
		for (let attempt = 1; attempt <= 2; attempt++) {
			try {
				await this.key(KEYCODE.SLEEP)
			} catch (e) {
				if (!(e instanceof AdbError && e.code === 'COMMAND_TIMEOUT')) throw e
			}
			const until = Date.now() + 8000
			while (Date.now() < until) {
				await sleep(1500)
				try {
					state = parsePowerState(await this.client.shell(POWER_QUERY, 8000))
				} catch (e) {
					if (isUnreachable(e)) {
						state = 'offline' // some TVs drop off the network once asleep: that is "off"
						break
					}
					if (!(e instanceof AdbError && e.code === 'COMMAND_TIMEOUT')) throw e
					continue
				}
				if (state === 'off') break
			}
			if (state === 'off' || state === 'offline') {
				this.#update({ power: state })
				this.refreshSoon(2000)
				return
			}
		}
		throw new Error('TV accepted KEYCODE_SLEEP but still reports power state "' + state + '"')
	}

	async powerOff(): Promise<void> {
		this.#cancelRestore('Power Off pressed')
		try {
			await this.key(KEYCODE.SLEEP)
		} catch (e) {
			if (!isUnreachable(e)) throw e
			// Nothing to switch off: the TV is in deep standby or has no power.
			this.emit(
				'log',
				'info',
				`Power Off: TV is unreachable (${(e as Error).message}); it is already off or has no power`,
			)
			this.#update({ power: 'offline' })
			return
		}
		this.#update({ power: 'off' })
		this.refreshSoon(2000)
	}

	async powerToggle(): Promise<void> {
		this.#cancelRestore('Power Toggle pressed')
		if (this.#snap.power === 'offline' || this.#snap.connection === 'offline') {
			return this.powerOn()
		}
		const before = this.#snap.power
		await this.key(KEYCODE.POWER)
		// Optimistic: some TVs stall ADB for several seconds while changing state; the next poll confirms.
		if (before === 'on') this.#update({ power: 'off' })
		else if (before === 'off') this.#update({ power: 'on' })
		this.refreshSoon(2000)
	}

	/**
	 * Power on.
	 * - TV answers ADB: send KEYCODE_WAKEUP and verify it reports Awake (retrying the key if not).
	 * - TV unreachable and a MAC is known: Wake-on-LAN bursts every 5 s, retry ADB for the wake window
	 *   (cold boots after a power cut can take 30-90 s), then wake + verify.
	 * - TV unreachable and no MAC: fail with an explanation.
	 */
	async powerOn(): Promise<void> {
		this.#cancelRestore('Power On pressed')
		if (this.#wakeInFlight) {
			this.emit('log', 'info', 'Power On: a Wake-on-LAN attempt is already in progress')
			return this.#wakeInFlight.catch(() => undefined)
		}
		if (this.#snap.connection !== 'offline') {
			try {
				await this.#wakeAndVerify()
				return
			} catch (e) {
				if (!isUnreachable(e)) throw e
			}
		}
		if (!this.opts.mac) {
			// One quick direct attempt in case the TV came back since the last poll.
			try {
				await this.#wakeAndVerify()
				return
			} catch (e) {
				if (!isUnreachable(e)) throw e
				throw new Error(
					`TV is unreachable (${(e as Error).message}) and no MAC address is known, so Wake-on-LAN cannot be used. ` +
						'Switch the TV on once with its remote: the module then learns its MAC automatically.',
					{ cause: e },
				)
			}
		}
		this.#wakeInFlight = this.#wakeViaWol().finally(() => {
			this.#wakeInFlight = null
		})
		return this.#wakeInFlight
	}

	/** The running Wake-on-LAN attempt, shared by Power On / Toggle presses made while it runs. */
	#wakeInFlight: Promise<void> | null = null

	/** Send KEYCODE_WAKEUP until dumpsys power reports the TV awake (3 attempts). */
	async #wakeAndVerify(): Promise<void> {
		let state: PowerState = 'unknown'
		for (let attempt = 1; attempt <= 3; attempt++) {
			try {
				await this.key(KEYCODE.WAKEUP)
			} catch (e) {
				// A slow "input keyevent" while the TV is waking is fine; anything else is a real failure.
				if (!(e instanceof AdbError && e.code === 'COMMAND_TIMEOUT')) throw e
			}
			const until = Date.now() + 6000
			while (Date.now() < until) {
				await sleep(1500)
				try {
					state = parsePowerState(await this.client.shell(POWER_QUERY, 8000))
				} catch (e) {
					if (!(e instanceof AdbError && e.code === 'COMMAND_TIMEOUT')) throw e
					continue
				}
				if (state === 'on') {
					this.#update({ power: 'on', connection: 'connected', lastError: '' })
					if (attempt > 1) this.emit('log', 'info', `TV awake after ${attempt} wake attempts`)
					this.refreshSoon(2000)
					return
				}
			}
			this.emit('log', 'warn', `TV still reports "${state}" after KEYCODE_WAKEUP (attempt ${attempt}/3)`)
		}
		this.refreshSoon(1000)
		throw new Error(`TV accepted KEYCODE_WAKEUP but still reports power state "${state}"`)
	}

	async #wakeViaWol(): Promise<void> {
		const mac = this.opts.mac as string
		const addresses = this.opts.wolAddresses?.length ? this.opts.wolAddresses : ['255.255.255.255']
		const port = this.opts.wolPort || 9
		const windowMs = this.opts.wakeWindowMs ?? 120000
		const started = Date.now()
		this.#update({ waking: true })
		try {
			this.emit(
				'log',
				'info',
				`TV unreachable: sending Wake-on-LAN to ${mac} via ${addresses.join(', ')} (port ${port}), waiting up to ${Math.round(windowMs / 1000)} s`,
			)
			const deadline = started + windowMs
			let lastErr: unknown
			let nextWol = 0
			while (Date.now() < deadline && !this.#destroyed) {
				if (Date.now() >= nextWol) {
					for (const address of addresses) {
						await sendWol({ mac, address, port, count: this.opts.wolCount ?? 5, intervalMs: 100 }).catch((e) =>
							this.emit('log', 'warn', `Wake-on-LAN to ${address} failed: ${(e as Error).message}`),
						)
					}
					nextWol = Date.now() + 5000 // repeat the burst every 5 s while waiting
				}
				try {
					await this.client.connect()
				} catch (e) {
					lastErr = e
					if (e instanceof AdbError && (e.code === 'AUTH_REJECTED' || e.code === 'AUTH_TIMEOUT')) throw e
					await sleep(1000)
					continue
				}
				this.emit('log', 'info', `TV answered ADB ${Math.round((Date.now() - started) / 1000)} s after Wake-on-LAN`)
				await this.#wakeAndVerify()
				return
			}
			this.#update({ connection: 'offline', power: 'offline' })
			throw new Error(
				`TV did not come online within ${Math.round(windowMs / 1000)} s after Wake-on-LAN to ${mac}` +
					(lastErr ? ` (${(lastErr as Error).message})` : '') +
					'. If the TV lost mains power it may ignore Wake-on-LAN until it has been switched on once: check its network standby / Wake-on-LAN settings.',
			)
		} finally {
			this.#update({ waking: false })
			this.refreshSoon(2000)
		}
	}

	/** HDMI port -> TV input ID, discovered once per controller from "dumpsys tv_input". */
	#hdmiMap: Record<number, string> | null = null

	async discoverHdmiInputs(): Promise<Record<number, string>> {
		const out = await this.shell('dumpsys tv_input', 15000)
		this.#hdmiMap = parseHdmiInputMap(out)
		return this.#hdmiMap
	}

	async selectInput(method: HdmiMethod, input: number, value?: string): Promise<void> {
		let v = value
		if (method === 'auto' && !v?.trim()) {
			if (!this.#hdmiMap) {
				try {
					const map = await this.discoverHdmiInputs()
					this.emit('log', 'info', `HDMI inputs discovered: ${JSON.stringify(map)}`)
				} catch (e) {
					this.emit('log', 'warn', `HDMI input discovery failed, using key events: ${(e as Error).message}`)
				}
			}
			v = this.#hdmiMap?.[input]
		}
		await this.shell(hdmiCommand(method, input, v))
	}
}
