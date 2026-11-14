import { Regex, type SomeCompanionConfigField } from '@companion-module/base'
import type { HdmiMethod } from './android.js'

export interface ModuleConfig {
	host: string
	port: number
	mac: string
	wol_address: string
	wol_port: number
	wol_count: number
	wake_window: number
	poll_interval: number
	keep_connected: boolean
	hdmi_method: HdmiMethod
	hdmi1_value: string
	hdmi2_value: string
	hdmi3_value: string
	hdmi4_value: string
	key_name: string
	show_key: boolean
	regenerate_key: boolean
	/** PEM private key, generated on first run and persisted with saveConfig. */
	adb_private_key: string
}

export const DEFAULT_KEY_NAME = 'companion-androidtv-adb'

export function withDefaults(c: Partial<ModuleConfig> | undefined): ModuleConfig {
	const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
	return {
		host: (c?.host ?? '').trim(),
		port: n(c?.port, 5555),
		mac: (c?.mac ?? '').trim(),
		wol_address: (c?.wol_address ?? '').trim(),
		wol_port: n(c?.wol_port, 9),
		wol_count: n(c?.wol_count, 5),
		wake_window: n(c?.wake_window, 15),
		poll_interval: n(c?.poll_interval, 5),
		keep_connected: c?.keep_connected ?? true,
		hdmi_method: c?.hdmi_method ?? 'auto',
		hdmi1_value: c?.hdmi1_value ?? '',
		hdmi2_value: c?.hdmi2_value ?? '',
		hdmi3_value: c?.hdmi3_value ?? '',
		hdmi4_value: c?.hdmi4_value ?? '',
		key_name: (c?.key_name ?? '').trim() || DEFAULT_KEY_NAME,
		show_key: c?.show_key ?? false,
		regenerate_key: c?.regenerate_key ?? false,
		adb_private_key: c?.adb_private_key ?? '',
	}
}

export function getConfigFields(publicKeyInfo: string): SomeCompanionConfigField[] {
	return [
		{
			type: 'static-text',
			id: 'info',
			width: 12,
			label: 'Android TV over ADB',
			value:
				'Controls one Android / Google TV over the network with ADB (TCP 5555). On the TV enable Developer options → USB/network debugging. ' +
				'On first connect the TV asks "Allow USB debugging?" — tick "Always allow from this computer" and press Allow.',
		},
		{
			type: 'textinput',
			id: 'host',
			label: 'TV IP address / hostname',
			width: 8,
			regex: Regex.SOMETHING,
			default: '',
		},
		{
			type: 'number',
			id: 'port',
			label: 'ADB port',
			width: 4,
			min: 1,
			max: 65535,
			default: 5555,
		},
		{
			type: 'textinput',
			id: 'mac',
			label: 'MAC address for Wake-on-LAN (optional)',
			tooltip: 'e.g. AA:BB:CC:DD:EE:FF. Leave empty to disable Wake-on-LAN.',
			width: 6,
			default: '',
		},
		{
			type: 'textinput',
			id: 'wol_address',
			label: 'WoL broadcast address',
			tooltip:
				'Use the directed broadcast of the TV subnet (e.g. 192.168.20.255) when the TV is on another subnet. Default 255.255.255.255 (local subnet only).',
			width: 4,
			default: '',
		},
		{
			type: 'number',
			id: 'wol_port',
			label: 'WoL port',
			width: 2,
			min: 1,
			max: 65535,
			default: 9,
		},
		{
			type: 'number',
			id: 'wol_count',
			label: 'WoL packets per burst',
			width: 4,
			min: 1,
			max: 20,
			default: 5,
		},
		{
			type: 'number',
			id: 'wake_window',
			label: 'Wake wait (s): retry ADB after WoL for',
			width: 4,
			min: 3,
			max: 120,
			default: 15,
		},
		{
			type: 'number',
			id: 'poll_interval',
			label: 'Status poll interval (s, 0 = off)',
			width: 4,
			min: 0,
			max: 3600,
			default: 5,
		},
		{
			type: 'checkbox',
			id: 'keep_connected',
			label: 'Keep ADB connection open',
			tooltip:
				'Faster and lighter on the TV. Untick if another ADB client (e.g. a control system relay) must share the TV: many TVs accept only one ADB client at a time.',
			width: 4,
			default: true,
		},
		{
			type: 'dropdown',
			id: 'hdmi_method',
			label: 'HDMI switching method',
			width: 4,
			default: 'auto',
			choices: [
				{ id: 'auto', label: 'Auto (discover TV inputs, fall back to key event)' },
				{ id: 'keycode', label: 'Key event (KEYCODE_TV_INPUT_HDMI_1..4)' },
				{ id: 'passthrough', label: 'TV input passthrough intent (input ID)' },
				{ id: 'custom', label: 'Custom shell command per input' },
			],
		},
		{
			type: 'static-text',
			id: 'hdmi_help',
			width: 8,
			label: 'HDMI input values',
			value:
				'Auto: leave empty to discover the inputs from the TV, or enter an input ID to override a port. Passthrough: enter the TV input ID per HDMI port, e.g. com.mediatek.tvinput/.hdmi.HDMIInputService/HW5 (use the "List TV inputs" action and check the log / tv_inputs variable). Custom: enter a full shell command.',
			isVisibleExpression: `$(options:hdmi_method) != 'keycode'`,
		},
		...[1, 2, 3, 4].map((i): SomeCompanionConfigField => ({
			type: 'textinput',
			id: `hdmi${i}_value`,
			label: `HDMI ${i} input ID / command`,
			width: 6,
			default: '',
			isVisibleExpression: `$(options:hdmi_method) != 'keycode'`,
		})),
		{
			type: 'textinput',
			id: 'key_name',
			label: 'ADB key name (shown on the TV approval dialog)',
			width: 6,
			default: DEFAULT_KEY_NAME,
		},
		{
			type: 'static-text',
			id: 'key_info',
			width: 12,
			label: 'ADB key',
			value: publicKeyInfo,
		},
		{
			type: 'checkbox',
			id: 'show_key',
			label: 'Show / edit ADB private key (advanced)',
			width: 6,
			default: false,
		},
		{
			type: 'textinput',
			id: 'adb_private_key',
			label: 'ADB private key (PEM). Generated automatically; paste an existing adbkey to reuse an approval.',
			width: 12,
			default: '',
			isVisibleExpression: '$(options:show_key)',
		},
		{
			type: 'checkbox',
			id: 'regenerate_key',
			label: 'Generate a NEW key on save (the TV must approve it again)',
			width: 12,
			default: false,
			isVisibleExpression: '$(options:show_key)',
		},
	]
}
