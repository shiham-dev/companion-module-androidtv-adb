/**
 * ADB wire protocol framing (see AOSP packages/modules/adb/protocol.txt).
 *
 * Every message is a 24-byte little-endian header followed by an optional payload:
 *   command, arg0, arg1, data_length, data_check (a byte sum), magic (command ^ 0xffffffff)
 */

export const A_SYNC = 0x434e5953
export const A_CNXN = 0x4e584e43
export const A_AUTH = 0x48545541
export const A_OPEN = 0x4e45504f
export const A_OKAY = 0x59414b4f
export const A_CLSE = 0x45534c43
export const A_WRTE = 0x45545257
export const A_STLS = 0x534c5453

/** AUTH packet subtypes (arg0). */
export const AUTH_TOKEN = 1
export const AUTH_SIGNATURE = 2
export const AUTH_RSAPUBLICKEY = 3

/**
 * Protocol version 0x01000001 must be paired with the 1 MiB max payload.
 * Announcing the older 0x01000000 with a payload above its 256 KiB cap makes adbd drop the connection.
 */
export const A_VERSION = 0x01000001
export const MAX_PAYLOAD = 1024 * 1024

export const HEADER_SIZE = 24

export interface AdbMessage {
	command: number
	arg0: number
	arg1: number
	data: Buffer
}

const NAMES: Record<number, string> = {
	[A_SYNC]: 'SYNC',
	[A_CNXN]: 'CNXN',
	[A_AUTH]: 'AUTH',
	[A_OPEN]: 'OPEN',
	[A_OKAY]: 'OKAY',
	[A_CLSE]: 'CLSE',
	[A_WRTE]: 'WRTE',
	[A_STLS]: 'STLS',
}

export function commandName(command: number): string {
	return NAMES[command] ?? `0x${command.toString(16)}`
}

/** Sum of all payload bytes, as used by the (historically misnamed) data_crc32 header field. */
export function checksum(data: Uint8Array): number {
	let sum = 0
	for (const b of data) sum = (sum + b) >>> 0
	return sum
}

/** Encode a message (header + payload) into a single buffer ready to write to the socket. */
export function encodeMessage(command: number, arg0: number, arg1: number, data?: Uint8Array | string): Buffer {
	const payload =
		data === undefined ? Buffer.alloc(0) : typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
	const out = Buffer.alloc(HEADER_SIZE + payload.length)
	out.writeUInt32LE(command >>> 0, 0)
	out.writeUInt32LE(arg0 >>> 0, 4)
	out.writeUInt32LE(arg1 >>> 0, 8)
	out.writeUInt32LE(payload.length, 12)
	out.writeUInt32LE(checksum(payload), 16)
	out.writeUInt32LE((command ^ 0xffffffff) >>> 0, 20)
	payload.copy(out, HEADER_SIZE)
	return out
}

export class AdbProtocolError extends Error {}

/**
 * Incremental decoder: feed it raw socket chunks, get whole messages back.
 * Handles messages split across chunks and several messages in one chunk.
 */
export class MessageDecoder {
	#buf: Buffer = Buffer.alloc(0)
	readonly maxPayload: number

	constructor(maxPayload = MAX_PAYLOAD) {
		this.maxPayload = maxPayload
	}

	/** Bytes buffered but not yet decoded. */
	get pending(): number {
		return this.#buf.length
	}

	push(chunk: Buffer): AdbMessage[] {
		this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk])
		const out: AdbMessage[] = []
		while (this.#buf.length >= HEADER_SIZE) {
			const command = this.#buf.readUInt32LE(0)
			const magic = this.#buf.readUInt32LE(20)
			if ((command ^ 0xffffffff) >>> 0 !== magic) {
				throw new AdbProtocolError(`bad ADB magic for command 0x${command.toString(16)}`)
			}
			const length = this.#buf.readUInt32LE(12)
			if (length > this.maxPayload) {
				throw new AdbProtocolError(`oversized ADB payload: ${length} bytes`)
			}
			if (this.#buf.length < HEADER_SIZE + length) break
			out.push({
				command,
				arg0: this.#buf.readUInt32LE(4),
				arg1: this.#buf.readUInt32LE(8),
				data: Buffer.from(this.#buf.subarray(HEADER_SIZE, HEADER_SIZE + length)),
			})
			this.#buf = this.#buf.subarray(HEADER_SIZE + length)
		}
		return out
	}
}
