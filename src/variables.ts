import type { CompanionVariableDefinition } from '@companion-module/base'

export const VARIABLES: CompanionVariableDefinition[] = [
	{ variableId: 'power_state', name: 'Power state (on / off / offline / unknown)' },
	{ variableId: 'connection_status', name: 'ADB connection status' },
	{ variableId: 'model', name: 'TV model' },
	{ variableId: 'manufacturer', name: 'TV manufacturer' },
	{ variableId: 'android_version', name: 'Android version' },
	{ variableId: 'last_error', name: 'Last error' },
	{ variableId: 'last_input', name: 'Last input selected by this module' },
	{ variableId: 'tv_inputs', name: 'TV input IDs (from "List TV inputs")' },
	{ variableId: 'last_shell_output', name: 'Output of the last shell command' },
	{ variableId: 'mac_address', name: 'TV MAC address used for Wake-on-LAN (configured or learned)' },
	{ variableId: 'wol_targets', name: 'Wake-on-LAN target addresses' },
	{ variableId: 'adb_key_fingerprint', name: 'ADB key fingerprint (as shown on the TV)' },
]
