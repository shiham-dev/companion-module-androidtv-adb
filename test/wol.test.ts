import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSocket } from 'node:dgram'
import { buildMagicPacket, parseMac, sendWol, wolTargets } from '../src/wol.js'

test('parseMac accepts common notations', () => {
	const want = 'a0b1c2d3e4f5'
	for (const s of ['A0:B1:C2:D3:E4:F5', 'a0-b1-c2-d3-e4-f5', 'a0b1.c2d3.e4f5', 'A0B1C2D3E4F5', ' a0:b1:c2:d3:e4:f5 ']) {
		assert.equal(parseMac(s).toString('hex'), want, s)
	}
	for (const bad of ['', 'a0:b1:c2:d3:e4', 'zz:b1:c2:d3:e4:f5', 'a0:b1:c2:d3:e4:f5:00']) {
		assert.throws(() => parseMac(bad), /invalid MAC/, bad)
	}
})

test('magic packet is 6 x FF + 16 x MAC (102 bytes)', () => {
	const p = buildMagicPacket('01:23:45:67:89:ab')
	assert.equal(p.length, 102)
	assert.deepEqual(p.subarray(0, 6), Buffer.alloc(6, 0xff))
	for (let i = 0; i < 16; i++) {
		assert.equal(p.subarray(6 + i * 6, 12 + i * 6).toString('hex'), '0123456789ab')
	}
})

test('sendWol sends the requested number of packets', async () => {
	const rx = createSocket('udp4')
	await new Promise<void>((r) => rx.bind(0, '127.0.0.1', () => r()))
	const port = rx.address().port
	const got: Buffer[] = []
	rx.on('message', (m) => got.push(m))
	await sendWol({ mac: '01:23:45:67:89:ab', address: '127.0.0.1', port, count: 3, intervalMs: 5 })
	await new Promise((r) => setTimeout(r, 100))
	rx.close()
	assert.equal(got.length, 3)
	assert.deepEqual(got[0], buildMagicPacket('01:23:45:67:89:ab'))
})

test('wolTargets: configured or /24 directed broadcast, plus unicast to the TV', () => {
	assert.deepEqual(wolTargets('172.20.171.3', ''), ['172.20.171.255', '172.20.171.3'])
	assert.deepEqual(wolTargets('172.20.171.3', '172.20.171.127'), ['172.20.171.127', '172.20.171.3'])
	assert.deepEqual(wolTargets('tv.example', ''), ['255.255.255.255'])
})
