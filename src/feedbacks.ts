import { combineRgb, type CompanionFeedbackDefinitions } from '@companion-module/base'
import type { ModuleInstance } from './main.js'

export function getFeedbacks(self: ModuleInstance): CompanionFeedbackDefinitions {
	return {
		power_state: {
			type: 'boolean',
			name: 'Power state',
			description: 'True when the TV power state matches',
			defaultStyle: { bgcolor: combineRgb(0, 160, 0), color: combineRgb(255, 255, 255) },
			options: [
				{
					type: 'dropdown',
					id: 'state',
					label: 'State',
					default: 'on',
					choices: [
						{ id: 'on', label: 'On' },
						{ id: 'off', label: 'Off / standby' },
						{ id: 'offline', label: 'Offline (unreachable)' },
						{ id: 'unknown', label: 'Unknown' },
					],
				},
			],
			callback: (fb) => (self.tv?.snapshot.power ?? 'unknown') === fb.options.state,
		},
		connection_state: {
			type: 'boolean',
			name: 'Connection state',
			description: 'True when the ADB connection state matches',
			defaultStyle: { bgcolor: combineRgb(200, 140, 0), color: combineRgb(0, 0, 0) },
			options: [
				{
					type: 'dropdown',
					id: 'state',
					label: 'State',
					default: 'awaiting_approval',
					choices: [
						{ id: 'connected', label: 'Connected' },
						{ id: 'connecting', label: 'Connecting' },
						{ id: 'awaiting_approval', label: 'Awaiting approval on TV' },
						{ id: 'offline', label: 'Offline' },
						{ id: 'auth_failed', label: 'Approval denied / timed out' },
						{ id: 'disconnected', label: 'Disconnected' },
						{ id: 'error', label: 'Error' },
					],
				},
			],
			callback: (fb) => (self.tv?.snapshot.connection ?? 'disconnected') === fb.options.state,
		},
		waking: {
			type: 'boolean',
			name: 'Waking (Wake-on-LAN in progress)',
			defaultStyle: { bgcolor: combineRgb(0, 90, 160), color: combineRgb(255, 255, 255) },
			options: [],
			callback: () => self.tv?.snapshot.waking ?? false,
		},
	}
}
