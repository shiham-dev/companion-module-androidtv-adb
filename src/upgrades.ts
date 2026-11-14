import type {
	CompanionStaticUpgradeProps,
	CompanionStaticUpgradeResult,
	CompanionStaticUpgradeScript,
	CompanionUpgradeContext,
} from '@companion-module/base'
import type { ModuleConfig } from './config.js'

/** v0.2.2: the old 15 s default wake window is too short for a TV booting after a power cut. */
export function upgradeWakeWindow(
	_context: CompanionUpgradeContext<ModuleConfig>,
	props: CompanionStaticUpgradeProps<ModuleConfig>,
): CompanionStaticUpgradeResult<ModuleConfig> {
	const config = props.config
	const updatedConfig =
		config && (config.wake_window === 15 || config.wake_window === undefined) ? { ...config, wake_window: 60 } : null
	return { updatedConfig, updatedActions: [], updatedFeedbacks: [] }
}

/** v0.2.3: 60 s left too little time for WoL reaction plus a ~45 s boot; raise the previous default to 120 s. */
export function upgradeWakeWindow120(
	_context: CompanionUpgradeContext<ModuleConfig>,
	props: CompanionStaticUpgradeProps<ModuleConfig>,
): CompanionStaticUpgradeResult<ModuleConfig> {
	const config = props.config
	const updatedConfig = config && config.wake_window === 60 ? { ...config, wake_window: 120 } : null
	return { updatedConfig, updatedActions: [], updatedFeedbacks: [] }
}

/** v0.3.0: switch on "restore power state after outage" for existing connections. */
export function upgradeRestoreAfterOutage(
	_context: CompanionUpgradeContext<ModuleConfig>,
	props: CompanionStaticUpgradeProps<ModuleConfig>,
): CompanionStaticUpgradeResult<ModuleConfig> {
	const config = props.config
	const updatedConfig =
		config && config.restore_after_outage === undefined
			? { ...config, restore_after_outage: true, restore_delay: config.restore_delay ?? 15 }
			: null
	return { updatedConfig, updatedActions: [], updatedFeedbacks: [] }
}

export const UpgradeScripts: CompanionStaticUpgradeScript<ModuleConfig>[] = [
	upgradeWakeWindow,
	upgradeWakeWindow120,
	upgradeRestoreAfterOutage,
]
