/**
 * Read-only live test against a real TV:
 *   npm run livetest -- <host> [port] [path-to-adbkey]
 * Runs only: connect + auth, `dumpsys power` (wakefulness), `getprop ro.product.model`.
 * Without a key path an ephemeral key is generated (the TV will ask for approval).
 */
import { readFileSync } from 'node:fs'
import { AdbClient } from '../src/adb/client.js'
import { generateAdbKeyPem, loadPrivateKey } from '../src/adb/keys.js'
import { POWER_QUERY, parsePowerState } from '../src/android.js'

const [host, portArg, keyPath] = process.argv.slice(2)
if (!host) {
	console.error('usage: livetest <host> [port] [adbkey]')
	throw new Error('missing host')
}
const pem = keyPath ? readFileSync(keyPath, 'utf8') : await generateAdbKeyPem()
const client = new AdbClient({
	host,
	port: Number(portArg) || 5555,
	key: loadPrivateKey(pem),
	keyName: 'companion-androidtv-adb-livetest',
	authTimeoutMs: 30000,
	debug: process.env.ADBDEBUG ? (m) => console.log('  [adb]', m) : undefined,
})
client.on('state', (s) => console.log(`[state] ${s}`))
const t0 = Date.now()
try {
	await client.connect()
	console.log(`connected in ${Date.now() - t0} ms; banner: ${client.banner}`)
	const power = await client.shell(POWER_QUERY)
	console.log(`$ ${POWER_QUERY}\n${power.trim()}\n=> power_state=${parsePowerState(power)}`)
	const model = await client.shell('getprop ro.product.model')
	console.log(`$ getprop ro.product.model\n${model.trim()}`)
} catch (e) {
	console.error(`FAILED: ${(e as Error).message}`)
	process.exitCode = 1
} finally {
	client.close()
}
