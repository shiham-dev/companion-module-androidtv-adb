/**
 * Minimal pure-Node ADB-over-TCP client (no adb binary, no adb server).
 *
 * Implements: CNXN handshake, RSA AUTH (signature, then public key for on-screen approval),
 * and "shell:" streams. One TCP connection is kept and every command is serialized over it,
 * because many TVs only accept a single ADB client at a time.
 */
import { EventEmitter } from 'node:events'
import { Socket } from 'node:net'
import type { KeyObject } from 'node:crypto'
import {
	A_AUTH,
	A_CLSE,
	A_CNXN,
	A_OKAY,
	A_OPEN,
	A_STLS,
	A_VERSION,
	A_WRTE,
	AUTH_RSAPUBLICKEY,
	AUTH_SIGNATURE,
	AUTH_TOKEN,
	MAX_PAYLOAD,
	MessageDecoder,
	commandName,
	encodeMessage,
	type AdbMessage,
} from './protocol.js'
import { androidPublicKey, signToken } from './keys.js'

export type AdbConnectionState = 'disconnected' | 'connecting' | 'awaiting_auth' | 'connected'

export type AdbErrorCode =
	| 'CONNECT_FAILED'
	| 'TIMEOUT'
	| 'AUTH_REJECTED'
	| 'AUTH_TIMEOUT'
	| 'TLS_REQUIRED'
	| 'CLOSED'
	| 'PROTOCOL'
	| 'OPEN_REFUSED'
	| 'COMMAND_TIMEOUT'

export class AdbError extends Error {
	readonly code: AdbErrorCode
	constructor(code: AdbErrorCode, message: string) {
		super(message)
		this.code = code
		this.name = 'AdbError'
	}
}

export interface AdbClientOptions {
	host: string
	port: number
	key: KeyObject
	/** Label shown in the TV's "Allow USB debugging?" dialog. */
	keyName: string
	/** TCP connect timeout. */
	connectTimeoutMs?: number
	/** Timeout for protocol replies (handshake, stream open). */
	ioTimeoutMs?: number
	/** How long to wait for a human to tap "Allow" on the TV. */
	authTimeoutMs?: number
	debug?: (msg: string) => void
}

interface StreamHandler {
	onMessage(m: AdbMessage): void
	onClose(err: Error): void
}

export interface AdbClientEvents {
	state: [AdbConnectionState]
}

export class AdbClient extends EventEmitter<AdbClientEvents> {
	readonly opts: Required<Omit<AdbClientOptions, 'debug'>> & Pick<AdbClientOptions, 'debug'>
	#state: AdbConnectionState = 'disconnected'
	#socket: Socket | null = null
	#connecting: Promise<void> | null = null
	#streams = new Map<number, StreamHandler>()
	#nextLocalId = 1
	#queue: Promise<unknown> = Promise.resolve()
	#queued = 0
	#maxPayload = MAX_PAYLOAD
	/** Banner from the device's CNXN, e.g. "device::ro.product.name=...;ro.product.model=...;" */
	banner = ''

	constructor(opts: AdbClientOptions) {
		super()
		this.opts = {
			connectTimeoutMs: 4000,
			ioTimeoutMs: 8000,
			authTimeoutMs: 60000,
			...opts,
		}
	}

	get state(): AdbConnectionState {
		return this.#state
	}

	/** Number of commands waiting for (or holding) the connection. */
	get queued(): number {
		return this.#queued
	}

	#setState(s: AdbConnectionState): void {
		if (this.#state === s) return
		this.#state = s
		this.emit('state', s)
	}

	#dbg(msg: string): void {
		this.opts.debug?.(msg)
	}

	/** Connect and authenticate (no-op if already connected). Concurrent callers share one attempt. */
	async connect(): Promise<void> {
		if (this.#state === 'connected' && this.#socket) return
		if (!this.#connecting) {
			this.#connecting = this.#doConnect().finally(() => {
				this.#connecting = null
			})
		}
		return this.#connecting
	}

	/** Close the connection (pending commands fail with CLOSED). */
	close(): void {
		this.#teardown(new AdbError('CLOSED', 'connection closed'))
	}

	#teardown(err: Error): void {
		const sock = this.#socket
		this.#socket = null
		if (sock) {
			sock.removeAllListeners('data')
			sock.destroy()
		}
		const streams = [...this.#streams.values()]
		this.#streams.clear()
		for (const s of streams) s.onClose(err)
		this.#setState('disconnected')
	}

	#send(command: number, arg0: number, arg1: number, data?: Buffer | string): void {
		if (!this.#socket) throw new AdbError('CLOSED', 'not connected')
		this.#dbg(`> ${commandName(command)} ${arg0} ${arg1} len=${data?.length ?? 0}`)
		this.#socket.write(encodeMessage(command, arg0, arg1, data))
	}

	async #doConnect(): Promise<void> {
		const { host, port, connectTimeoutMs, ioTimeoutMs, authTimeoutMs, key, keyName } = this.opts
		this.#teardown(new AdbError('CLOSED', 'reconnecting'))
		this.#setState('connecting')

		return new Promise<void>((resolve, reject) => {
			const sock = new Socket()
			this.#socket = sock
			const decoder = new MessageDecoder()
			let settled = false
			let handshakeDone = false
			let sentSignature = false
			let sentPublicKey = false
			let timer: NodeJS.Timeout | undefined

			const arm = (ms: number, code: AdbErrorCode, msg: string) => {
				if (timer) clearTimeout(timer)
				timer = setTimeout(() => fail(new AdbError(code, msg)), ms)
			}
			const fail = (err: Error) => {
				if (timer) clearTimeout(timer)
				if (this.#socket === sock) this.#teardown(err)
				else sock.destroy()
				if (!settled) {
					settled = true
					reject(err)
				}
			}
			const succeed = () => {
				if (timer) clearTimeout(timer)
				handshakeDone = true
				this.#setState('connected')
				if (!settled) {
					settled = true
					resolve()
				}
			}

			const onHandshake = (m: AdbMessage) => {
				if (m.command === A_AUTH && m.arg0 === AUTH_TOKEN) {
					if (!sentSignature) {
						sentSignature = true
						this.#send(A_AUTH, AUTH_SIGNATURE, 0, signToken(key, m.data))
					} else if (!sentPublicKey) {
						// Our signature was not accepted: offer the public key so the TV shows "Allow USB debugging?"
						sentPublicKey = true
						this.#send(A_AUTH, AUTH_RSAPUBLICKEY, 0, androidPublicKey(key, keyName))
						this.#setState('awaiting_auth')
						arm(authTimeoutMs, 'AUTH_TIMEOUT', 'timed out waiting for "Allow USB debugging" approval on the TV')
					} else {
						fail(new AdbError('AUTH_REJECTED', 'the TV rejected the ADB key'))
					}
				} else if (m.command === A_CNXN) {
					this.#maxPayload = Math.min(MAX_PAYLOAD, m.arg1 || MAX_PAYLOAD)
					this.banner = m.data.toString('utf8').replace(/\0+$/, '')
					succeed()
				} else if (m.command === A_STLS) {
					fail(
						new AdbError(
							'TLS_REQUIRED',
							'the TV requires TLS (Android 11+ "Wireless debugging" pairing), which is not supported; enable classic network/ADB debugging on port 5555',
						),
					)
				}
			}

			sock.setNoDelay(true)
			sock.on('data', (chunk) => {
				let msgs: AdbMessage[]
				try {
					msgs = decoder.push(chunk)
				} catch (e) {
					fail(new AdbError('PROTOCOL', (e as Error).message))
					return
				}
				for (const m of msgs) {
					this.#dbg(`< ${commandName(m.command)} ${m.arg0} ${m.arg1} len=${m.data.length}`)
					if (!handshakeDone) {
						onHandshake(m)
						continue
					}
					this.#streams.get(m.arg1)?.onMessage(m)
				}
			})
			sock.on('error', (e: NodeJS.ErrnoException) => {
				fail(new AdbError(handshakeDone ? 'CLOSED' : 'CONNECT_FAILED', `${host}:${port}: ${e.code ?? e.message}`))
			})
			sock.on('close', () => {
				if (this.#state === 'awaiting_auth') {
					fail(new AdbError('AUTH_REJECTED', 'the TV closed the connection while waiting for approval (denied?)'))
				} else {
					fail(new AdbError(handshakeDone ? 'CLOSED' : 'CONNECT_FAILED', `${host}:${port}: connection closed`))
				}
			})

			arm(connectTimeoutMs, 'CONNECT_FAILED', `${host}:${port}: connect timeout`)
			sock.connect(port, host, () => {
				sock.setKeepAlive(true, 10000)
				arm(ioTimeoutMs, 'TIMEOUT', `${host}:${port}: no ADB handshake reply`)
				try {
					this.#send(A_CNXN, A_VERSION, MAX_PAYLOAD, 'host::features=shell_v2,cmd\0')
				} catch (e) {
					fail(e as Error)
				}
			})
		})
	}

	/** Run fn exclusively (one command on the wire at a time). */
	async #exclusive<T>(fn: () => Promise<T>): Promise<T> {
		this.#queued++
		const run = this.#queue.then(fn, fn)
		this.#queue = run.then(
			() => undefined,
			() => undefined,
		)
		return run.finally(() => {
			this.#queued--
		})
	}

	/**
	 * Run a shell command and return its combined output.
	 * Connects (and authenticates) first if needed. Commands are serialized.
	 */
	async shell(command: string, timeoutMs = 10000): Promise<string> {
		return this.#exclusive(async () => {
			await this.connect()
			return this.#openStream(`shell:${command}`, timeoutMs)
		})
	}

	async #openStream(service: string, timeoutMs: number): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			const localId = this.#nextLocalId++
			if (this.#nextLocalId > 0x7fffffff) this.#nextLocalId = 1
			let remoteId = 0
			const chunks: Buffer[] = []
			let done = false

			const finish = (err: Error | null) => {
				if (done) return
				done = true
				clearTimeout(timer)
				this.#streams.delete(localId)
				if (err) reject(err)
				else resolve(Buffer.concat(chunks).toString('utf8'))
			}

			const timer = setTimeout(() => {
				// The connection is now in an unknown state; drop it so the next command starts clean.
				finish(new AdbError('COMMAND_TIMEOUT', `command timed out after ${timeoutMs} ms`))
				this.#teardown(new AdbError('CLOSED', 'stream timeout'))
			}, timeoutMs)

			this.#streams.set(localId, {
				onMessage: (m) => {
					try {
						switch (m.command) {
							case A_OKAY:
								remoteId = m.arg0
								break
							case A_WRTE:
								remoteId = m.arg0
								chunks.push(m.data)
								this.#send(A_OKAY, localId, remoteId)
								break
							case A_CLSE:
								if (remoteId === 0 && m.arg0 === 0) {
									finish(new AdbError('OPEN_REFUSED', `the TV refused service "${service}"`))
								} else {
									this.#send(A_CLSE, localId, m.arg0)
									finish(null)
								}
								break
						}
					} catch (e) {
						finish(e as Error)
					}
				},
				onClose: (err) => finish(err),
			})

			try {
				const payload = Buffer.from(service + '\0', 'utf8')
				if (payload.length > this.#maxPayload) throw new AdbError('PROTOCOL', 'command too long')
				this.#send(A_OPEN, localId, 0, payload)
			} catch (e) {
				finish(e as Error)
			}
		})
	}
}
