import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
	hdmiCommand,
	normalizeKeycode,
	directedBroadcast,
	parseHdmiInputMap,
	parseNetworkInfo,
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

test('parseNetworkInfo: real TCL output (wired)', () => {
	const out =
		'    inet 127.0.0.1/8 scope host lo\n    inet 172.20.173.105/24 brd 172.20.173.255 scope global eth0\n@@\n38:26:56:42:8b:ab\n@@\niface: eth0, up: true, hwAddress: 38:26:56:42:8b:ab\n@@\neth0 \nwlan0 \n'
	assert.deepEqual(parseNetworkInfo(out, '172.20.173.105'), {
		iface: 'eth0',
		ip: '172.20.173.105',
		prefix: 24,
		broadcast: '172.20.173.255',
		mac: '38:26:56:42:8b:ab',
	})
})

test('parseNetworkInfo: Wi-Fi uses the wlan MAC, never ro.boot.mac; missing brd is computed', () => {
	const out = '    inet 10.1.2.3/23 scope global wlan0\n@@\n38:26:56:42:8b:ab\n@@\n@@\neth0 \nwlan0 AA:BB:CC:00:11:22\n'
	assert.deepEqual(parseNetworkInfo(out, '10.1.2.3'), {
		iface: 'wlan0',
		ip: '10.1.2.3',
		prefix: 23,
		broadcast: '10.1.3.255',
		mac: 'aa:bb:cc:00:11:22',
	})
	assert.equal(parseNetworkInfo('@@@@@@', 'x'), null)
})

test('directedBroadcast', () => {
	assert.equal(directedBroadcast('172.20.171.3', 24), '172.20.171.255')
	assert.equal(directedBroadcast('10.0.5.9', 16), '10.0.255.255')
	assert.equal(directedBroadcast('192.168.1.130', 25), '192.168.1.255')
	assert.equal(directedBroadcast('192.168.1.10', 25), '192.168.1.127')
	assert.equal(directedBroadcast('bad', 24), '')
})

test('parseNetworkInfo: Wi-Fi MAC from dumpsys wifi (in-use MAC preferred, factory MAC fallback)', () => {
	const wifiLine =
		'mWifiInfo SSID: "Venue", BSSID: aa:bb:cc:dd:ee:ff, MAC: 92:6a:63:77:71:0a, Security type: 2, Supplicant state: COMPLETED\nwifi_sta_factory_mac_address=94:8c:d7:b0:7a:74\n'
	const base = '    inet 172.30.50.60/24 brd 172.30.50.255 scope global wlan0\n@@\n\n@@\n@@\neth0 \nwlan0 \n@@\n'
	const info = parseNetworkInfo(base + wifiLine, '172.30.50.60')
	assert.equal(info?.iface, 'wlan0')
	assert.equal(info?.broadcast, '172.30.50.255')
	assert.equal(info?.mac, '92:6a:63:77:71:0a') // randomized MAC actually in use
	const hidden = wifiLine.replace('MAC: 92:6a:63:77:71:0a', 'MAC: 02:00:00:00:00:00')
	assert.equal(parseNetworkInfo(base + hidden, '172.30.50.60')?.mac, '94:8c:d7:b0:7a:74')
	// Real line from a disconnected TCL (Android 12)
	const real =
		'mWifiInfo SSID: <unknown ssid>, BSSID: <none>, MAC: 94:8c:d7:b0:7a:74, Security type: -1, Supplicant state: DISCONNECTED\n'
	assert.equal(parseNetworkInfo(base + real, '172.30.50.60')?.mac, '94:8c:d7:b0:7a:74')
	// Wired TVs still never use the Wi-Fi MAC
	const wired = '    inet 10.0.0.5/24 brd 10.0.0.255 scope global eth0\n@@\n38:26:56:42:8b:ab\n@@\n@@\n@@\n' + wifiLine
	assert.equal(parseNetworkInfo(wired, '10.0.0.5')?.mac, '38:26:56:42:8b:ab')
})
