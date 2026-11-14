import {
	combineRgb,
	type CompanionPresetDefinitions,
	type CompanionButtonPresetDefinition,
} from '@companion-module/base'

const WHITE = combineRgb(255, 255, 255)
const BLACK = combineRgb(0, 0, 0)
const GREEN = combineRgb(0, 160, 0)
const RED = combineRgb(180, 0, 0)
const GREY = combineRgb(70, 70, 70)
const AMBER = combineRgb(200, 140, 0)
const BLUE = combineRgb(0, 90, 160)

function button(
	category: string,
	name: string,
	text: string,
	actionId: string,
	options: Record<string, string | number> = {},
	feedbacks: CompanionButtonPresetDefinition['feedbacks'] = [],
): CompanionButtonPresetDefinition {
	return {
		type: 'button',
		category,
		name,
		style: { text, size: '14', color: WHITE, bgcolor: BLACK },
		steps: [{ down: [{ actionId, options }], up: [] }],
		feedbacks,
	}
}

const offlineFb = { feedbackId: 'power_state', options: { state: 'offline' }, style: { bgcolor: GREY, color: WHITE } }
const approvalFb = {
	feedbackId: 'connection_state',
	options: { state: 'awaiting_approval' },
	style: { bgcolor: AMBER, color: BLACK },
}
const wakingFb = { feedbackId: 'waking', options: {}, style: { bgcolor: BLUE, color: WHITE } }

export function getPresets(label: string): CompanionPresetDefinitions {
	const v = (id: string) => `$(${label}:${id})`
	const presets: CompanionPresetDefinitions = {
		power_on: button('Power', 'Power On', 'TV\nON', 'power_on', {}, [
			{ feedbackId: 'power_state', options: { state: 'on' }, style: { bgcolor: GREEN, color: WHITE } },
			wakingFb,
			approvalFb,
		]),
		power_off: button('Power', 'Power Off', 'TV\nOFF', 'power_off', {}, [
			{ feedbackId: 'power_state', options: { state: 'off' }, style: { bgcolor: RED, color: WHITE } },
			offlineFb,
			approvalFb,
		]),
		power_toggle: button('Power', 'Power Toggle (shows state)', `TV\n${v('power_state')}`, 'power_toggle', {}, [
			{ feedbackId: 'power_state', options: { state: 'on' }, style: { bgcolor: GREEN, color: WHITE } },
			{ feedbackId: 'power_state', options: { state: 'off' }, style: { bgcolor: RED, color: WHITE } },
			offlineFb,
			wakingFb,
			approvalFb,
		]),
		status: button('Status', 'Status display', `${v('power_state')}\n${v('connection_status')}`, 'refresh', {}, [
			{ feedbackId: 'power_state', options: { state: 'on' }, style: { bgcolor: GREEN, color: WHITE } },
			offlineFb,
			wakingFb,
			approvalFb,
		]),
		volume_up: button('Volume', 'Volume Up', 'VOL\n+', 'volume_up'),
		volume_down: button('Volume', 'Volume Down', 'VOL\n-', 'volume_down'),
		volume_mute: button('Volume', 'Mute', 'MUTE', 'volume_mute'),
	}
	for (const i of [1, 2, 3, 4]) {
		presets[`hdmi${i}`] = button('Input', `HDMI ${i}`, `HDMI\n${i}`, 'hdmi_input', {
			input: i,
			method: 'config',
			value: '',
		})
	}
	return presets
}
