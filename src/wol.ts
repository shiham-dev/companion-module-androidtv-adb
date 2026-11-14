/** Wake-on-LAN magic packets (UDP), suitable for directed broadcasts across routed subnets. */
import { createSocket } from 'node:dgram'
import { directedBroadcast } from './android.js'

/** Parse a MAC address in common notations (aa:bb:cc:dd:ee:ff, aa-bb-..., aabb.ccdd.eeff, aabbccddeeff). */
export function parseMac(mac: string): Buffer {
	const hex = mac.trim().replace(/[:\-.\s]/g, '')
	if (!/^[0-9a-fA-F]{12}$/.test(hex)) throw new Error(`invalid MAC address "${mac}"`)
	return Buffer.from(hex, 'hex')
}

/** 6 x 0xFF followed by the MAC repeated 16 times (102 bytes). */
export function buildMagicPacket(mac: string): Buffer {
	const m = parseMac(mac)
	const out = Buffer.alloc(6 + 16 * 6, 0xff)
	for (let i = 0; i < 16; i++) m.copy(out, 6 + i * 6)
	return out
}

export interface WolOptions {
	mac: string
	/** Broadcast (or directed broadcast, e.g. 192.168.20.255) or unicast address. */
	address: string
	port: number
	/** How many packets to send. */
	count?: number
	/** Gap between packets in ms. */
	intervalMs?: number
}

/** Send the magic packet `count` times. Resolves when all packets were handed to the OS. */
export async function sendWol(opts: WolOptions): Promise<void> {
	const packet = buildMagicPacket(opts.mac)
	const count = Math.max(1, opts.count ?? 5)
	const interval = Math.max(0, opts.intervalMs ?? 100)
	const sock = createSocket({ type: 'udp4' })
	try {
		await new Promise<void>((resolve, reject) => {
			sock.once('error', reject)
			sock.bind(0, () => {
				sock.off('error', reject)
				resolve()
			})
		})
		sock.setBroadcast(true)
		for (let i = 0; i < count; i++) {
			await new Promise<void>((resolve, reject) => {
				sock.send(packet, opts.port, opts.address, (err) => (err ? reject(err) : resolve()))
			})
			if (i < count - 1 && interval > 0) await new Promise((r) => setTimeout(r, interval))
		}
	} finally {
		sock.close()
	}
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

/**
 * Wake-on-LAN targets: the configured broadcast, else the TV subnet's directed broadcast (as learned
 * from the TV, or assuming /24 from its IP), plus the TV's own address as a unicast fallback
 * (works while the router still has an ARP entry for it).
 */
export function wolTargets(host: string, configured: string): string[] {
	const out: string[] = []
	if (configured) out.push(configured)
	else if (IPV4.test(host)) out.push(directedBroadcast(host, 24))
	else out.push('255.255.255.255')
	if (IPV4.test(host)) out.push(host)
	return [...new Set(out.filter(Boolean))]
}
