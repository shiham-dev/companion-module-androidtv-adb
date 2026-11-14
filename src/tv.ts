/**
 * Companion-independent TV controller: owns the ADB client, polls power state,
 * implements power on (with Wake-on-LAN), off, toggle, inputs and keys.
 */
import { EventEmitter } from 'node:events'
import type { KeyObject } from 'node:crypto'
import { AdbClient, AdbError, type AdbConnectionState } from './adb/client.js'
import {
	KEYCODE,
	POWER_QUERY,
	hdmiCommand,
	keyeventCommand,
	parseHdmiInputMap,
	parseBanner,
	parsePowerState,
	type HdmiMethod,
	type PowerState,
} from './android.js'
import { sendWol } from './wol.js'

export interface TvOptions {
	host: string
	port: number
	key: KeyObject
	keyName: string
	mac?: string
	wolAddress?: string
	wolPort?: number
	wolCount?: number
	/** After WoL, keep retrying ADB for this long before giving up. */
	wakeWindowMs?: number
	/** Power-state poll interval (0 disables polling). */
	pollIntervalMs: number
	/** Keep the ADB connection open between commands (faster; occupies the TV's single ADB slot). */
	keepConnected: boolean
	connectTimeoutMs?: number
	commandTimeoutMs?: number
	authTimeoutMs?: number
	debug?: (msg: string) => void
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
}

const sleep = async (ms: number) => new Promise((r) => setTimeout(r, ms))

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
	#infoFetched = false
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
				break
		}
	}

	start(): void {
		this.#stopped = false
		this.#schedulePoll(0)
	}

	stop(): void {
		this.#stopped = true
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
			const out = await this.client.shell(POWER_QUERY, this.opts.commandTimeoutMs ?? 8000)
			const power = parsePowerState(out)
			this.#update({ connection: 'connected', power, lastError: '' })
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

	async powerOff(): Promise<void> {
		await this.key(KEYCODE.SLEEP)
		this.#update({ power: 'off' })
		this.refreshSoon(2000)
	}

	async powerToggle(): Promise<void> {
		if ((this.#snap.power === 'offline' || this.#snap.connection === 'offline') && this.opts.mac) {
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
	 * Power on: if ADB answers, send KEYCODE_WAKEUP. Otherwise, if a MAC is configured, send
	 * Wake-on-LAN packets and keep retrying ADB for the wake window, then send KEYCODE_WAKEUP.
	 */
	async powerOn(): Promise<void> {
		if (this.#snap.connection !== 'offline' || !this.opts.mac) {
			try {
				await this.key(KEYCODE.WAKEUP)
				this.#update({ power: 'on' })
				this.refreshSoon(2000)
				return
			} catch (e) {
				if (!(e instanceof AdbError) || !['CONNECT_FAILED', 'TIMEOUT', 'CLOSED'].includes(e.code) || !this.opts.mac)
					throw e
			}
		}
		await this.#wakeViaWol()
	}

	async #wakeViaWol(): Promise<void> {
		const mac = this.opts.mac as string
		const address = this.opts.wolAddress || '255.255.255.255'
		const port = this.opts.wolPort || 9
		const windowMs = this.opts.wakeWindowMs ?? 15000
		this.#update({ waking: true })
		try {
			this.emit('log', 'info', `TV offline: sending Wake-on-LAN to ${mac} via ${address}:${port}`)
			const deadline = Date.now() + windowMs
			let lastErr: unknown
			let nextWol = 0
			while (Date.now() < deadline && !this.#stopped) {
				if (Date.now() >= nextWol) {
					await sendWol({ mac, address, port, count: this.opts.wolCount ?? 5, intervalMs: 100 }).catch((e) =>
						this.emit('log', 'warn', `Wake-on-LAN send failed: ${(e as Error).message}`),
					)
					nextWol = Date.now() + 5000 // repeat the burst every 5 s while waiting
				}
				try {
					await this.client.connect()
					await this.key(KEYCODE.WAKEUP)
					this.#update({ power: 'on', connection: 'connected', lastError: '' })
					this.emit('log', 'info', 'TV woke up and accepted KEYCODE_WAKEUP')
					return
				} catch (e) {
					lastErr = e
					if (e instanceof AdbError && (e.code === 'AUTH_REJECTED' || e.code === 'AUTH_TIMEOUT')) throw e
					await sleep(1000)
				}
			}
			this.#update({ connection: 'offline', power: 'offline' })
			throw new Error(
				`TV did not come online within ${Math.round(windowMs / 1000)} s after Wake-on-LAN` +
					(lastErr ? ` (${(lastErr as Error).message})` : ''),
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
