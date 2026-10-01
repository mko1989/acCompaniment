/**
 * Upgrade scripts: run once by Companion on existing connections/buttons.
 */

import { DEFAULT_PORT } from './client.js'

/** The Electron app listened on 8877 (and earlier 8080); the server uses its web port. */
export const LEGACY_PORTS = [8877, 8080]

/**
 * 2.0.0 - the Node.js acCompaniment server:
 * - the connection moves from the old Electron port to the server's port;
 * - "Stop All Audio" used to always fade out: keep that on existing buttons
 *   (new ones default to the app's own Stop All setting).
 */
export function upgradeToNodeServer(context, props) {
	let updatedConfig = null
	if (props.config && LEGACY_PORTS.includes(Number(props.config.port))) {
		updatedConfig = { ...props.config, port: DEFAULT_PORT }
	}
	const updatedActions = []
	for (const action of props.actions) {
		if (action.actionId === 'stop_all' && action.options.behavior === undefined) {
			action.options.behavior = 'fade_out_and_stop'
			updatedActions.push(action)
		}
	}
	return { updatedConfig, updatedActions, updatedFeedbacks: [] }
}

/** Run in order, once each; never remove or reorder one once released. */
export const UpgradeScripts = [upgradeToNodeServer]
