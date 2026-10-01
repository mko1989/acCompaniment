import { InstanceBase } from '@companion-module/base'
import { getConfigFields } from './config.js'
import { AccompanimentClient } from './client.js'
import { connect, defineEverything, wireClient } from './instance.js'
import { UpgradeScripts } from './upgrades.js'

export { UpgradeScripts }

export default class AccompanimentInstance extends InstanceBase {
	constructor(internal) {
		super(internal)
		this.client = new AccompanimentClient()
	}

	async init(config) {
		this.config = config
		wireClient(this)
		defineEverything(this)
		connect(this)
	}

	async destroy() {
		this.client.close()
		this.client.removeAllListeners()
	}

	async configUpdated(config) {
		this.config = config
		connect(this)
	}

	getConfigFields() {
		return getConfigFields()
	}
}
