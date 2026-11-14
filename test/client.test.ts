/**
 * End-to-end test of the ADB client against an in-process fake adbd that implements
 * the real handshake: AUTH TOKEN -> SIGNATURE check -> RSAPUBLICKEY -> CNXN, and shell streams.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type AddressInfo } from 'node:net'
import { createPublicKey, generateKeyPairSync } from 'node:crypto'
import { AdbClient, AdbError } from '../src/adb/client.js'
import { androidPublicKey } from '../src/adb/keys.js'
import { startFakeAdbd } from './fake-adbd.js'

const { privateKey: key } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pub = createPublicKey(key)

test('connects with an already-trusted key and runs shell commands over one connection', async () => {
	const fake = await startFakeAdbd({ trusted: pub, responses: { 'getprop ro.product.model': 'FakeTV\n' } })
	const c = new AdbClient({ host: '127.0.0.1', port: fake.port, key, keyName: 'test' })
	try {
		const states: string[] = []
		c.on('state', (s) => states.push(s))
		assert.equal(await c.shell('getprop ro.product.model'), 'FakeTV\n')
		assert.equal(await c.shell('input keyevent 224'), '')
		assert.equal(fake.connections, 1, 'commands reuse one TCP connection')
		assert.match(c.banner, /ro.product.model=FakeTV/)
		assert.deepEqual(states, ['connecting', 'connected'])
		assert.equal(fake.events[0], 'CNXN v=1000001 max=1048576')
		assert.equal(fake.events[1], 'SIG ok')
	} finally {
		c.close()
		await fake.close()
	}
})

test('commands issued concurrently are serialized', async () => {
	const fake = await startFakeAdbd({ trusted: pub, responses: { a: 'A', b: 'B', c: 'C' } })
	const c = new AdbClient({ host: '127.0.0.1', port: fake.port, key, keyName: 'test' })
	try {
		const out = await Promise.all([c.shell('a'), c.shell('b'), c.shell('c')])
		assert.deepEqual(out, ['A', 'B', 'C'])
		assert.deepEqual(
			fake.events.filter((e) => e.startsWith('OPEN')),
			['OPEN shell:a', 'OPEN shell:b', 'OPEN shell:c'],
		)
	} finally {
		c.close()
		await fake.close()
	}
})

test('unknown key: sends RSAPUBLICKEY, reports awaiting_auth, connects once approved', async () => {
	const fake = await startFakeAdbd({ approveAfterMs: 150, responses: { x: 'ok' } })
	const c = new AdbClient({ host: '127.0.0.1', port: fake.port, key, keyName: 'companion@test' })
	try {
		const states: string[] = []
		c.on('state', (s) => states.push(s))
		assert.equal(await c.shell('x'), 'ok')
		assert.deepEqual(states, ['connecting', 'awaiting_auth', 'connected'])
		assert.deepEqual(fake.events.slice(0, 3), ['CNXN v=1000001 max=1048576', 'SIG bad', 'PUBKEY companion@test'])
	} finally {
		c.close()
		await fake.close()
	}
})

test('approval timeout surfaces AUTH_TIMEOUT', async () => {
	const fake = await startFakeAdbd({})
	const c = new AdbClient({ host: '127.0.0.1', port: fake.port, key, keyName: 't', authTimeoutMs: 200 })
	try {
		await assert.rejects(c.shell('x'), (e: unknown) => e instanceof AdbError && e.code === 'AUTH_TIMEOUT')
		assert.equal(c.state, 'disconnected')
	} finally {
		c.close()
		await fake.close()
	}
})

test('refused service surfaces OPEN_REFUSED and keeps the connection usable', async () => {
	const fake = await startFakeAdbd({ trusted: pub, responses: { ok: 'fine' } })
	const c = new AdbClient({ host: '127.0.0.1', port: fake.port, key, keyName: 't' })
	try {
		await assert.rejects(c.shell('nope'), (e: unknown) => e instanceof AdbError && e.code === 'OPEN_REFUSED')
		assert.equal(await c.shell('ok'), 'fine')
	} finally {
		c.close()
		await fake.close()
	}
})

test('a command that never finishes fails with COMMAND_TIMEOUT and the next command reconnects', async () => {
	const fake = await startFakeAdbd({ trusted: pub, responses: { ok: 'fine', hang: '' } })
	const c = new AdbClient({ host: '127.0.0.1', port: fake.port, key, keyName: 't' })
	try {
		await assert.rejects(c.shell('hang', 200), (e: unknown) => e instanceof AdbError && e.code === 'COMMAND_TIMEOUT')
		assert.equal(await c.shell('ok'), 'fine')
		assert.equal(fake.connections, 2)
	} finally {
		c.close()
		await fake.close()
	}
})

test('reconnects after the TV drops the connection', async () => {
	const fake = await startFakeAdbd({ trusted: pub, responses: { a: '1' } })
	const c = new AdbClient({ host: '127.0.0.1', port: fake.port, key, keyName: 't' })
	try {
		assert.equal(await c.shell('a'), '1')
		await fake.close()
		await new Promise((r) => setTimeout(r, 50))
		assert.equal(c.state, 'disconnected')
		const fake2 = await startFakeAdbd({ trusted: pub, responses: { a: '2' } })
		const c2 = new AdbClient({ host: '127.0.0.1', port: fake2.port, key, keyName: 't' })
		assert.equal(await c2.shell('a'), '2')
		c2.close()
		await fake2.close()
	} finally {
		c.close()
	}
})

test('unreachable host fails fast with CONNECT_FAILED', async () => {
	// Grab a free port, then close it so nothing listens there.
	const s = createServer()
	await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
	const port = (s.address() as AddressInfo).port
	await new Promise<void>((r) => s.close(() => r()))
	const c = new AdbClient({ host: '127.0.0.1', port, key, keyName: 't', connectTimeoutMs: 1000 })
	await assert.rejects(c.shell('x'), (e: unknown) => e instanceof AdbError && e.code === 'CONNECT_FAILED')
})

test('pubkey sent to the TV is the android-format key', () => {
	const line = androidPublicKey(key, 'n').toString()
	assert.ok(line.endsWith(' n\0'))
})
