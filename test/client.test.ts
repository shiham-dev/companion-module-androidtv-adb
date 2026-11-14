/**
 * End-to-end test of the ADB client against an in-process fake adbd that implements
 * the real handshake: AUTH TOKEN -> SIGNATURE check -> RSAPUBLICKEY -> CNXN, and shell streams.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server, type Socket, type AddressInfo } from 'node:net'
import {
	createPublicKey,
	generateKeyPairSync,
	publicDecrypt,
	constants,
	randomBytes,
	type KeyObject,
} from 'node:crypto'
import { AdbClient, AdbError } from '../src/adb/client.js'
import {
	A_AUTH,
	A_CLSE,
	A_CNXN,
	A_OKAY,
	A_OPEN,
	A_WRTE,
	AUTH_RSAPUBLICKEY,
	AUTH_SIGNATURE,
	AUTH_TOKEN,
	MessageDecoder,
	encodeMessage,
} from '../src/adb/protocol.js'
import { SHA1_DIGEST_INFO_PREFIX, androidPublicKey } from '../src/adb/keys.js'

interface FakeOptions {
	/** Public key whose signatures are accepted. */
	trusted?: KeyObject
	/** If set, accept a RSAPUBLICKEY after this many ms (simulates the user tapping Allow). */
	approveAfterMs?: number
	responses?: Record<string, string>
}

interface Fake {
	server: Server
	port: number
	events: string[]
	connections: number
	close(): Promise<void>
}

async function startFakeAdbd(opts: FakeOptions): Promise<Fake> {
	const fake: Fake = { server: null as unknown as Server, port: 0, events: [], connections: 0, close: async () => {} }
	const sockets = new Set<Socket>()
	const server = createServer((sock) => {
		sockets.add(sock)
		sock.on('close', () => sockets.delete(sock))
		fake.connections++
		const dec = new MessageDecoder()
		let token = randomBytes(20)
		let remoteNext = 100
		const send = (c: number, a0: number, a1: number, d?: string | Buffer) => sock.write(encodeMessage(c, a0, a1, d))
		const banner = 'device::ro.product.name=fake;ro.product.model=FakeTV;ro.product.device=fake;'
		sock.on('data', (chunk) => {
			for (const m of dec.push(chunk)) {
				if (m.command === A_CNXN) {
					fake.events.push(`CNXN v=${m.arg0.toString(16)} max=${m.arg1}`)
					token = randomBytes(20)
					send(A_AUTH, AUTH_TOKEN, 0, token)
				} else if (m.command === A_AUTH && m.arg0 === AUTH_SIGNATURE) {
					let ok = false
					if (opts.trusted) {
						try {
							const rec = publicDecrypt({ key: opts.trusted, padding: constants.RSA_PKCS1_PADDING }, m.data)
							ok = rec.equals(Buffer.concat([SHA1_DIGEST_INFO_PREFIX, token]))
						} catch {
							ok = false
						}
					}
					fake.events.push(`SIG ${ok ? 'ok' : 'bad'}`)
					if (ok) send(A_CNXN, 0x01000001, 1024 * 1024, banner)
					else {
						token = randomBytes(20)
						send(A_AUTH, AUTH_TOKEN, 0, token)
					}
				} else if (m.command === A_AUTH && m.arg0 === AUTH_RSAPUBLICKEY) {
					fake.events.push(`PUBKEY ${m.data.toString('utf8').split(' ')[1]?.replace('\0', '')}`)
					if (opts.approveAfterMs !== undefined) {
						setTimeout(() => send(A_CNXN, 0x01000001, 1024 * 1024, banner), opts.approveAfterMs)
					}
				} else if (m.command === A_OPEN) {
					const service = m.data.toString('utf8').replace(/\0$/, '')
					fake.events.push(`OPEN ${service}`)
					const local = m.arg0
					const remote = remoteNext++
					const cmd = service.replace(/^shell:/, '')
					const resp = opts.responses?.[cmd]
					if (resp === undefined && !cmd.startsWith('input ')) {
						send(A_CLSE, 0, local)
						continue
					}
					send(A_OKAY, remote, local)
					if (cmd === 'hang') continue // accept the stream but never finish it
					if (resp) send(A_WRTE, remote, local, resp)
					send(A_CLSE, remote, local)
				}
			}
		})
	})
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
	fake.server = server
	fake.port = (server.address() as AddressInfo).port
	fake.close = async () =>
		new Promise<void>((r) => {
			for (const s of sockets) s.destroy()
			server.close(() => r())
		})
	return fake
}

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
