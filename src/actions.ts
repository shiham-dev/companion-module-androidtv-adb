import type { CompanionActionDefinitions, CompanionOptionValues } from '@companion-module/base'
import { KEYCODE, normalizeKeycode, parseHdmiInputMap, parseTvInputIds, type HdmiMethod } from './android.js'
import type { ModuleInstance } from './main.js'

const INPUT_CHOICES = [1, 2, 3, 4].map((i) => ({ id: i, label: `HDMI ${i}` }))

export function getActions(self: ModuleInstance): CompanionActionDefinitions {
	/**
	 * Start the work and return at once: Companion times out action calls that take long, and
	 * power-on with Wake-on-LAN or a TV that is slow to answer while waking can take many seconds.
	 * Commands still reach the TV in order because the ADB client queues them synchronously.
	 */
	const guard = async (what: string, fn: () => Promise<void>): Promise<void> => {
		fn().catch((e) => self.log('error', `${what} failed: ${(e as Error).message}`))
		return Promise.resolve()
	}
	const tv = () => {
		if (!self.tv) throw new Error('module is not configured')
		return self.tv
	}
	const key = async (name: string, code: number) => guard(name, async () => tv().key(code))

	return {
		power_on: {
			name: 'Power: On (wake, with Wake-on-LAN if offline)',
			options: [],
			callback: async () => guard('Power on', async () => tv().powerOn()),
		},
		power_off: {
			name: 'Power: Off (sleep)',
			options: [],
			callback: async () => guard('Power off', async () => tv().powerOff()),
		},
		power_toggle: {
			name: 'Power: Toggle',
			options: [],
			callback: async () => guard('Power toggle', async () => tv().powerToggle()),
		},
		hdmi_input: {
			name: 'Input: Select HDMI',
			options: [
				{ type: 'dropdown', id: 'input', label: 'Input', default: 1, choices: INPUT_CHOICES },
				{
					type: 'dropdown',
					id: 'method',
					label: 'Method',
					default: 'config',
					choices: [
						{ id: 'config', label: 'Use connection setting' },
						{ id: 'auto', label: 'Auto (discover TV inputs)' },
						{ id: 'keycode', label: 'Key event (KEYCODE_TV_INPUT_HDMI_n)' },
						{ id: 'passthrough', label: 'Passthrough intent (TV input ID)' },
						{ id: 'custom', label: 'Custom shell command' },
					],
				},
				{
					type: 'textinput',
					id: 'value',
					label: 'Input ID / command (empty = use connection setting for this HDMI)',
					default: '',
					useVariables: true,
					isVisibleExpression: `$(options:method) == 'passthrough' || $(options:method) == 'custom' || $(options:method) == 'config'`,
				},
			],
			callback: async (action) =>
				guard('Input select', async () => {
					const input = Number(action.options.input) || 1
					const { method, value } = await resolveInput(self, action.options, input)
					await tv().selectInput(method, input, value)
					self.setVariableValues({ last_input: `HDMI ${input}` })
				}),
		},
		volume_up: {
			name: 'Volume: Up',
			options: [],
			callback: async () => key('Volume up', KEYCODE.VOLUME_UP),
		},
		volume_down: {
			name: 'Volume: Down',
			options: [],
			callback: async () => key('Volume down', KEYCODE.VOLUME_DOWN),
		},
		volume_mute: {
			name: 'Volume: Mute (toggle)',
			options: [],
			callback: async () => key('Mute', KEYCODE.VOLUME_MUTE),
		},
		send_key: {
			name: 'Send key code',
			description: 'Sends "input keyevent <code>". Accepts a number (e.g. 3) or a name (e.g. KEYCODE_HOME or HOME).',
			options: [{ type: 'textinput', id: 'key', label: 'Key code', default: 'KEYCODE_HOME', useVariables: true }],
			callback: async (action) =>
				guard('Send key', async () => {
					const raw = await self.parseVariablesInString(String(action.options.key ?? ''))
					await tv().key(normalizeKeycode(raw))
				}),
		},
		shell: {
			name: 'Run shell command',
			description: 'Runs an arbitrary "adb shell" command. Output goes to the last_shell_output variable.',
			options: [
				{
					type: 'textinput',
					id: 'command',
					label: 'Command',
					default: 'input keyevent KEYCODE_HOME',
					useVariables: true,
				},
			],
			callback: async (action) =>
				guard('Shell command', async () => {
					const cmd = (await self.parseVariablesInString(String(action.options.command ?? ''))).trim()
					if (!cmd) throw new Error('empty command')
					const out = await tv().shell(cmd, 15000)
					self.setVariableValues({ last_shell_output: out.trim().slice(0, 1000) })
					self.log('info', `shell "${cmd}" → ${out.trim().slice(0, 500) || '(no output)'}`)
				}),
		},
		list_inputs: {
			name: 'List TV inputs (for passthrough IDs)',
			description: 'Runs "dumpsys tv_input" and puts the TV input IDs in the tv_inputs variable and the log.',
			options: [],
			callback: async () =>
				guard('List TV inputs', async () => {
					const out = await tv().shell('dumpsys tv_input', 15000)
					const ids = parseTvInputIds(out)
					const hdmi = parseHdmiInputMap(out)
					const ports = Object.entries(hdmi).map(([port, id]) => `HDMI${port}=${id}`)
					const summary = [...ports, ...(ports.length ? [] : ids)].join(', ')
					self.setVariableValues({ tv_inputs: summary })
					self.log(
						'info',
						ids.length
							? `TV inputs: ${ids.join(' | ')}; HDMI ports: ${ports.join(' | ') || 'none found'}`
							: 'No TV input IDs found in dumpsys tv_input',
					)
				}),
		},
		refresh: {
			name: 'Refresh status now',
			options: [],
			callback: async () => {
				await self.tv?.poll()
			},
		},
	}
}

async function resolveInput(
	self: ModuleInstance,
	options: CompanionOptionValues,
	input: number,
): Promise<{ method: HdmiMethod; value: string }> {
	const cfg = self.config
	const configured = String(cfg[`hdmi${input}_value` as 'hdmi1_value'] ?? '')
	const override = (await self.parseVariablesInString(String(options.value ?? ''))).trim()
	const opt = String(options.method ?? 'config')
	const method: HdmiMethod =
		opt === 'auto' || opt === 'keycode' || opt === 'passthrough' || opt === 'custom' ? opt : cfg.hdmi_method
	return { method, value: override || configured }
}
