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

export const UpgradeScripts: CompanionStaticUpgradeScript<ModuleConfig>[] = [upgradeWakeWindow]
