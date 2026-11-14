/** TvController power-on behaviour against the fake adbd, including a simulated cold boot after a power cut. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type AddressInfo } from 'node:net'
import { createSocket } from 'node:dgram'
import { createPublicKey, generateKeyPairSync } from 'node:crypto'
import { POWER_QUERY } from '../src/android.js'
import { TvController, type TvOptions } from '../src/tv.js'
import { startFakeAdbd, type Fake } from './fake-adbd.js'

const { privateKey: key } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pub = createPublicKey(key)

/** A fake TV whose power state flips to Awake once it has received KEYCODE_WAKEUP `wakeAfter` times. */
function tvResponses(state: { awake: boolean; wakeKeys: number; wakeAfter: number }) {
	return {
		[POWER_QUERY]: () => `mWakefulness=${state.awake ? 'Awake' : 'Asleep'}\n`,
		'input keyevent 224': () => {
			state.wakeKeys++
			if (state.wakeKeys >= state.wakeAfter) state.awake = true
			return ''
		},
		'getprop ro.product.manufacturer; getprop ro.product.model; getprop ro.build.version.release': 'Fake\nFakeTV\n12\n',
	}
}

async function freePort(): Promise<number> {
	const s = createServer()
	await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
	const port = (s.address() as AddressInfo).port
	await new Promise<void>((r) => s.close(() => r()))
	return port
}

function controller(port: number, extra: Partial<TvOptions> = {}): TvController {
	return new TvController({
		host: '127.0.0.1',
		port,
		key,
		keyName: 't',
		pollIntervalMs: 0,
		keepConnected: true,
		connectTimeoutMs: 500,
		...extra,
	})
}

test('power on a reachable TV: wake key, then verified Awake', async () => {
	const state = { awake: false, wakeKeys: 0, wakeAfter: 1 }
	const fake = await startFakeAdbd({ trusted: pub, responses: tvResponses(state) })
	const tv = controller(fake.port)
	try {
		await tv.powerOn()
		assert.equal(tv.snapshot.power, 'on')
		assert.equal(state.wakeKeys, 1)
	} finally {
		tv.stop()
		await fake.close()
	}
})

test('power on retries the wake key until the TV reports Awake', async () => {
	const state = { awake: false, wakeKeys: 0, wakeAfter: 2 }
	const fake = await startFakeAdbd({ trusted: pub, responses: tvResponses(state) })
	const tv = controller(fake.port)
	try {
		await tv.powerOn()
		assert.equal(state.wakeKeys, 2)
		assert.equal(tv.snapshot.power, 'on')
	} finally {
		tv.stop()
		await fake.close()
	}
})

test('unreachable TV without a MAC fails with an actionable message', async () => {
	const tv = controller(await freePort())
	try {
		await tv.poll()
		assert.equal(tv.snapshot.connection, 'offline')
		await assert.rejects(tv.powerOn(), /no MAC address is known.*remote/)
	} finally {
		tv.stop()
	}
})

test('cold boot: WoL bursts until the TV boots, then wake + verify', async () => {
	const port = await freePort()
	const rx = createSocket('udp4')
	await new Promise<void>((r) => rx.bind(0, '127.0.0.1', () => r()))
	const wolPort = rx.address().port
	let packets = 0
	let fake: Fake | undefined
	const state = { awake: false, wakeKeys: 0, wakeAfter: 1 }
	// The "TV" only starts answering ADB 1.5 s after the first magic packet (a boot delay).
	rx.on('message', () => {
		if (packets++ === 0) {
			setTimeout(() => {
				void startFakeAdbd({ trusted: pub, port, responses: tvResponses(state) }).then((f) => (fake = f))
			}, 1500)
		}
	})
	const tv = controller(port, { mac: '02:00:00:00:00:01', wolAddresses: ['127.0.0.1'], wolPort, wakeWindowMs: 15000 })
	try {
		await tv.poll()
		assert.equal(tv.snapshot.connection, 'offline')
		const t0 = Date.now()
		await tv.powerOn()
		assert.ok(Date.now() - t0 >= 1500, 'waited for the boot')
		assert.ok(packets >= 5, `sent magic packets (${packets})`)
		assert.equal(state.wakeKeys, 1)
		assert.equal(tv.snapshot.power, 'on')
		assert.equal(tv.snapshot.waking, false)
	} finally {
		tv.stop()
		rx.close()
		await fake?.close()
	}
})

test('WoL window expires with a clear error and the TV shown offline', async () => {
	const rx = createSocket('udp4')
	await new Promise<void>((r) => rx.bind(0, '127.0.0.1', () => r()))
	const tv = controller(await freePort(), {
		mac: '02:00:00:00:00:01',
		wolAddresses: ['127.0.0.1'],
		wolPort: rx.address().port,
		wakeWindowMs: 1500,
	})
	try {
		await tv.poll()
		await assert.rejects(tv.powerOn(), /did not come online within 2 s after Wake-on-LAN/)
		assert.equal(tv.snapshot.power, 'offline')
	} finally {
		tv.stop()
		rx.close()
	}
})

test('presses during a wake join the running attempt instead of starting another loop', async () => {
	const rx = createSocket('udp4')
	await new Promise<void>((r) => rx.bind(0, '127.0.0.1', () => r()))
	const tv = controller(await freePort(), {
		mac: '02:00:00:00:00:01',
		wolAddresses: ['127.0.0.1'],
		wolPort: rx.address().port,
		wakeWindowMs: 1500,
	})
	const logs: string[] = []
	tv.on('log', (_l, m) => logs.push(m))
	try {
		await tv.poll()
		const first = tv.powerOn()
		await new Promise((r) => setTimeout(r, 100))
		const second = tv.powerOn()
		const toggle = tv.powerToggle()
		await assert.rejects(first, /did not come online/)
		await second // joined: resolves, the failure is reported once by the first press
		await toggle
		assert.equal(logs.filter((m) => m.startsWith('TV unreachable: sending Wake-on-LAN')).length, 1)
		assert.equal(logs.filter((m) => m.includes('already in progress')).length, 2)
	} finally {
		tv.stop()
		rx.close()
	}
})

test('Power Off on an unreachable TV is a no-op, not an error', async () => {
	const tv = controller(await freePort())
	try {
		await tv.powerOff()
		assert.equal(tv.snapshot.power, 'offline')
	} finally {
		tv.stop()
	}
})
