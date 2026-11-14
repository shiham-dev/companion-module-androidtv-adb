import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPublicKey, generateKeyPairSync, publicDecrypt, constants, randomBytes } from 'node:crypto'
import {
	SHA1_DIGEST_INFO_PREFIX,
	androidPublicKey,
	generateAdbKeyPem,
	loadPrivateKey,
	modInverse,
	normalizePem,
	signToken,
} from '../src/adb/keys.js'

function leToBig(b: Buffer): bigint {
	return BigInt('0x' + Buffer.from(b).reverse().toString('hex'))
}

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 })
const n = BigInt(
	'0x' + Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).n as string, 'base64url').toString('hex'),
)

test('android public key: layout, modulus, n0inv, rr, exponent and name', () => {
	const line = androidPublicKey(privateKey, 'tester@host').toString('utf8')
	assert.ok(line.endsWith(' tester@host\0'))
	const raw = Buffer.from(line.split(' ')[0], 'base64')
	assert.equal(raw.length, 4 + 4 + 256 + 256 + 4)
	assert.equal(raw.readUInt32LE(0), 64)

	const mod = leToBig(raw.subarray(8, 8 + 256))
	assert.equal(mod, n)

	const n0inv = BigInt(raw.readUInt32LE(4))
	// n0inv * n[0] == -1 (mod 2^32)
	assert.equal((n0inv * (n % (1n << 32n))) % (1n << 32n), (1n << 32n) - 1n)

	const rr = leToBig(raw.subarray(8 + 256, 8 + 512))
	assert.equal(rr, (1n << 4096n) % n)

	assert.equal(raw.readUInt32LE(raw.length - 4), 65537)
})

test('signToken produces PKCS#1 v1.5 over SHA-1 DigestInfo || token (no re-hash)', () => {
	const token = randomBytes(20)
	const sig = signToken(privateKey, token)
	assert.equal(sig.length, 256)
	const recovered = publicDecrypt({ key: createPublicKey(privateKey), padding: constants.RSA_PKCS1_PADDING }, sig)
	assert.deepEqual(recovered, Buffer.concat([SHA1_DIGEST_INFO_PREFIX, token]))
})

test('generated keys load back, and PEM survives losing its newlines', async () => {
	const pem = await generateAdbKeyPem()
	assert.match(pem, /BEGIN PRIVATE KEY/)
	const k = loadPrivateKey(pem)
	assert.equal(k.asymmetricKeyDetails?.modulusLength, 2048)
	const flattened = pem.replace(/\n/g, ' ')
	assert.equal(normalizePem(flattened), normalizePem(pem))
	const squashed = pem.replace(/\n/g, '')
	assert.ok(loadPrivateKey(squashed))
})

test('PKCS#1 (RSA PRIVATE KEY) keys as written by older adb are accepted', () => {
	const pkcs1 = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string
	assert.ok(loadPrivateKey(pkcs1))
})

test('non-2048-bit keys are rejected', () => {
	const small = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' })
	assert.throws(() => loadPrivateKey(small as string), /2048/)
})

test('modInverse', () => {
	assert.equal(modInverse(3n, 11n), 4n)
	assert.equal((modInverse(0x12345677n, 1n << 32n) * 0x12345677n) % (1n << 32n), 1n)
})
