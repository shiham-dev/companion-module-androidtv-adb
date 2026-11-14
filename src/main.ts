import { createHash, type KeyObject } from 'node:crypto'
import { InstanceBase, InstanceStatus, runEntrypoint, type SomeCompanionConfigField } from '@companion-module/base'
import { getActions } from './actions.js'
import { androidPublicKey, generateAdbKeyPem, loadPrivateKey, normalizePem } from './adb/keys.js'
import { getConfigFields, withDefaults, type ModuleConfig } from './config.js'
import { getFeedbacks } from './feedbacks.js'
import { getPresets } from './presets.js'
import { TvController, type TvSnapshot } from './tv.js'
import { UpgradeScripts } from './upgrades.js'
import { VARIABLES } from './variables.js'
import { parseMac, wolTargets } from './wol.js'
import type { NetworkInfo } from './android.js'

/** MD5 fingerprint of the public key blob, the same value Android shows in the "Allow USB debugging?" dialog. */
export function keyFingerprint(key: KeyObject, name: string): string {
	const b64 = androidPublicKey(key, name).toString('utf8').split(' ')[0]
	const md5 = createHash('md5').update(Buffer.from(b64, 'base64')).digest('hex').toUpperCase()
	return md5.match(/../g)?.join(':') ?? md5
}

export class ModuleInstance extends InstanceBase<ModuleConfig> {
	config: ModuleConfig = withDefaults(undefined)
	tv: TvController | null = null
	#key: KeyObject | null = null
	#fingerprint = ''

	async init(config: ModuleConfig): Promise<void> {
		this.setActionDefinitions(getActions(this))
		this.setFeedbackDefinitions(getFeedbacks(this))
		this.setVariableDefinitions(VARIABLES)
		await this.#apply(config)
	}

	async destroy(): Promise<void> {
		this.tv?.stop()
		this.tv = null
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		await this.#apply(config)
	}

	getConfigFields(): SomeCompanionConfigField[] {
		const info = this.#key
			? `Fingerprint shown on the TV approval dialog: ${this.#fingerprint} (key name "${this.config.key_name}"). ` +
				"The key is stored in this connection's config, so the approval survives restarts; exporting the config exports the key."
			: 'A new ADB key is generated automatically when the connection starts.'
		return getConfigFields(info)
	}

	async #ensureKey(): Promise<boolean> {
		const cfg = this.config
		let pem = cfg.adb_private_key.trim()
		let changed = false
		if (cfg.regenerate_key || !pem) {
			this.log('info', cfg.regenerate_key ? 'Generating a new ADB key (requested)' : 'Generating ADB key (first run)')
			pem = await generateAdbKeyPem()
			changed = true
		}
		try {
			this.#key = loadPrivateKey(pem)
			const normalized = normalizePem(pem)
			if (normalized !== cfg.adb_private_key) changed = true
			pem = normalized
		} catch (e) {
			this.#key = null
			this.updateStatus(InstanceStatus.BadConfig, `Invalid ADB private key: ${(e as Error).message}`)
			return false
		}
		this.#fingerprint = keyFingerprint(this.#key, cfg.key_name)
		if (changed || cfg.regenerate_key) {
			this.config = { ...cfg, adb_private_key: pem, regenerate_key: false }
			this.saveConfig(this.config)
		}
		this.setVariableValues({ adb_key_fingerprint: this.#fingerprint })
		return true
	}

	async #apply(raw: ModuleConfig): Promise<void> {
		this.tv?.stop()
		this.tv = null
		this.config = withDefaults(raw)
		this.setPresetDefinitions(getPresets(this.label))

		if (!(await this.#ensureKey()) || !this.#key) return
		const cfg = this.config
		if (!cfg.host) {
			this.#publish(null)
			this.updateStatus(InstanceStatus.BadConfig, 'Enter the TV IP address')
			return
		}
		let mac: string | undefined
		if (cfg.mac) {
			try {
				parseMac(cfg.mac)
				mac = cfg.mac
			} catch (e) {
				this.log('warn', `${(e as Error).message}; Wake-on-LAN disabled`)
			}
		}

		const tv = new TvController({
			host: cfg.host,
			port: cfg.port,
			key: this.#key,
			keyName: cfg.key_name,
			mac,
			wolAddresses: wolTargets(cfg.host, cfg.wol_address),
			wolPort: cfg.wol_port,
			wolCount: cfg.wol_count,
			wakeWindowMs: cfg.wake_window * 1000,
			pollIntervalMs: Math.max(0, cfg.poll_interval) === 0 ? 0 : Math.max(1, cfg.poll_interval) * 1000,
			keepConnected: cfg.keep_connected,
			debug: (m) => this.log('debug', m),
		})
		tv.on('update', (s) => this.#publish(s))
		tv.on('log', (level, msg) => this.log(level, msg))
		tv.on('network', (info) => this.#onNetwork(info))
		this.setVariableValues({ mac_address: mac ?? '', wol_targets: wolTargets(cfg.host, cfg.wol_address).join(', ') })
		this.tv = tv
		this.#publish(tv.snapshot)
		this.updateStatus(InstanceStatus.Connecting, `Connecting to ${cfg.host}:${cfg.port}`)
		tv.start()
	}

	/** Learn the TV's MAC and subnet broadcast so Wake-on-LAN works without manual setup. */
	#onNetwork(info: NetworkInfo): void {
		const cfg = this.config
		const patch: Partial<ModuleConfig> = {}
		if (!cfg.mac && info.mac) patch.mac = info.mac
		if (!cfg.wol_address && info.broadcast) patch.wol_address = info.broadcast
		if (/^wlan/.test(info.iface)) {
			this.log(
				'warn',
				`TV is on Wi-Fi (${info.iface}): Wake-on-LAN over Wi-Fi is unreliable; a wired connection is recommended`,
			)
		}
		if (Object.keys(patch).length) {
			this.config = { ...cfg, ...patch }
			this.saveConfig(this.config)
			this.log(
				'info',
				`Learned from the TV (${info.iface} ${info.ip}/${info.prefix}): ` +
					[patch.mac && `MAC ${patch.mac}`, patch.wol_address && `WoL broadcast ${patch.wol_address}`]
						.filter(Boolean)
						.join(', ') +
					' (saved to the connection config)',
			)
		}
		const targets = wolTargets(this.config.host, this.config.wol_address)
		this.tv?.setWakeTarget(this.config.mac || undefined, targets)
		this.setVariableValues({ mac_address: this.config.mac, wol_targets: targets.join(', ') })
	}

	#publish(s: TvSnapshot | null): void {
		if (!s) {
			this.setVariableValues({ power_state: 'unknown', connection_status: 'disconnected' })
			this.checkFeedbacks()
			return
		}
		this.setVariableValues({
			power_state: s.waking ? 'waking' : s.power,
			connection_status: s.connection,
			model: s.model,
			manufacturer: s.manufacturer,
			android_version: s.androidVersion,
			last_error: s.lastError,
		})
		this.checkFeedbacks('power_state', 'connection_state', 'waking')
		this.#updateStatusFrom(s)
	}

	#updateStatusFrom(s: TvSnapshot): void {
		const where = `${this.config.host}:${this.config.port}`
		if (s.waking) {
			this.updateStatus(InstanceStatus.Connecting, 'Waking TV (Wake-on-LAN)')
			return
		}
		switch (s.connection) {
			case 'connected':
				this.updateStatus(InstanceStatus.Ok, s.model ? `${s.model} (${s.power})` : null)
				break
			case 'connecting':
				this.updateStatus(InstanceStatus.Connecting, `Connecting to ${where}`)
				break
			case 'awaiting_approval':
				this.updateStatus(InstanceStatus.UnknownWarning, 'Awaiting approval on TV: tick "Always allow" and press Allow')
				break
			case 'offline':
				this.updateStatus(
					InstanceStatus.ConnectionFailure,
					this.config.mac
						? `TV offline / unreachable (${where}); Power On will use Wake-on-LAN`
						: `TV offline / unreachable (${where}); no MAC known, so Power On cannot wake it (switch it on once with the remote)`,
				)
				break
			case 'auth_failed':
				this.updateStatus(InstanceStatus.AuthenticationFailure, s.lastError || 'ADB key not approved on the TV')
				break
			case 'error':
				this.updateStatus(InstanceStatus.UnknownError, s.lastError)
				break
			case 'disconnected':
				this.updateStatus(InstanceStatus.Connecting, s.lastError ? `Reconnecting (${s.lastError})` : 'Disconnected')
				break
		}
	}
}

runEntrypoint(ModuleInstance, UpgradeScripts)
