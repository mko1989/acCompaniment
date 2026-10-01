/**
 * The Companion side - actions, feedbacks, variables, presets, config,
 * upgrade scripts, manifest - driven through a stand-in instance wired to a
 * client connected to a fake server.
 */

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { InstanceStatus } from '@companion-module/base'
import { AccompanimentClient } from '../client.js'
import { getConfigFields } from '../config.js'
import { connect } from '../instance.js'
import { upgradeToNodeServer, UpgradeScripts } from '../upgrades.js'
import { CUE_FIELDS } from '../variables.js'
import { fakeServer, fakeInstance, until } from './helpers.js'

const __dirname = import.meta.dirname

const CUES = [
	{ id: 'a', name: 'Intro', type: 'single_file' },
	{ id: 'b', name: 'Walk-on', type: 'single_file' },
	{
		id: 'p',
		name: 'Set',
		type: 'playlist',
		currentPlaylistIndex: 1,
		playlistItems: [{ name: 'One' }, { name: 'Two' }, { name: 'Three' }],
	},
]

let server
let self

async function setUp() {
	server = await fakeServer()
	self = fakeInstance({ config: { port: server.port } })
	connect(self)
	await until(() => self.client.connected, { message: 'connection' })
	server.push('cues-updated', { cues: CUES })
	await until(() => self.client.cues.length === 3, { message: 'cue list' })
}

function timeUpdate(cueId, extra = {}) {
	return {
		cueId,
		status: 'playing',
		currentTimeSec: 2,
		totalDurationSec: 10,
		remainingTimeSec: 8,
		currentTimeFormatted: '00:02',
		totalDurationFormatted: '00:10',
		remainingTimeFormatted: '00:08',
		isFadingIn: false,
		isFadingOut: false,
		fadeTimeRemainingMs: 0,
		isDucked: false,
		voiceCount: 1,
		playlistIndex: null,
		nextPlaylistIndex: null,
		...extra,
	}
}

beforeEach(setUp)

afterEach(async () => {
	self.client.close()
	await server.close()
})

// --- Config, status --------------------------------------------------------

test("config: host defaults to 127.0.0.1 and port to 3333 (the server's web port)", () => {
	const fields = Object.fromEntries(getConfigFields().map((f) => [f.id, f]))
	assert.equal(fields.host.default, '127.0.0.1')
	assert.equal(fields.port.default, 3333)
	assert.equal(fields.reconnect.default, true)
})

test('connection status is reported to Companion', () => {
	const statuses = self.statuses.map((s) => s.status)
	assert.deepEqual(statuses.slice(0, 2), [InstanceStatus.Connecting, InstanceStatus.Ok])
	assert.ok(self.checked.includes('connected'))
})

test('a missing host or port is a bad config, and nothing connects', () => {
	const other = fakeInstance({ config: { host: '', port: 3333 } })
	connect(other)
	assert.equal(other.statuses.at(-1).status, InstanceStatus.BadConfig)
	assert.equal(other.client.ws, null)
})

test('losing the server shows as disconnected', async () => {
	server.dropClients()
	await until(() => self.statuses.at(-1).status === InstanceStatus.Disconnected)
})

// --- Variables ---------------------------------------------------------------

test('variables are defined for every cue in the list, plus current cue and globals', () => {
	const ids = Object.keys(self.variableDefinitions)
	for (const id of ['project_name', 'crossfade_mode', 'master_volume', 'playing_count']) assert.ok(ids.includes(id), id)
	for (const [field] of CUE_FIELDS) {
		assert.ok(ids.includes(`current_cue_${field}`), `current_cue_${field}`)
		assert.ok(ids.includes(`cue_3_${field}`), `cue_3_${field}`)
	}
	assert.ok(!ids.includes('cue_4_name'))
	assert.ok(
		Object.values(self.variableDefinitions).every((d) => d.name),
		'every variable has a name',
	)
})

test('the variable ids of the 1.x module still exist', () => {
	const ids = Object.keys(self.variableDefinitions)
	for (const field of [
		'name',
		'status',
		'playlist_item_name',
		'time_formatted',
		'duration_formatted',
		'remaining_formatted',
		'time_sec',
		'duration_sec',
		'remaining_sec',
		'is_fading_in',
		'is_fading_out',
		'fade_remaining_ms',
		'fade_total_ms',
	]) {
		assert.ok(ids.includes(`cue_1_${field}`), `cue_1_${field}`)
		assert.ok(ids.includes(`current_cue_${field}`), `current_cue_${field}`)
	}
})

test('idle values: names, stopped, zero times, the playlist item it will start with', () => {
	const v = self.variables
	assert.equal(v.cue_1_name, 'Intro')
	assert.equal(v.cue_2_name, 'Walk-on')
	assert.equal(v.cue_1_status, 'stopped')
	assert.equal(v.cue_1_time_formatted, '00:00')
	assert.equal(v.cue_1_remaining_sec, 0)
	assert.equal(v.cue_3_playlist_item_name, 'Two')
	assert.equal(v.cue_1_playlist_item_name, '')
	assert.equal(v.current_cue_name, 'N/A')
	assert.equal(v.current_cue_status, 'stopped')
	assert.equal(v.playing_count, 0)
})

test("a playing cue fills its variables and the current cue's", async () => {
	server.push('playback-time-update', timeUpdate('b'))
	await until(() => self.variables.cue_2_status === 'playing')
	const v = self.variables
	assert.equal(v.cue_2_time_formatted, '00:02')
	assert.equal(v.cue_2_duration_formatted, '00:10')
	assert.equal(v.cue_2_remaining_formatted, '00:08')
	assert.equal(v.cue_2_time_sec, 2)
	assert.equal(v.current_cue_name, 'Walk-on')
	assert.equal(v.current_cue_status, 'playing')
	assert.equal(v.current_cue_remaining_formatted, '00:08')
	assert.equal(v.playing_count, 1)
	assert.equal(v.cue_1_status, 'stopped', 'other cues untouched')
})

test('fade variables', async () => {
	server.push('playback-time-update', timeUpdate('a', { isFadingOut: true, fadeTimeRemainingMs: 1500 }))
	await until(() => self.variables.cue_1_status === 'fading')
	assert.equal(self.variables.cue_1_is_fading_out, true)
	assert.equal(self.variables.cue_1_is_fading_in, false)
	assert.equal(self.variables.cue_1_fade_remaining_ms, 1500)
	assert.equal(self.variables.cue_1_fade_total_ms, 1500)
	assert.equal(self.variables.current_cue_is_fading_out, true)
})

test('a playing playlist names its current and next item', async () => {
	server.push('playback-time-update', timeUpdate('p', { playlistIndex: 0, nextPlaylistIndex: 1 }))
	await until(() => self.variables.cue_3_status === 'playing')
	assert.equal(self.variables.cue_3_playlist_item_name, 'One')
	assert.equal(self.variables.cue_3_next_playlist_item_name, 'Two')
	assert.equal(self.variables.current_cue_playlist_item_name, 'One')
})

test('a cued playlist shows "cued" and the item it will play next', async () => {
	server.push('cue_status', { cueId: 'p', status: 'cued_next', playlistIndex: 2 })
	await until(() => self.variables.cue_3_status === 'cued')
	assert.equal(self.variables.cue_3_playlist_item_name, 'Three')
})

test("stopping resets the cue's variables and the current cue", async () => {
	server.push('playback-time-update', timeUpdate('a'))
	await until(() => self.variables.current_cue_name === 'Intro')
	server.push('cue_status', { cueId: 'a', status: 'stopped' })
	await until(() => self.variables.cue_1_status === 'stopped')
	assert.equal(self.variables.cue_1_time_formatted, '00:00')
	assert.equal(self.variables.current_cue_name, 'N/A')
	assert.equal(self.variables.current_cue_status, 'stopped')
	assert.equal(self.variables.current_cue_time_sec, 0)
	assert.equal(self.variables.playing_count, 0)
})

test('project name, crossfade mode and master volume variables', async () => {
	server.push('workspace-updated', { workspace: { name: 'Gala' } })
	server.push('crossfade-mode-updated', { enabled: true })
	server.push('master-volume-updated', { volume: 0.8 })
	await until(() => self.variables.master_volume === 80)
	assert.equal(self.variables.project_name, 'Gala')
	assert.equal(self.variables.crossfade_mode, 'on')
	assert.ok(self.checked.includes('crossfade_enabled'))
})

test('a longer cue list adds variables; a rename updates names without redefining', async () => {
	server.push('cues-updated', { cues: [...CUES, { id: 'd', name: 'Outro', type: 'single_file' }] })
	await until(() => self.variables.cue_4_name === 'Outro')
	assert.ok('cue_4_name' in self.variableDefinitions)

	const defs = self.variableDefinitions
	const actions = self.actions
	server.push('cues-updated', { cues: [...CUES, { id: 'd', name: 'Outro', type: 'single_file', volume: 0.3 }] })
	await new Promise((r) => setTimeout(r, 100))
	assert.equal(self.variableDefinitions, defs, 'same list: definitions untouched')
	assert.equal(self.actions, actions)

	server.push('cues-updated', { cues: [...CUES, { id: 'd', name: 'Finale', type: 'single_file' }] })
	await until(() => self.variables.cue_4_name === 'Finale')
	assert.notEqual(self.actions, actions, 'renamed: the cue dropdowns are rebuilt')
})

// --- Actions -----------------------------------------------------------------

test('the action ids of the 1.x module still exist', () => {
	for (const id of [
		'stop_all',
		'play_cue',
		'stop_cue',
		'toggle_cue',
		'playlist_navigate_next',
		'playlist_navigate_previous',
		'playlist_jump_to_item',
	]) {
		assert.ok(self.actions[id], id)
	}
})

test('cue actions list the cues by number and name', () => {
	const option = self.actions.toggle_cue.options.find((o) => o.id === 'cueNumber')
	assert.deepEqual(
		option.choices.map((c) => c.label),
		['1: Intro', '2: Walk-on', '3: Set'],
	)
	assert.equal(option.allowCustom, true)
})

test('Trigger / Play / Pause send the right command for the chosen cue', async () => {
	await self.runAction('toggle_cue', { cueNumber: '2' })
	assert.deepEqual((await server.nextCommand('toggle_cue')).payload, { cueId: 'b', fromCompanion: true })
	await self.runAction('play_cue', { cueNumber: '1' })
	assert.deepEqual((await server.nextCommand('play_cue')).payload, { cueId: 'a' })
	await self.runAction('pause_cue', { cueNumber: '1' })
	assert.deepEqual((await server.nextCommand('toggle_pause_cue')).payload, { cueId: 'a' })
})

test('the cue number can arrive as a number (an expression) or padded text', async () => {
	await self.runAction('toggle_cue', { cueNumber: 3 })
	assert.deepEqual((await server.nextCommand('toggle_cue')).payload, { cueId: 'p', fromCompanion: true })
	await self.runAction('toggle_cue', { cueNumber: ' 2 ' })
	assert.deepEqual((await server.nextCommand('toggle_cue')).payload, { cueId: 'b', fromCompanion: true })
})

test('a cue number with no cue is logged and nothing is sent', async () => {
	await self.runAction('toggle_cue', { cueNumber: '9' })
	await self.runAction('toggle_cue', { cueNumber: 'abc' })
	assert.equal(self.logs.filter((l) => l.level === 'warn' && /no cue/.test(l.text)).length, 2)
	await new Promise((r) => setTimeout(r, 50))
	assert.equal(server.received.filter((m) => m.type === 'toggle_cue').length, 0)
})

test('Stop Cue fades by default (also on buttons made before the option), or cuts', async () => {
	await self.runAction('stop_cue', { cueNumber: '1', fade: true })
	assert.deepEqual((await server.nextCommand('stop_cue')).payload, { cueId: 'a', fadeOut: true })
	await self.runAction('stop_cue', { cueNumber: '1' })
	assert.deepEqual((await server.nextCommand('stop_cue')).payload, { cueId: 'a', fadeOut: true })
	await self.runAction('stop_cue', { cueNumber: '1', fade: false })
	assert.deepEqual((await server.nextCommand('stop_cue')).payload, { cueId: 'a', fadeOut: false })
})

test("Stop All: the app's own behavior, or instantly, or with a fade", async () => {
	assert.equal(self.actions.stop_all.options[0].default, 'app')
	await self.runAction('stop_all', { behavior: 'app' })
	assert.deepEqual((await server.nextCommand('stop_all_cues')).payload, {})
	await self.runAction('stop_all', { behavior: 'stop' })
	assert.deepEqual((await server.nextCommand('stop_all_cues')).payload, { behavior: 'stop' })
	await self.runAction('stop_all', { behavior: 'fade_out_and_stop' })
	assert.deepEqual((await server.nextCommand('stop_all_cues')).payload, { behavior: 'fade_out_and_stop' })
})

test('playlist next / previous', async () => {
	await self.runAction('playlist_navigate_next', { cueNumber: '3' })
	assert.deepEqual((await server.nextCommand('playlist_navigate')).payload, { cueId: 'p', direction: 'next' })
	await self.runAction('playlist_navigate_previous', { cueNumber: '3' })
	assert.deepEqual((await server.nextCommand('playlist_navigate')).payload, { cueId: 'p', direction: 'previous' })
})

test('playlist actions on a cue that is not a playlist are refused', async () => {
	await self.runAction('playlist_navigate_next', { cueNumber: '1' })
	await self.runAction('playlist_jump_to_item', { cueNumber: '1', targetIndex: '0' })
	assert.equal(self.logs.filter((l) => /not a playlist/.test(l.text)).length, 2)
	await new Promise((r) => setTimeout(r, 50))
	assert.ok(!server.received.some((m) => m.type === 'playlist_navigate' || m.type === 'playlist_jump'))
})

test('Jump to Item: a 0-based index (text or a number); out of range is refused', async () => {
	await self.runAction('playlist_jump_to_item', { cueNumber: '3', targetIndex: '2' })
	assert.deepEqual((await server.nextCommand('playlist_jump')).payload, { cueId: 'p', index: 2 })
	await self.runAction('playlist_jump_to_item', { cueNumber: '3', targetIndex: 1 })
	assert.deepEqual((await server.nextCommand('playlist_jump')).payload, { cueId: 'p', index: 1 })

	await self.runAction('playlist_jump_to_item', { cueNumber: '3', targetIndex: '3' })
	await self.runAction('playlist_jump_to_item', { cueNumber: '3', targetIndex: '-1' })
	assert.equal(self.logs.filter((l) => /has items 0-2/.test(l.text)).length, 2)
})

test('Crossfade Mode: on, off, toggle', async () => {
	await self.runAction('crossfade_mode', { mode: 'on' })
	assert.deepEqual((await server.nextCommand('set_crossfade_mode')).payload, { enabled: true })
	await self.runAction('crossfade_mode', { mode: 'off' })
	assert.deepEqual((await server.nextCommand('set_crossfade_mode')).payload, { enabled: false })
	server.push('crossfade-mode-updated', { enabled: true })
	await until(() => self.client.crossfadeEnabled)
	await self.runAction('crossfade_mode', { mode: 'toggle' })
	assert.deepEqual((await server.nextCommand('set_crossfade_mode')).payload, { enabled: false })
})

test('Master Volume: set, adjust, kept within 0-200%', async () => {
	await self.runAction('master_volume', { mode: 'set', percent: 70 })
	assert.deepEqual((await server.nextCommand('set_master_volume')).payload, { volume: 0.7 })
	server.push('master-volume-updated', { volume: 0.7 })
	await until(() => self.client.masterVolume === 0.7)
	await self.runAction('master_volume', { mode: 'adjust', percent: -5 })
	assert.deepEqual((await server.nextCommand('set_master_volume')).payload, { volume: 0.65 })
	await self.runAction('master_volume', { mode: 'adjust', percent: -100 })
	assert.deepEqual((await server.nextCommand('set_master_volume')).payload, { volume: 0 })
	await self.runAction('master_volume', { mode: 'set', percent: 500 })
	assert.deepEqual((await server.nextCommand('set_master_volume')).payload, { volume: 2 })
})

test('an action while disconnected logs that it is not connected', async () => {
	self.client.close()
	await self.runAction('toggle_cue', { cueNumber: '1' })
	assert.ok(self.logs.some((l) => /not connected/.test(l.text)))
})

// --- Feedbacks ---------------------------------------------------------------

test('the feedback ids of the 1.x module still exist', () => {
	for (const id of [
		'cue_is_playing',
		'cue_is_paused',
		'cue_is_stopped',
		'cue_is_fading',
		'cue_is_fading_in',
		'cue_is_fading_out',
	]) {
		assert.ok(self.feedbacks[id], id)
	}
})

async function feedbackStates(cueNumber) {
	const out = {}
	for (const id of Object.keys(self.feedbacks)) {
		if (self.feedbacks[id].options.length) out[id] = await self.feedback(id, { cueNumber })
	}
	return out
}

test('cue feedbacks follow the cue through playing, fading, paused, cued, stopped', async () => {
	assert.deepEqual(await feedbackStates('1'), {
		cue_is_playing: false,
		cue_is_paused: false,
		cue_is_stopped: true,
		cue_is_fading: false,
		cue_is_fading_in: false,
		cue_is_fading_out: false,
		cue_is_active: false,
		cue_is_cued: false,
		cue_is_ducked: false,
	})

	server.push('playback-time-update', timeUpdate('a', { isFadingIn: true, fadeTimeRemainingMs: 400 }))
	await until(() => self.client.stateOf('a').status === 'fading')
	let s = await feedbackStates('1')
	assert.equal(s.cue_is_fading, true)
	assert.equal(s.cue_is_fading_in, true)
	assert.equal(s.cue_is_fading_out, false)
	assert.equal(s.cue_is_playing, false)
	assert.equal(s.cue_is_active, true)
	assert.equal(s.cue_is_stopped, false)

	server.push('playback-time-update', timeUpdate('a', { isFadingOut: true, fadeTimeRemainingMs: 400 }))
	await until(() => self.client.stateOf('a').isFadingOut)
	s = await feedbackStates('1')
	assert.equal(s.cue_is_fading_out, true)
	assert.equal(s.cue_is_fading_in, false)

	server.push('playback-time-update', timeUpdate('a', { isDucked: true }))
	await until(() => self.client.stateOf('a').status === 'playing')
	s = await feedbackStates('1')
	assert.equal(s.cue_is_playing, true)
	assert.equal(s.cue_is_ducked, true)
	assert.equal(s.cue_is_fading, false)

	server.push('cue_status', { cueId: 'a', status: 'paused' })
	await until(() => self.client.stateOf('a').status === 'paused')
	s = await feedbackStates('1')
	assert.equal(s.cue_is_paused, true)
	assert.equal(s.cue_is_active, true)
	assert.equal(s.cue_is_playing, false)

	server.push('cue_status', { cueId: 'a', status: 'stopped' })
	await until(() => self.client.stateOf('a').status === 'stopped')
	s = await feedbackStates('1')
	assert.equal(s.cue_is_stopped, true)
	assert.equal(s.cue_is_ducked, false)
	assert.equal(s.cue_is_active, false)

	server.push('cue_status', { cueId: 'p', status: 'cued_next', playlistIndex: 1 })
	await until(() => self.client.stateOf('p').status === 'cued')
	assert.equal((await feedbackStates('3')).cue_is_cued, true)
})

test('cue feedbacks are re-checked whenever a cue changes', async () => {
	self.checked.length = 0
	server.push('cue_status', { cueId: 'b', status: 'playing' })
	await until(() => self.checked.includes('cue_is_playing'))
	for (const id of ['cue_is_paused', 'cue_is_stopped', 'cue_is_fading_in', 'cue_is_fading_out', 'cue_is_cued']) {
		assert.ok(self.checked.includes(id), id)
	}
})

test('time updates that only move the times neither re-check feedbacks nor resend unchanged variables', async () => {
	server.push('playback-time-update', timeUpdate('b', { currentTimeSec: 2, remainingTimeSec: 8.9 }))
	await until(() => self.client.stateOf('b').status === 'playing')
	self.checked.length = 0
	const sent = []
	const setVariableValues = self.setVariableValues
	self.setVariableValues = (values) => {
		sent.push(values)
		setVariableValues(values)
	}
	try {
		// Four ticks within the same second: nothing Companion shows changes.
		for (const t of [2.1, 2.2, 2.3, 2.4]) {
			server.push('playback-time-update', timeUpdate('b', { currentTimeSec: t, remainingTimeSec: 10.9 - t }))
		}
		await until(() => self.client.stateOf('b').currentTimeSec === 2.4)
		assert.deepEqual(self.checked, [])
		assert.deepEqual(sent, [])

		// The next second: only the times that changed are sent.
		server.push(
			'playback-time-update',
			timeUpdate('b', {
				currentTimeSec: 3.1,
				remainingTimeSec: 7.8,
				currentTimeFormatted: '00:03',
				remainingTimeFormatted: '00:07',
			}),
		)
		await until(() => sent.length > 0)
		assert.deepEqual(self.checked, [])
		assert.deepEqual(sent, [
			{
				cue_2_time_formatted: '00:03',
				cue_2_remaining_formatted: '00:07',
				cue_2_time_sec: 3,
				cue_2_remaining_sec: 7,
				current_cue_time_formatted: '00:03',
				current_cue_remaining_formatted: '00:07',
				current_cue_time_sec: 3,
				current_cue_remaining_sec: 7,
			},
		])

		// A fade starting changes what the feedbacks show: re-checked.
		server.push(
			'playback-time-update',
			timeUpdate('b', { currentTimeSec: 3.2, isFadingOut: true, fadeTimeRemainingMs: 1000 }),
		)
		await until(() => self.checked.includes('cue_is_fading_out'))
	} finally {
		self.setVariableValues = setVariableValues
	}
})

test('cue feedbacks take a number too, and are false for a cue that does not exist', async () => {
	server.push('cue_status', { cueId: 'b', status: 'playing' })
	await until(() => self.client.stateOf('b').status === 'playing')
	assert.equal(await self.feedback('cue_is_playing', { cueNumber: 2 }), true)
	assert.equal(await self.feedback('cue_is_playing', { cueNumber: '7' }), false)
	assert.equal(await self.feedback('cue_is_playing', { cueNumber: '' }), false)
})

test('crossfade and connection feedbacks', async () => {
	assert.equal(await self.feedback('crossfade_enabled'), false)
	server.push('crossfade-mode-updated', { enabled: true })
	await until(() => self.client.crossfadeEnabled)
	assert.equal(await self.feedback('crossfade_enabled'), true)
	assert.equal(await self.feedback('connected'), true)
	self.client.close()
	assert.equal(await self.feedback('connected'), false)
})

// --- Presets -----------------------------------------------------------------

test("presets: a button per cue, with its state colors, using this connection's variables", () => {
	const cue1 = self.presets.cue_1
	assert.equal(cue1.style.text, '$(acc:cue_1_name)')
	assert.deepEqual(cue1.steps[0].down, [{ actionId: 'toggle_cue', options: { cueNumber: '1' } }])
	assert.deepEqual(
		cue1.feedbacks.map((f) => f.feedbackId),
		['cue_is_playing', 'cue_is_paused', 'cue_is_cued', 'cue_is_fading_in', 'cue_is_fading_out'],
	)
	assert.match(self.presets.cue_3.style.text, /cue_3_playlist_item_name/)
	assert.ok(self.presets.cue_1_remaining)
	assert.equal(self.presets.cue_4, undefined)
})

test('presets: next / previous only for playlist cues', () => {
	assert.ok(self.presets.cue_3_next)
	assert.ok(self.presets.cue_3_prev)
	assert.equal(self.presets.cue_1_next, undefined)
	assert.deepEqual(self.presets.cue_3_next.steps[0].down, [
		{ actionId: 'playlist_navigate_next', options: { cueNumber: '3' } },
	])
})

test('presets: every action and feedback they use exists, with the options it takes', () => {
	for (const [id, preset] of Object.entries(self.presets)) {
		assert.equal(preset.type, 'simple', id)
		for (const step of preset.steps) {
			for (const action of [...step.down, ...step.up]) {
				const def = self.actions[action.actionId]
				assert.ok(def, `${id}: ${action.actionId}`)
				for (const key of Object.keys(action.options))
					assert.ok(
						def.options.some((o) => o.id === key),
						`${id}: ${key}`,
					)
			}
		}
		for (const fb of preset.feedbacks) {
			const def = self.feedbacks[fb.feedbackId]
			assert.ok(def, `${id}: ${fb.feedbackId}`)
			for (const key of Object.keys(fb.options))
				assert.ok(
					def.options.some((o) => o.id === key),
					`${id}: ${key}`,
				)
		}
		for (const [, variable] of preset.style.text.matchAll(/\$\(acc:([^)]+)\)/g)) {
			assert.ok(variable in self.variableDefinitions, `${id}: ${variable}`)
		}
	}
	for (const id of [
		'stop_all',
		'crossfade',
		'volume_up',
		'volume_down',
		'current_time',
		'current_remaining',
		'project_name',
	]) {
		assert.ok(self.presets[id], id)
	}
})

test('presets: every preset is listed in exactly one section, and sections list only presets', () => {
	const listed = self.presetStructure.flatMap((section) => section.definitions.flatMap((group) => group.presets))
	assert.deepEqual([...listed].sort(), Object.keys(self.presets).sort())
	assert.deepEqual(
		self.presetStructure.map((s) => s.name),
		['Cues', 'Cue Times', 'Playlists', 'Controls', 'Current Cue'],
	)
	for (const section of self.presetStructure) {
		for (const group of section.definitions) assert.equal(group.type, 'simple')
	}
})

// --- Upgrades, manifest, package -------------------------------------------------

test('upgrade: the old Electron port moves to 3333; other ports are left alone', () => {
	const run = (config) => upgradeToNodeServer({}, { config, actions: [], feedbacks: [] }).updatedConfig
	assert.deepEqual(run({ host: '10.0.0.2', port: 8877, reconnect: true }), {
		host: '10.0.0.2',
		port: 3333,
		reconnect: true,
	})
	assert.equal(run({ host: 'x', port: 8080 }).port, 3333)
	assert.equal(run({ host: 'x', port: 4000 }), null)
	assert.equal(run(null), null)
	assert.deepEqual(UpgradeScripts, [upgradeToNodeServer])
})

test('upgrade: existing Stop All buttons keep fading out', () => {
	const actions = [
		{ id: '1', controlId: 'c', actionId: 'stop_all', options: {} },
		{ id: '2', controlId: 'c', actionId: 'stop_all', options: { behavior: 'stop' } },
		{ id: '3', controlId: 'c', actionId: 'toggle_cue', options: { cueNumber: '1' } },
	]
	const result = upgradeToNodeServer({}, { config: null, actions, feedbacks: [] })
	assert.deepEqual(
		result.updatedActions.map((a) => [a.id, a.options.behavior]),
		[['1', 'fade_out_and_stop']],
	)
})

test('manifest: this module, run from main.js', () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'companion', 'manifest.json'), 'utf8'))
	assert.equal(manifest.id, 'highpass-accompaniment')
	assert.equal(manifest.runtime.entrypoint, '../main.js')
	assert.equal(manifest.runtime.type, 'node22')
	assert.equal(manifest.manufacturer, 'HighPass')
	assert.equal(manifest.type, 'connection')
	assert.ok(fs.existsSync(path.join(__dirname, '..', 'companion', manifest.runtime.entrypoint)))
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
	assert.equal(pkg.name, manifest.id)
	assert.ok(!pkg.dependencies['companion-module-utils'])
	assert.equal(pkg.type, 'module')
})

test('HELP.md documents the right port and every action', () => {
	const help = fs.readFileSync(path.join(__dirname, '..', 'companion', 'HELP.md'), 'utf8')
	assert.match(help, /3333/)
	assert.doesNotMatch(help, /8080|Electron application/)
	for (const def of Object.values(self.actions)) assert.ok(help.includes(def.name), def.name)
	for (const def of Object.values(self.feedbacks)) assert.ok(help.includes(def.name), def.name)
})

test('a client with no server still defines everything (no cues yet)', () => {
	const offline = fakeInstance({ client: new AccompanimentClient({ reconnect: false }) })
	assert.ok(offline.actions.toggle_cue)
	assert.equal(offline.actions.toggle_cue.options[0].choices[0].label, '1: (no cues)')
	assert.ok('current_cue_name' in offline.variableDefinitions)
	assert.ok(offline.presets.stop_all)
	assert.equal(offline.presets.cue_1, undefined)
	assert.ok(!offline.presetStructure.some((s) => s.id === 'cues'), 'no empty sections')
})

test('main.js: the instance class is the default export, next to UpgradeScripts (how base 2 loads a module)', async () => {
	const { InstanceBase } = await import('@companion-module/base')
	const entry = await import('../main.js')
	assert.equal(Object.getPrototypeOf(entry.default), InstanceBase)
	assert.equal(entry.UpgradeScripts, UpgradeScripts)
})
