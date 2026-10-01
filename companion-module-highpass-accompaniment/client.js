/**
 * Connection to an acCompaniment server, independent of Companion: speaks
 * its WebSocket protocol (same port as its web UI, default 3333) and keeps
 * the state the module shows - the cue list, each cue's playback state,
 * which cue is "current", the project name, crossfade mode, master volume.
 *
 * main.js turns this into Companion variables/feedbacks/actions; keeping it
 * separate means it can be tested against a real server (see test/).
 *
 * Events:
 *   'connection' (status: 'connecting' | 'connected' | 'disconnected' | 'error', detail?)
 *   'cues'       ()          the cue list changed
 *   'cue'        (cueId, feedbackStateChanged) a cue's playback state changed
 *                (incl. its times); the flag says whether any FEEDBACK_FIELDS did
 *   'current'    (cueId|null) the current cue changed
 *   'project'    (name)
 *   'crossfade'  (enabled)
 *   'masterVolume' (volume 0-2)
 */

import { EventEmitter } from 'node:events'
import WebSocket from 'ws'

export const DEFAULT_PORT = 3333

/** A cue's state as the module presents it. */
export function idleState() {
	return {
		status: 'stopped', // 'playing' | 'paused' | 'fading' | 'cued' | 'stopped'
		currentTimeSec: 0,
		totalDurationSec: 0,
		remainingTimeSec: 0,
		currentTimeFormatted: '00:00',
		totalDurationFormatted: '00:00',
		remainingTimeFormatted: '00:00',
		isFadingIn: false,
		isFadingOut: false,
		fadeTimeRemainingMs: 0,
		fadeTotalDurationMs: 0,
		isDucked: false,
		voiceCount: 0,
		playlistIndex: null,
		nextPlaylistIndex: null,
	}
}

/** The state fields the cue feedbacks (feedbacks.js) depend on. */
export const FEEDBACK_FIELDS = ['status', 'isFadingIn', 'isFadingOut', 'isDucked']

/** Server cue_status values -> the module's statuses. */
export function statusFromCueStatus(status) {
	switch (status) {
		case 'playing':
			return 'playing'
		case 'paused':
			return 'paused'
		case 'cued_next':
			return 'cued'
		default:
			return 'stopped' // 'stopped', 'completed'
	}
}

export class AccompanimentClient extends EventEmitter {
	constructor({
		host = '127.0.0.1',
		port = DEFAULT_PORT,
		reconnect = true,
		reconnectDelayMs = 5000,
		WebSocketImpl = WebSocket,
	} = {}) {
		super()
		this.host = host
		this.port = port
		this.reconnect = reconnect
		this.reconnectDelayMs = reconnectDelayMs
		this.WebSocketImpl = WebSocketImpl

		this.ws = null
		this.connected = false
		this.closedByUser = false
		this.reconnectTimer = null

		this.cues = []
		this.states = {} // cueId -> state (see idleState)
		this.fadeTotals = {} // cueId -> longest fade time seen in the current fade (ms)
		this.startedAt = {} // cueId -> when it last started playing (for "current cue")
		this.currentCueId = null
		this.projectName = ''
		this.crossfadeEnabled = false
		this.masterVolume = 1
	}

	get url() {
		return `ws://${this.host}:${this.port}`
	}

	// --- Connection ---------------------------------------------------------

	connect() {
		this.closedByUser = false
		this._clearReconnect()
		if (this.ws) {
			this.ws.removeAllListeners()
			this.ws.terminate()
		}
		this.emit('connection', 'connecting', this.url)
		const ws = new this.WebSocketImpl(this.url)
		this.ws = ws

		ws.on('open', () => {
			this.connected = true
			this.emit('connection', 'connected', this.url)
		})
		ws.on('message', (data) => {
			let message
			try {
				message = JSON.parse(data.toString())
			} catch {
				return
			}
			this.handleMessage(message)
		})
		ws.on('close', () => {
			const wasConnected = this.connected
			this.connected = false
			if (this.ws === ws) this.ws = null
			if (wasConnected) {
				// Nothing is known to be playing any more.
				this._resetPlayback()
			}
			this.emit('connection', 'disconnected')
			this._scheduleReconnect()
		})
		ws.on('error', (error) => {
			this.emit('connection', 'error', error.message)
		})
	}

	close() {
		this.closedByUser = true
		this._clearReconnect()
		if (this.ws) {
			this.ws.removeAllListeners()
			this.ws.terminate()
			this.ws = null
		}
		this.connected = false
	}

	_scheduleReconnect() {
		if (this.closedByUser || !this.reconnect || this.reconnectTimer) return
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null
			this.connect()
		}, this.reconnectDelayMs)
	}

	_clearReconnect() {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer)
			this.reconnectTimer = null
		}
	}

	send(type, payload = {}) {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
		this.ws.send(JSON.stringify({ type, payload }))
		return true
	}

	// --- Commands -----------------------------------------------------------

	/** Press a cue: plays it, or applies its retrigger behavior if it's already playing/paused. */
	toggleCue(cueId) {
		return this.send('toggle_cue', { cueId, fromCompanion: true })
	}

	playCue(cueId) {
		return this.send('play_cue', { cueId })
	}

	stopCue(cueId, { fade = false } = {}) {
		return this.send('stop_cue', { cueId, fadeOut: Boolean(fade) })
	}

	/** behavior: 'stop' | 'fade_out_and_stop' | undefined (the app's own Stop All setting) */
	stopAll(behavior) {
		return this.send('stop_all_cues', behavior ? { behavior } : {})
	}

	togglePause(cueId) {
		return this.send('toggle_pause_cue', { cueId })
	}

	playlistNext(cueId) {
		return this.send('playlist_navigate', { cueId, direction: 'next' })
	}

	playlistPrevious(cueId) {
		return this.send('playlist_navigate', { cueId, direction: 'previous' })
	}

	/** index: 0-based */
	playlistJump(cueId, index) {
		return this.send('playlist_jump', { cueId, index })
	}

	setCrossfade(enabled) {
		return this.send('set_crossfade_mode', { enabled: Boolean(enabled) })
	}

	/** volume: 0-2 (1 = unity) */
	setMasterVolume(volume) {
		return this.send('set_master_volume', { volume })
	}

	// --- State ----------------------------------------------------------------

	stateOf(cueId) {
		return this.states[cueId] || idleState()
	}

	cueByNumber(number) {
		const index = parseInt(number, 10) - 1
		return Number.isInteger(index) && index >= 0 ? this.cues[index] || null : null
	}

	cueNumberOf(cueId) {
		const index = this.cues.findIndex((c) => c.id === cueId)
		return index === -1 ? null : index + 1
	}

	playlistItemName(cueId, index) {
		const cue = this.cues.find((c) => c.id === cueId)
		if (!cue || cue.type !== 'playlist' || index == null) return ''
		const item = cue.playlistItems?.[index]
		return item ? item.name || `Item ${index + 1}` : ''
	}

	handleMessage(message) {
		const payload = message.payload || {}
		switch (message.type) {
			case 'cues-updated':
				this._setCues(payload.cues || [])
				break
			case 'cue_status':
				this._applyCueStatus(payload)
				break
			case 'playback-time-update':
				this._applyTimeUpdate(payload)
				break
			case 'workspace-updated':
				if (payload.workspace && payload.workspace.name !== this.projectName) {
					this.projectName = payload.workspace.name || ''
					this.emit('project', this.projectName)
				}
				break
			case 'crossfade-mode-updated':
				this.crossfadeEnabled = Boolean(payload.enabled)
				this.emit('crossfade', this.crossfadeEnabled)
				break
			case 'master-volume-updated':
				if (typeof payload.volume === 'number') {
					this.masterVolume = payload.volume
					this.emit('masterVolume', this.masterVolume)
				}
				break
			default:
				break
		}
	}

	_setCues(cues) {
		this.cues = Array.isArray(cues) ? cues : []
		const ids = new Set(this.cues.map((c) => c.id))
		for (const id of Object.keys(this.states)) {
			if (!ids.has(id)) this._forget(id)
		}
		// A cue the server lists as active (e.g. on connect) starts out that way.
		for (const cue of this.cues) {
			if (!this.states[cue.id] && ['playing', 'paused', 'cued_next'].includes(cue.status)) {
				this._setState(cue.id, { status: statusFromCueStatus(cue.status) }, false)
			}
		}
		if (this.currentCueId && !ids.has(this.currentCueId)) this._setCurrent(this._latestActiveCue())
		this.emit('cues')
	}

	_applyCueStatus({ cueId, status, playlistIndex, voiceCount }) {
		if (!cueId || !status) return
		const next = statusFromCueStatus(status)
		if (next === 'stopped') {
			this._setState(cueId, idleState())
			return
		}
		const update = { status: next }
		if (typeof playlistIndex === 'number') update.playlistIndex = playlistIndex
		if (typeof voiceCount === 'number') update.voiceCount = voiceCount
		if (next === 'cued')
			Object.assign(update, { isFadingIn: false, isFadingOut: false, fadeTimeRemainingMs: 0, fadeTotalDurationMs: 0 })
		this._setState(cueId, update)
	}

	_applyTimeUpdate(p) {
		if (!p.cueId) return
		const fading = p.status === 'playing' && Boolean(p.isFadingIn || p.isFadingOut)
		// The server reports how much of a fade is left; the longest value
		// seen in this fade is its total length.
		if (fading) {
			this.fadeTotals[p.cueId] = Math.max(this.fadeTotals[p.cueId] || 0, p.fadeTimeRemainingMs || 0)
		} else {
			delete this.fadeTotals[p.cueId]
		}
		this._setState(p.cueId, {
			status: fading ? 'fading' : p.status === 'paused' ? 'paused' : 'playing',
			currentTimeSec: p.currentTimeSec || 0,
			totalDurationSec: p.totalDurationSec || 0,
			remainingTimeSec: p.remainingTimeSec || 0,
			currentTimeFormatted: p.currentTimeFormatted || '00:00',
			totalDurationFormatted: p.totalDurationFormatted || '00:00',
			remainingTimeFormatted: p.remainingTimeFormatted || '00:00',
			isFadingIn: Boolean(p.isFadingIn),
			isFadingOut: Boolean(p.isFadingOut),
			fadeTimeRemainingMs: fading ? p.fadeTimeRemainingMs || 0 : 0,
			fadeTotalDurationMs: fading ? this.fadeTotals[p.cueId] : 0,
			isDucked: Boolean(p.isDucked),
			voiceCount: p.voiceCount || 1,
			playlistIndex: typeof p.playlistIndex === 'number' ? p.playlistIndex : null,
			nextPlaylistIndex: typeof p.nextPlaylistIndex === 'number' ? p.nextPlaylistIndex : null,
		})
	}

	_setState(cueId, update, emit = true) {
		const before = this.stateOf(cueId)
		const after = { ...before, ...update }
		this.states[cueId] = after
		if (after.status === 'stopped') delete this.fadeTotals[cueId]
		// Time updates arrive 10x a second; most only move the times. Only a
		// change here needs Companion to re-evaluate the cue feedbacks.
		const feedbackStateChanged = FEEDBACK_FIELDS.some((field) => before[field] !== after[field])

		const wasActive = ['playing', 'fading'].includes(before.status)
		const isActive = ['playing', 'fading'].includes(after.status)
		if (isActive && !wasActive && before.status !== 'paused') {
			// Newly started (not resumed): it becomes the current cue.
			this.startedAt[cueId] = Date.now()
			this._setCurrent(cueId)
		} else if (after.status === 'stopped' || after.status === 'cued') {
			delete this.startedAt[cueId]
			if (this.currentCueId === cueId) this._setCurrent(this._latestActiveCue())
		}
		if (emit) this.emit('cue', cueId, feedbackStateChanged)
	}

	_latestActiveCue() {
		let latest = null
		let latestTs = -1
		for (const [id, state] of Object.entries(this.states)) {
			if (!['playing', 'fading', 'paused'].includes(state.status)) continue
			const ts = this.startedAt[id] || 0
			if (ts > latestTs) {
				latestTs = ts
				latest = id
			}
		}
		return latest
	}

	_setCurrent(cueId) {
		if (this.currentCueId === cueId) return
		this.currentCueId = cueId
		this.emit('current', cueId)
	}

	_forget(cueId) {
		delete this.states[cueId]
		delete this.startedAt[cueId]
		delete this.fadeTotals[cueId]
	}

	_resetPlayback() {
		const ids = Object.keys(this.states)
		this.states = {}
		this.startedAt = {}
		this.fadeTotals = {}
		this._setCurrent(null)
		for (const id of ids) this.emit('cue', id, true)
	}
}
