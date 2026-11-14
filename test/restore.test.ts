/** "Restore power state after outage": decision logic and end-to-end behaviour against the fake adbd. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPublicKey, generateKeyPairSync } from 'node:crypto'
import { POWER_QUERY } from '../src/android.js'
import { BOOT_ID_QUERY, decideRestore, parseBootId } from '../src/restore.js'
import { TvController } from '../src/tv.js'
import { startFakeAdbd } from './fake-adbd.js'

const A = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'
const B = '11111111-2222-3333-4444-555555555555'

test('parseBootId', () => {
	assert.equal(parseBootId(A.toUpperCase() + '\n'), A)
	assert.equal(parseBootId(''), '')
	assert.equal(parseBootId('cat: /proc/sys/kernel/random/boot_id: Permission denied'), '')
})

test('decideRestore: only a changed boot id counts as a reboot', () => {
	const base = { enabled: true, previousBootId: A, currentBootId: A, lastKnown: 'off' as const, current: 'on' as const }
	// Reconnect after a network drop or Companion restart: same boot -> never act.
	assert.deepEqual(decideRestore(base).action, 'none')
	assert.equal(decideRestore(base).rebooted, false)
	// First contact ever: record only.
	assert.equal(decideRestore({ ...base, previousBootId: '' }).action, 'none')
	// Boot id unreadable: never act.
	assert.equal(decideRestore({ ...base, currentBootId: '' }).action, 'none')
})

test('decideRestore: what to do after a reboot', () => {
	const r = { enabled: true, previousBootId: A, currentBootId: B }
	assert.equal(decideRestore({ ...r, lastKnown: 'off', current: 'on' }).action, 'power_off')
	assert.equal(decideRestore({ ...r, lastKnown: 'on', current: 'off' }).action, 'wake')
	assert.equal(decideRestore({ ...r, lastKnown: 'on', current: 'on' }).action, 'none')
	assert.equal(decideRestore({ ...r, lastKnown: 'off', current: 'off' }).action, 'none')
	assert.equal(decideRestore({ ...r, lastKnown: '', current: 'on' }).action, 'none')
	const disabled = decideRestore({ ...r, enabled: false, lastKnown: 'off', current: 'on' })
	assert.equal(disabled.action, 'none')
	assert.equal(disabled.rebooted, true)
})

const { privateKey: key } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pub = createPublicKey(key)

/** Fake TV with a boot id and a power state that follows the wake/sleep keys. */
async function fakeTv(bootId: string, awake: boolean) {
	const st = { awake, sleepKeys: 0, wakeKeys: 0 }
	const power = () => 'mWakefulness=' + (st.awake ? 'Awake' : 'Asleep') + '\n'
	const fake = await startFakeAdbd({
		trusted: pub,
		responses: {
			[BOOT_ID_QUERY + '; echo @@; ' + POWER_QUERY]: () => bootId + '\n@@\n' + power(),
			[POWER_QUERY]: power,
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

function tvFor(port: number, knownBootId: string, lastKnownPower: '' | 'on' | 'off', restoreDelayMs = 200) {
	const tv = new TvController({
		host: '127.0.0.1',
		port,
		key,
		keyName: 't',
		pollIntervalMs: 0,
		keepConnected: true,
		restoreEnabled: true,
		restoreDelayMs,
		knownBootId,
		lastKnownPower,
	})
	const persisted: { bootId?: string; lastPower?: string }[] = []
	const restores: string[] = []
	tv.on('persist', (p) => persisted.push(p))
	tv.on('restore', (m) => restores.push(m))
	return { tv, persisted, restores }
}

const waitFor = async (cond: () => boolean, ms = 15000) => {
	const end = Date.now() + ms
	while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
}

test('reboot after a power cut while off: the TV came up on, so it is switched off again', async () => {
	const { fake, st } = await fakeTv(B, true)
	const { tv, persisted, restores } = tvFor(fake.port, A, 'off')
	try {
		await tv.poll()
		assert.equal(tv.restorePending, true)
		assert.deepEqual(persisted[0], { bootId: B }) // new boot remembered
		assert.ok(!persisted.some((p) => p.lastPower === 'on'), 'boot-time "on" must not overwrite the last state')
		await waitFor(() => !tv.restorePending)
		assert.equal(st.sleepKeys, 1)
		assert.equal(st.awake, false)
		assert.match(restores.at(-1) ?? '', /restored off/)
	} finally {
		tv.stop()
		await fake.close()
	}
})

test('reboot into standby while it was on: the TV is woken', async () => {
	const { fake, st } = await fakeTv(B, false)
	const { tv, restores } = tvFor(fake.port, A, 'on')
	try {
		await tv.poll()
		await waitFor(() => !tv.restorePending)
		assert.equal(st.wakeKeys, 1)
		assert.equal(st.awake, true)
		assert.match(restores.at(-1) ?? '', /restored on/)
	} finally {
		tv.stop()
		await fake.close()
	}
})

test('reconnect with the same boot id (network drop / Companion restart) never restores', async () => {
	const { fake, st } = await fakeTv(A, true)
	const { tv, persisted } = tvFor(fake.port, A, 'off')
	try {
		await tv.poll()
		assert.equal(tv.restorePending, false)
		await new Promise((r) => setTimeout(r, 400))
		assert.equal(st.sleepKeys, 0)
		// No reboot, so the observed "on" is the real state now (e.g. switched on with the remote).
		assert.deepEqual(persisted, [{ lastPower: 'on' }])
	} finally {
		tv.stop()
		await fake.close()
	}
})

test('a power action during the delay cancels the restore', async () => {
	const { fake, st } = await fakeTv(B, true)
	const { tv, restores } = tvFor(fake.port, A, 'off', 1500)
	try {
		await tv.poll()
		assert.equal(tv.restorePending, true)
		await tv.powerOn() // the user wants it on
		assert.equal(tv.restorePending, false)
		await new Promise((r) => setTimeout(r, 1800))
		assert.equal(st.sleepKeys, 0)
		assert.equal(st.awake, true)
		assert.ok(restores.some((m) => /cancelled: Power On pressed/.test(m)))
	} finally {
		tv.stop()
		await fake.close()
	}
})

test('first contact only records the boot id and state', async () => {
	const { fake, st } = await fakeTv(B, true)
	const { tv, persisted } = tvFor(fake.port, '', '')
	try {
		await tv.poll()
		assert.equal(tv.restorePending, false)
		assert.deepEqual(persisted, [{ bootId: B }, { lastPower: 'on' }])
		assert.equal(st.sleepKeys + st.wakeKeys, 0)
	} finally {
		tv.stop()
		await fake.close()
	}
})
