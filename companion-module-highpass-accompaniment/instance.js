/**
 * What the Companion instance does, as plain functions over `self` - the
 * InstanceBase in main.js, or a stand-in in the tests. `self` provides
 * client, config, label, log, updateStatus, setVariableDefinitions,
 * setVariableValues, setActionDefinitions, setFeedbackDefinitions,
 * setPresetDefinitions, checkFeedbacks.
 */

import { InstanceStatus } from '@companion-module/base'
import { getActionDefinitions } from './actions.js'
import { getFeedbackDefinitions, CUE_FEEDBACK_IDS } from './feedbacks.js'
import { getPresetDefinitions } from './presets.js'
import { getVariableDefinitions, valuesForCue, cueValues, globalValues, allValues } from './variables.js'

export function connect(self) {
	const host = String(self.config.host || '').trim()
	const port = Number(self.config.port)
	if (!host || !port) {
		self.client.close()
		self.updateStatus(InstanceStatus.BadConfig, 'Set the host and port')
		return
	}
	self.client.host = host
	self.client.port = port
	self.client.reconnect = self.config.reconnect !== false
	self.client.connect()
}

export function defineEverything(self) {
	if (self.definedCueCount !== self.client.cues.length) {
		self.definedCueCount = self.client.cues.length
		self.setVariableDefinitions(getVariableDefinitions(self.definedCueCount))
		self.sentValues = {} // new definitions: send every value again
	}
	pushValues(self, allValues(self.client))
	self.setActionDefinitions(getActionDefinitions(self))
	self.setFeedbackDefinitions(getFeedbackDefinitions(self))
	const { structure, presets } = getPresetDefinitions(self)
	self.setPresetDefinitions(structure, presets)
}

/**
 * Sets the variables whose values differ from what was last sent. A playing
 * cue's times arrive 10x a second but its displayed values change far less
 * often; every setVariableValues call makes Companion re-render whatever
 * shows those variables.
 */
export function pushValues(self, values) {
	if (!self.sentValues) self.sentValues = {}
	const changed = {}
	let any = false
	for (const [id, value] of Object.entries(values)) {
		if (self.sentValues[id] === value) continue
		self.sentValues[id] = value
		changed[id] = value
		any = true
	}
	if (any) self.setVariableValues(changed)
}

/** A cue list's identity as far as definitions go (ids, names, types, item counts). */
export function cueListSignature(cues) {
	return JSON.stringify(cues.map((c) => [c.id, c.name, c.type, (c.playlistItems || []).length]))
}

export function wireClient(self) {
	const client = self.client
	self.definedCueCount = -1
	self.sentValues = {}
	self.cueListSignature = cueListSignature([])

	client.on('connection', (status, detail) => {
		switch (status) {
			case 'connecting':
				self.updateStatus(InstanceStatus.Connecting)
				self.log('debug', `Connecting to ${detail}`)
				break
			case 'connected':
				self.updateStatus(InstanceStatus.Ok)
				self.log('info', `Connected to acCompaniment at ${detail}`)
				break
			case 'disconnected':
				self.updateStatus(InstanceStatus.Disconnected, 'Not connected')
				break
			case 'error':
				self.updateStatus(InstanceStatus.ConnectionFailure, detail)
				self.log('debug', `Connection error: ${detail}`)
				break
		}
		self.checkFeedbacks('connected')
	})
	client.on('cues', () => {
		// The list is re-sent after every cue edit; rebuild the definitions
		// that list cues only when it really changed.
		const signature = cueListSignature(client.cues)
		if (signature !== self.cueListSignature) {
			self.cueListSignature = signature
			defineEverything(self)
		} else {
			pushValues(self, allValues(client))
		}
		self.checkFeedbacks(...CUE_FEEDBACK_IDS)
	})
	client.on('cue', (cueId, feedbackStateChanged) => {
		pushValues(self, valuesForCue(client, cueId))
		// Re-checking redraws every button with a cue feedback; doing it on
		// each time update overloaded Companion and made buttons flicker.
		if (feedbackStateChanged) self.checkFeedbacks(...CUE_FEEDBACK_IDS)
	})
	client.on('current', (cueId) => {
		pushValues(self, cueValues(client, cueId, 'current_cue'))
	})
	client.on('project', () => pushValues(self, globalValues(client)))
	client.on('masterVolume', () => pushValues(self, globalValues(client)))
	client.on('crossfade', () => {
		pushValues(self, globalValues(client))
		self.checkFeedbacks('crossfade_enabled')
	})
}
