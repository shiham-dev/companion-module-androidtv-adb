/** "Power Off method: power key" - KEYCODE_POWER is a toggle, so it must only be sent after checking the state. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPublicKey, generateKeyPairSync } from 'node:crypto'
import { POWER_QUERY } from '../src/android.js'
import { BOOT_ID_QUERY } from '../src/restore.js'
import { TvController } from '../src/tv.js'
import { startFakeAdbd } from './fake-adbd.js'

const { privateKey: key } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pub = createPublicKey(key)

/** Fake TCL in Screenless mode: KEYCODE_POWER toggles Awake/Asleep and the TV stays reachable. */
async function screenlessTv(awake: boolean, bootId = '11111111-2222-3333-4444-555555555555') {
	const st = { awake, powerKeys: 0, sleepKeys: 0, wakeKeys: 0 }
	const power = () => 'mWakefulness=' + (st.awake ? 'Awake' : 'Asleep') + '\n'
	const fake = await startFakeAdbd({
		trusted: pub,
		responses: {
			[POWER_QUERY]: power,
			[BOOT_ID_QUERY + '; echo @@; ' + POWER_QUERY]: () => bootId + '\n@@\n' + power(),
			'input keyevent 26': () => {
				st.powerKeys++
				st.awake = !st.awake
				return ''
			},
			'input keyevent 223': () => {
				st.sleepKeys++
				st.awake = false
				return ''
			},
			'input keyevent 224': () => {
				st.wakeKeys++
				st.awake = true
				return ''
			},
		},
	})
	return { fake, st }
}

const tvFor = (port: number, extra: Record<string, unknown> = {}) =>
	new TvController({
		host: '127.0.0.1',
		port,
		key,
		keyName: 't',
		pollIntervalMs: 0,
		keepConnected: true,
		powerOffMethod: 'power',
		...extra,
	})

test('power-key method: Power Off sends KEYCODE_POWER once when the TV is on', async () => {
	const { fake, st } = await screenlessTv(true)
	const tv = tvFor(fake.port)
	try {
		await tv.powerOff()
		assert.equal(st.powerKeys, 1)
		assert.equal(st.sleepKeys, 0)
		assert.equal(st.awake, false)
		assert.equal(tv.snapshot.power, 'off')
	} finally {
		tv.stop()
		await fake.close()
	}
})

test('power-key method: Power Off on a TV that is already off sends nothing', async () => {
	const { fake, st } = await screenlessTv(false)
	const tv = tvFor(fake.port)
	try {
		await tv.powerOff()
		assert.equal(st.powerKeys, 0)
		assert.equal(st.awake, false)
	} finally {
		tv.stop()
		await fake.close()
	}
})

test('power-key method: Power On sends KEYCODE_POWER once when off, nothing when already on', async () => {
	const off = await screenlessTv(false)
	const tv1 = tvFor(off.fake.port)
	try {
		await tv1.powerOn()
		assert.equal(off.st.powerKeys, 1)
		assert.equal(off.st.wakeKeys, 0)
		assert.equal(off.st.awake, true)
		assert.equal(tv1.snapshot.power, 'on')
	} finally {
		tv1.stop()
		await off.fake.close()
	}
	const on = await screenlessTv(true)
	const tv2 = tvFor(on.fake.port)
	try {
		await tv2.powerOn()
		assert.equal(on.st.powerKeys, 0)
		assert.equal(on.st.awake, true)
	} finally {
		tv2.stop()
		await on.fake.close()
	}
})

test('power-key method: restore-after-outage switches off with KEYCODE_POWER, not KEYCODE_SLEEP', async () => {
	const { fake, st } = await screenlessTv(true, '99999999-8888-7777-6666-555555555555')
	const tv = tvFor(fake.port, {
		restoreEnabled: true,
		restoreDelayMs: 100,
		knownBootId: '11111111-2222-3333-4444-555555555555',
		lastKnownPower: 'off',
	})
	try {
		await tv.poll()
		const end = Date.now() + 15000
		while (tv.restorePending && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
		assert.equal(st.powerKeys, 1)
		assert.equal(st.sleepKeys, 0)
		assert.equal(st.awake, false)
	} finally {
		tv.stop()
		await fake.close()
	}
})

test('default (sleep-key) method is unchanged', async () => {
	const { fake, st } = await screenlessTv(true)
	const tv = tvFor(fake.port, { powerOffMethod: 'sleep' })
	try {
		await tv.powerOff()
		assert.equal(st.sleepKeys, 1)
		assert.equal(st.powerKeys, 0)
	} finally {
		tv.stop()
		await fake.close()
	}
})
