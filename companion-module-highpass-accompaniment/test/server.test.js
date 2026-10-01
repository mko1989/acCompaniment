/**
 * End to end against a real acCompaniment server: the module's client,
 * actions, feedbacks and variables driving and following actual playback.
 *
 * Uses the acCompaniment repo's test harness (a server on a free port with
 * its own temporary data), so it runs only when this module sits inside
 * that repo; elsewhere it's skipped.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

import { connect } from '../instance.js'
import { fakeInstance, until } from './helpers.js'

const appTestHelpers = path.join(import.meta.dirname, '..', '..', 'test', 'helpers')
const available = fs.existsSync(path.join(appTestHelpers, 'harness.js'))

const require = createRequire(import.meta.url)
const server = available ? require(path.join(appTestHelpers, 'harness.js')).useServer() : null
const app = available ? require(path.join(appTestHelpers, 'api.js')).api(server) : null

const skip = !available && 'not inside the acCompaniment repo'
const serverTest = (name, fn) => test(name, { skip, timeout: 30000 }, fn)

/** A module instance connected to the test server, with the cue list in. */
async function instance(expectCueIds = []) {
	const self = fakeInstance({ config: { port: server.port() } })
	connect(self)
	await until(() => self.client.connected, { message: 'connection' })
	await until(() => expectCueIds.every((id) => self.client.cueNumberOf(id)), { message: 'cue list' })
	return self
}

const numberOf = (self, cueId) => String(self.client.cueNumberOf(cueId))

serverTest('connects on the server port and gets the cue list, project, crossfade mode and master volume', async () => {
	const cueId = await app.createCue({ name: 'E2E First' })
	const self = await instance([cueId])
	try {
		const n = numberOf(self, cueId)
		assert.equal(self.variables[`cue_${n}_name`], 'E2E First')
		await until(() => self.variables.project_name, { message: 'project name' })
		assert.equal(self.variables.crossfade_mode, 'off')
		assert.equal(self.variables.master_volume, 100)
		assert.equal(await self.feedback('connected'), true)
	} finally {
		self.client.close()
	}
})

serverTest('Trigger Cue plays it: status, feedback, current cue and running time follow', async () => {
	const cueId = await app.createCue({ name: 'E2E Trigger', retriggerBehavior: 'stop' })
	const self = await instance([cueId])
	try {
		const n = numberOf(self, cueId)
		await self.runAction('toggle_cue', { cueNumber: n })
		await until(() => self.variables[`cue_${n}_status`] === 'playing', { message: 'playing' })
		assert.equal(await self.feedback('cue_is_playing', { cueNumber: n }), true)
		assert.equal(self.variables.current_cue_name, 'E2E Trigger')
		// (Times come with the first playback-time-update, just after the status.)
		await until(() => self.variables[`cue_${n}_duration_formatted`] === '00:10', { message: 'duration' })
		await until(() => self.variables[`cue_${n}_time_sec`] >= 1, { message: 'time running' })
		assert.ok(self.variables[`cue_${n}_remaining_sec`] < 10)

		// Pressed again: its retrigger behavior (stop).
		await self.runAction('toggle_cue', { cueNumber: n })
		await until(() => self.variables[`cue_${n}_status`] === 'stopped', { message: 'stopped' })
		assert.equal(await self.feedback('cue_is_stopped', { cueNumber: n }), true)
		assert.equal(self.variables.current_cue_name, 'N/A')
		assert.equal(self.variables[`cue_${n}_time_formatted`], '00:00')
	} finally {
		await app.stop(cueId)
		self.client.close()
	}
})

serverTest("fades: fading in, then Stop Cue fades out with the cue's fade-out time", async () => {
	const cueId = await app.createCue({ name: 'E2E Fades', fadeInTime: 1200, fadeOutTime: 1200 })
	const self = await instance([cueId])
	try {
		const n = numberOf(self, cueId)
		await self.runAction('play_cue', { cueNumber: n })
		await until(() => self.client.stateOf(cueId).isFadingIn, { message: 'fading in' })
		assert.equal(self.variables[`cue_${n}_status`], 'fading')
		assert.equal(await self.feedback('cue_is_fading_in', { cueNumber: n }), true)
		assert.ok(self.variables[`cue_${n}_fade_total_ms`] > 0)
		await until(() => self.client.stateOf(cueId).status === 'playing', { message: 'fade in done' })

		await self.runAction('stop_cue', { cueNumber: n, fade: true })
		await until(() => self.client.stateOf(cueId).isFadingOut, { message: 'fading out' })
		assert.equal(await self.feedback('cue_is_fading_out', { cueNumber: n }), true)
		await until(() => self.client.stateOf(cueId).status === 'stopped', {
			timeoutMs: 5000,
			message: 'stopped after fade',
		})
	} finally {
		self.client.close()
	}
})

serverTest('Pause / Resume Cue', async () => {
	const cueId = await app.createCue({ name: 'E2E Pause' })
	const self = await instance([cueId])
	try {
		const n = numberOf(self, cueId)
		await self.runAction('play_cue', { cueNumber: n })
		await until(() => self.client.stateOf(cueId).status === 'playing')
		await self.runAction('pause_cue', { cueNumber: n })
		await until(() => self.variables[`cue_${n}_status`] === 'paused', { message: 'paused' })
		assert.equal(await self.feedback('cue_is_paused', { cueNumber: n }), true)
		assert.equal(await self.feedback('cue_is_active', { cueNumber: n }), true)
		await self.runAction('pause_cue', { cueNumber: n })
		await until(() => self.variables[`cue_${n}_status`] === 'playing', { message: 'resumed' })
		await self.runAction('stop_cue', { cueNumber: n, fade: false })
		await until(() => self.client.stateOf(cueId).status === 'stopped')
	} finally {
		self.client.close()
	}
})

serverTest('playlists: next, previous and jump; the item name variables follow', async () => {
	const cueId = await app.createPlaylist(3, { name: 'E2E Playlist' }, 10)
	const self = await instance([cueId])
	try {
		const n = numberOf(self, cueId)
		assert.equal(self.variables[`cue_${n}_playlist_item_name`], 'Item 0')
		await self.runAction('playlist_navigate_next', { cueNumber: n })
		await until(async () => (await app.getCue(cueId)).currentPlaylistIndex === 1, { message: 'next' })
		await until(() => self.variables[`cue_${n}_playlist_item_name`] === 'Item 1', { message: 'idle item name' })
		await self.runAction('playlist_navigate_previous', { cueNumber: n })
		await until(async () => (await app.getCue(cueId)).currentPlaylistIndex === 0, { message: 'previous' })

		await self.runAction('toggle_cue', { cueNumber: n })
		await until(() => self.variables[`cue_${n}_status`] === 'playing')
		assert.equal(self.variables[`cue_${n}_playlist_item_name`], 'Item 0')
		await until(() => self.variables[`cue_${n}_next_playlist_item_name`] === 'Item 1', { message: 'next item' })

		await self.runAction('playlist_jump_to_item', { cueNumber: n, targetIndex: '2' })
		await until(() => self.variables[`cue_${n}_playlist_item_name`] === 'Item 2', { message: 'jumped' })
		assert.equal(self.variables[`cue_${n}_status`], 'playing')
		assert.equal(self.variables.current_cue_playlist_item_name, 'Item 2')
	} finally {
		await app.stop(cueId)
		self.client.close()
	}
})

serverTest('Crossfade Mode toggles, with its feedback and variable', async () => {
	const self = await instance()
	try {
		await self.runAction('crossfade_mode', { mode: 'toggle' })
		await until(() => self.client.crossfadeEnabled, { message: 'crossfade on' })
		assert.equal(await self.feedback('crossfade_enabled'), true)
		assert.equal(self.variables.crossfade_mode, 'on')
		await self.runAction('crossfade_mode', { mode: 'off' })
		await until(() => !self.client.crossfadeEnabled, { message: 'crossfade off' })
	} finally {
		self.client.close()
	}
})

serverTest('Master Volume: set and adjust', async () => {
	const self = await instance()
	try {
		await self.runAction('master_volume', { mode: 'set', percent: 60 })
		await until(() => self.variables.master_volume === 60, { message: 'set' })
		await self.runAction('master_volume', { mode: 'adjust', percent: 15 })
		await until(() => self.variables.master_volume === 75, { message: 'adjusted' })
		await self.runAction('master_volume', { mode: 'set', percent: 100 })
		await until(() => self.variables.master_volume === 100)
	} finally {
		self.client.close()
	}
})

serverTest('Stop All stops everything; playing_count follows', async () => {
	const one = await app.createCue({ name: 'E2E All 1' })
	const two = await app.createCue({ name: 'E2E All 2' })
	await app.stopAll()
	const self = await instance([one, two])
	try {
		await until(() => self.variables.playing_count === 0, { message: 'silence to start from' })
		await self.runAction('play_cue', { cueNumber: numberOf(self, one) })
		await self.runAction('play_cue', { cueNumber: numberOf(self, two) })
		await until(() => self.variables.playing_count === 2, { message: 'two playing' })
		await self.runAction('stop_all', { behavior: 'stop' })
		await until(() => self.variables.playing_count === 0, { message: 'all stopped' })
		assert.equal(self.client.stateOf(one).status, 'stopped')
		assert.equal(self.client.stateOf(two).status, 'stopped')
	} finally {
		self.client.close()
	}
})

serverTest('a cue already playing when the module connects shows as playing', async () => {
	const cueId = await app.createCue({ name: 'E2E Before' })
	await app.playing(cueId)
	const self = await instance([cueId])
	try {
		await until(() => self.client.stateOf(cueId).status === 'playing', { message: 'initial state' })
		assert.equal(self.variables.current_cue_name, 'E2E Before')
	} finally {
		await app.stop(cueId)
		self.client.close()
	}
})

serverTest('renaming the project and adding a cue reach the module', async () => {
	const self = await instance()
	try {
		await app.put('/api/projects/current', { name: 'E2E Show' })
		await until(() => self.variables.project_name === 'E2E Show', { message: 'project name' })
		const cueId = await app.createCue({ name: 'E2E Added' })
		await until(() => self.client.cueNumberOf(cueId), { message: 'new cue' })
		const n = numberOf(self, cueId)
		assert.equal(self.variables[`cue_${n}_name`], 'E2E Added')
		assert.ok(`cue_${n}_status` in self.variableDefinitions)
		assert.ok(self.actions.toggle_cue.options[0].choices.some((c) => c.label === `${n}: E2E Added`))
		assert.ok(self.presets[`cue_${n}`])
	} finally {
		self.client.close()
	}
})
