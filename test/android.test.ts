import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
	hdmiCommand,
	normalizeKeycode,
	parseHdmiInputMap,
	parseBanner,
	parsePowerState,
	parseTvInputIds,
	passthroughCommand,
} from '../src/android.js'

test('parsePowerState', () => {
	assert.equal(parsePowerState('  mWakefulness=Awake\n'), 'on')
	assert.equal(parsePowerState('mWakefulness=Asleep'), 'off')
	assert.equal(parsePowerState('mWakefulness=Dozing'), 'off')
	assert.equal(parsePowerState('mWakefulness=Dreaming'), 'on')
	assert.equal(parsePowerState('Display Power: state=ON'), 'on')
	assert.equal(parsePowerState('Display Power: state=OFF'), 'off')
	assert.equal(parsePowerState(''), 'unknown')
})

test('hdmiCommand: keycode, passthrough, custom', () => {
	assert.equal(hdmiCommand('keycode', 1), 'input keyevent 243')
	assert.equal(hdmiCommand('keycode', 4), 'input keyevent 246')
	assert.throws(() => hdmiCommand('keycode', 5))
	assert.equal(
		hdmiCommand('passthrough', 2, 'com.mediatek.tvinput/.hdmi.HDMIInputService/HW5'),
		"am start -a android.intent.action.VIEW -d 'content://android.media.tv/passthrough/com.mediatek.tvinput%2F.hdmi.HDMIInputService%2FHW5'",
	)
	assert.throws(() => hdmiCommand('passthrough', 2, ''), /no TV input ID/)
	assert.equal(hdmiCommand('custom', 3, 'input keyevent 178'), 'input keyevent 178')
	assert.ok(passthroughCommand(' x/y/z ').includes('x%2Fy%2Fz'))
})

test('parseHdmiInputMap maps HDMI ports to input IDs (real TCL dumpsys excerpt)', () => {
	const dump = `
    com.tcl.tvinput/.TvPassThroughService/HW3: info: TvInputInfo{id=com.tcl.tvinput/.TvPassThroughService/HW3, pkg=com.tcl.tvinput, service=com.tcl.tvinput.TvPassThroughService}; state: 0
    com.tcl.tvinput/.TvPassThroughService/HW17: info: TvInputInfo{id=com.tcl.tvinput/.TvPassThroughService/HW17, pkg=com.tcl.tvinput}; state: 0
    com.tcl.tvinput/.TunerInputService/HW2: info: TvInputInfo{id=com.tcl.tvinput/.TunerInputService/HW2, pkg=com.tcl.tvinput}; state: 0
    com.tcl.tvinput/.TvPassThroughService/HW15: info: TvInputInfo{id=com.tcl.tvinput/.TvPassThroughService/HW15, pkg=com.tcl.tvinput}; state: 1
    com.tcl.tvinput/.TvPassThroughService/HW16: info: TvInputInfo{id=com.tcl.tvinput/.TvPassThroughService/HW16, pkg=com.tcl.tvinput}; state: 1
    TvInputHardwareInfo {id=2, type=2, audio_type=-2147467264, audio_addr=, cable_connection_status=0}
    TvInputHardwareInfo {id=3, type=3, audio_type=-2147450880, audio_addr=, cable_connection_status=0}
    TvInputHardwareInfo {id=15, type=9, audio_type=-2147483616, audio_addr=, hdmi_port=1, cable_connection_status=0}
    TvInputHardwareInfo {id=16, type=9, audio_type=-2147483616, audio_addr=, hdmi_port=2, cable_connection_status=0}
    TvInputHardwareInfo {id=17, type=9, audio_type=-2147483616, audio_addr=, hdmi_port=3, cable_connection_status=0}`
	assert.deepEqual(parseHdmiInputMap(dump), {
		1: 'com.tcl.tvinput/.TvPassThroughService/HW15',
		2: 'com.tcl.tvinput/.TvPassThroughService/HW16',
		3: 'com.tcl.tvinput/.TvPassThroughService/HW17',
	})
	assert.deepEqual(parseHdmiInputMap(''), {})
	assert.equal(hdmiCommand('auto', 4), 'input keyevent 246')
	assert.ok(hdmiCommand('auto', 1, 'a/b/HW15').includes('passthrough/a%2Fb%2FHW15'))
})

test('normalizeKeycode', () => {
	assert.equal(normalizeKeycode('3'), '3')
	assert.equal(normalizeKeycode('home'), 'KEYCODE_HOME')
	assert.equal(normalizeKeycode('KEYCODE_DPAD_UP'), 'KEYCODE_DPAD_UP')
	assert.throws(() => normalizeKeycode('3; reboot'))
})

test('parseTvInputIds and parseBanner', () => {
	const dump = `
  TvInputInfo{id=com.mediatek.tvinput/.hdmi.HDMIInputService/HW5, pkg=com.mediatek.tvinput, service=.hdmi.HDMIInputService}
  TvInputInfo{id=com.mediatek.tvinput/.hdmi.HDMIInputService/HW6, pkg=...}
  inputId=com.mediatek.tvinput/.hdmi.HDMIInputService/HW5`
	assert.deepEqual(parseTvInputIds(dump), [
		'com.mediatek.tvinput/.hdmi.HDMIInputService/HW5',
		'com.mediatek.tvinput/.hdmi.HDMIInputService/HW6',
	])
	assert.deepEqual(parseBanner('device::ro.product.name=x;ro.product.model=TV 4K;features=shell_v2'), {
		'ro.product.name': 'x',
		'ro.product.model': 'TV 4K',
		features: 'shell_v2',
	})
})
