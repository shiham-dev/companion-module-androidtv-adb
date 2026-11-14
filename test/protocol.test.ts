import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
	A_CNXN,
	A_OPEN,
	A_VERSION,
	A_WRTE,
	HEADER_SIZE,
	MAX_PAYLOAD,
	MessageDecoder,
	checksum,
	encodeMessage,
} from '../src/adb/protocol.js'

test('command constants are the ASCII names, little-endian', () => {
	assert.equal(Buffer.from('CNXN').readUInt32LE(0), A_CNXN)
	assert.equal(Buffer.from('OPEN').readUInt32LE(0), A_OPEN)
	assert.equal(Buffer.from('WRTE').readUInt32LE(0), A_WRTE)
})

test('CNXN announces version 0x01000001 with a 1 MiB max payload', () => {
	const msg = encodeMessage(A_CNXN, A_VERSION, MAX_PAYLOAD, 'host::features=shell_v2,cmd\0')
	assert.equal(msg.readUInt32LE(4), 0x01000001)
	assert.equal(msg.readUInt32LE(8), 1048576)
})

test('encodeMessage writes a correct 24-byte header', () => {
	const payload = Buffer.from('shell:echo hi\0')
	const msg = encodeMessage(A_OPEN, 7, 0, payload)
	assert.equal(msg.length, HEADER_SIZE + payload.length)
	assert.equal(msg.readUInt32LE(0), A_OPEN)
	assert.equal(msg.readUInt32LE(4), 7)
	assert.equal(msg.readUInt32LE(8), 0)
	assert.equal(msg.readUInt32LE(12), payload.length)
	assert.equal(msg.readUInt32LE(16), checksum(payload))
	assert.equal(msg.readUInt32LE(20), (A_OPEN ^ 0xffffffff) >>> 0)
	assert.deepEqual(msg.subarray(HEADER_SIZE), payload)
})

test('checksum is the unsigned byte sum', () => {
	assert.equal(checksum(Buffer.from([1, 2, 3, 255])), 261)
	assert.equal(checksum(Buffer.alloc(0)), 0)
})

test('golden bytes for an empty OKAY-style message', () => {
	const msg = encodeMessage(A_CNXN, 0x01000001, 0x00100000)
	assert.equal(msg.toString('hex'), '434e584e' + '01000001' + '00001000' + '00000000' + '00000000' + 'bcb1a7b1')
})

test('decoder handles split and coalesced messages', () => {
	const a = encodeMessage(A_WRTE, 1, 2, 'hello')
	const b = encodeMessage(A_WRTE, 1, 2, ' world')
	const all = Buffer.concat([a, b])
	const dec = new MessageDecoder()
	const out = []
	for (let i = 0; i < all.length; i += 5) out.push(...dec.push(all.subarray(i, i + 5)))
	assert.equal(out.length, 2)
	assert.equal(out[0].data.toString(), 'hello')
	assert.equal(out[1].data.toString(), ' world')
	assert.equal(out[1].arg0, 1)
	assert.equal(out[1].arg1, 2)
	assert.equal(dec.pending, 0)

	const dec2 = new MessageDecoder()
	assert.equal(dec2.push(all).length, 2)
})

test('decoder rejects bad magic and oversized payloads', () => {
	const bad = encodeMessage(A_WRTE, 0, 0, 'x')
	bad.writeUInt32LE(0, 20)
	assert.throws(() => new MessageDecoder().push(bad), /magic/)

	const big = encodeMessage(A_WRTE, 0, 0)
	big.writeUInt32LE(MAX_PAYLOAD + 1, 12)
	assert.throws(() => new MessageDecoder().push(big), /oversized/)
})
