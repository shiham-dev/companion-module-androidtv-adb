/** In-process fake adbd implementing the real handshake (token, signature check, public key approval) and shell streams. */
import { createServer, type Server, type Socket, type AddressInfo } from 'node:net'
import { publicDecrypt, constants, randomBytes, type KeyObject } from 'node:crypto'
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
import { SHA1_DIGEST_INFO_PREFIX } from '../src/adb/keys.js'

export interface FakeOptions {
	/** Listen on this port (default: any free port). */
	port?: number
	/** Public key whose signatures are accepted. */
	trusted?: KeyObject
	/** If set, accept a RSAPUBLICKEY after this many ms (simulates the user tapping Allow). */
	approveAfterMs?: number
	responses?: Record<string, string | (() => string)>
}

export interface Fake {
	server: Server
	port: number
	events: string[]
	connections: number
	close(): Promise<void>
}

export async function startFakeAdbd(opts: FakeOptions): Promise<Fake> {
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
					const r = opts.responses?.[cmd]
					const resp = typeof r === 'function' ? r() : r
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
	await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', () => r()))
	fake.server = server
	fake.port = (server.address() as AddressInfo).port
	fake.close = async () =>
		new Promise<void>((r) => {
			for (const s of sockets) s.destroy()
			server.close(() => r())
		})
	return fake
}
