/**
 * AccompanimentClient against a fake server: the connection, the exact
 * commands it sends, and how it turns the server's events into cue state.
 */

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { AccompanimentClient, DEFAULT_PORT, statusFromCueStatus } from '../client.js'
import { fakeServer, until } from './helpers.js'

let server
let client

const CUES = [
	{ id: 'a', name: 'Intro', type: 'single_file' },
	{ id: 'b', name: 'Walk-on', type: 'single_file' },
	{
		id: 'p',
		name: 'Set',
		type: 'playlist',
		currentPlaylistIndex: 0,
		playlistItems: [{ name: 'One' }, { name: 'Two' }, { name: 'Three' }],
	},
]

function timeUpdate(cueId, extra = {}) {
	return {
		cueId,
		status: 'playing',
		currentTimeSec: 1,
		totalDurationSec: 10,
		remainingTimeSec: 9,
		currentTimeFormatted: '00:01',
		totalDurationFormatted: '00:10',
		remainingTimeFormatted: '00:09',
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

async function connected(options = {}) {
	client = new AccompanimentClient({ port: server.port, reconnect: false, ...options })
	client.connect()
	await until(() => client.connected, { message: 'connection' })
	return client
}

async function withCues() {
	await connected()
	server.push('cues-updated', { cues: CUES })
	await until(() => client.cues.length === 3, { message: 'cue list' })
}

beforeEach(async () => {
	server = await fakeServer()
})

afterEach(async () => {
	client?.close()
	client = null
	await server.close()
})

test('defaults to 127.0.0.1 on the server port, 3333', () => {
	const c = new AccompanimentClient()
	assert.equal(DEFAULT_PORT, 3333)
	assert.equal(c.url, 'ws://127.0.0.1:3333')
})

test('reports connecting, then connected', async () => {
	const seen = []
	client = new AccompanimentClient({ port: server.port, reconnect: false })
	client.on('connection', (status) => seen.push(status))
	client.connect()
	await until(() => client.connected)
	assert.deepEqual(seen, ['connecting', 'connected'])
})

test('a refused connection reports an error and is retried when reconnect is on', async () => {
	const port = server.port
	await server.close()
	const seen = []
	client = new AccompanimentClient({ port, reconnect: true, reconnectDelayMs: 50 })
	client.on('connection', (status) => seen.push(status))
	client.connect()
	await until(() => seen.filter((s) => s === 'connecting').length >= 2, { message: 'a retry' })
	assert.ok(seen.includes('error'))
	assert.ok(seen.includes('disconnected'))
	client.close()
	server = await fakeServer() // (for afterEach)
})

test('without reconnect a lost connection stays lost', async () => {
	await connected()
	const seen = []
	client.on('connection', (status) => seen.push(status))
	server.dropClients()
	await until(() => seen.includes('disconnected'))
	await new Promise((r) => setTimeout(r, 150))
	assert.ok(!seen.includes('connecting'))
})

test('reconnects after the server drops it', async () => {
	await connected({ reconnect: true, reconnectDelayMs: 50 })
	server.dropClients()
	await until(() => !client.connected)
	await until(() => client.connected, { message: 'reconnection' })
})

test('close() stops reconnecting', async () => {
	await connected({ reconnect: true, reconnectDelayMs: 50 })
	client.close()
	await new Promise((r) => setTimeout(r, 200))
	assert.equal(client.connected, false)
	assert.equal(server.clientCount(), 0)
})

test('commands are sent as {type, payload} in the server protocol', async () => {
	await connected()
	const cases = [
		[() => client.toggleCue('a'), 'toggle_cue', { cueId: 'a', fromCompanion: true }],
		[() => client.playCue('a'), 'play_cue', { cueId: 'a' }],
		[() => client.stopCue('a'), 'stop_cue', { cueId: 'a', fadeOut: false }],
		[() => client.stopCue('a', { fade: true }), 'stop_cue', { cueId: 'a', fadeOut: true }],
		[() => client.stopAll(), 'stop_all_cues', {}],
		[() => client.stopAll('stop'), 'stop_all_cues', { behavior: 'stop' }],
		[() => client.stopAll('fade_out_and_stop'), 'stop_all_cues', { behavior: 'fade_out_and_stop' }],
		[() => client.togglePause('a'), 'toggle_pause_cue', { cueId: 'a' }],
		[() => client.playlistNext('p'), 'playlist_navigate', { cueId: 'p', direction: 'next' }],
		[() => client.playlistPrevious('p'), 'playlist_navigate', { cueId: 'p', direction: 'previous' }],
		[() => client.playlistJump('p', 2), 'playlist_jump', { cueId: 'p', index: 2 }],
		[() => client.setCrossfade(true), 'set_crossfade_mode', { enabled: true }],
		[() => client.setMasterVolume(0.5), 'set_master_volume', { volume: 0.5 }],
	]
	for (const [send, type, payload] of cases) {
		assert.equal(send(), true)
		const message = await server.nextCommand(type)
		assert.deepEqual(message.payload, payload, type)
	}
})

test('commands while disconnected are not sent and return false', () => {
	client = new AccompanimentClient({ reconnect: false })
	assert.equal(client.toggleCue('a'), false)
})

test('cues-updated: the cue list, cue numbers and lookups', async () => {
	await withCues()
	assert.equal(client.cueByNumber('2').id, 'b')
	assert.equal(client.cueByNumber(3).id, 'p')
	assert.equal(client.cueByNumber('4'), null)
	assert.equal(client.cueByNumber('0'), null)
	assert.equal(client.cueByNumber('x'), null)
	assert.equal(client.cueNumberOf('p'), 3)
	assert.equal(client.cueNumberOf('zz'), null)
	assert.equal(client.playlistItemName('p', 1), 'Two')
	assert.equal(client.playlistItemName('p', 9), '')
	assert.equal(client.playlistItemName('a', 0), '')
})

test("the server's cue_status values map to the module's statuses", () => {
	assert.equal(statusFromCueStatus('playing'), 'playing')
	assert.equal(statusFromCueStatus('paused'), 'paused')
	assert.equal(statusFromCueStatus('cued_next'), 'cued')
	assert.equal(statusFromCueStatus('stopped'), 'stopped')
	assert.equal(statusFromCueStatus('completed'), 'stopped')
})

test('cue_status playing / paused / stopped update the cue', async () => {
	await withCues()
	const events = []
	client.on('cue', (id) => events.push(id))
	server.push('cue_status', { cueId: 'a', status: 'playing' })
	await until(() => client.stateOf('a').status === 'playing')
	server.push('cue_status', { cueId: 'a', status: 'paused' })
	await until(() => client.stateOf('a').status === 'paused')
	server.push('cue_status', { cueId: 'a', status: 'completed' })
	await until(() => client.stateOf('a').status === 'stopped')
	assert.deepEqual(events, ['a', 'a', 'a'])
})

test('playback-time-update carries the times; stopping resets them', async () => {
	await withCues()
	server.push(
		'playback-time-update',
		timeUpdate('a', { currentTimeSec: 3.5, currentTimeFormatted: '00:03', remainingTimeFormatted: '00:06' }),
	)
	await until(() => client.stateOf('a').currentTimeSec === 3.5)
	const state = client.stateOf('a')
	assert.equal(state.status, 'playing')
	assert.equal(state.currentTimeFormatted, '00:03')
	assert.equal(state.remainingTimeFormatted, '00:06')
	assert.equal(state.totalDurationSec, 10)

	server.push('cue_status', { cueId: 'a', status: 'stopped' })
	await until(() => client.stateOf('a').status === 'stopped')
	assert.equal(client.stateOf('a').currentTimeSec, 0)
	assert.equal(client.stateOf('a').currentTimeFormatted, '00:00')
})

test('a fade is status "fading", with direction, time left and total', async () => {
	await withCues()
	server.push('playback-time-update', timeUpdate('a', { isFadingIn: true, fadeTimeRemainingMs: 2000 }))
	await until(() => client.stateOf('a').status === 'fading')
	assert.equal(client.stateOf('a').isFadingIn, true)
	assert.equal(client.stateOf('a').fadeTotalDurationMs, 2000)

	server.push('playback-time-update', timeUpdate('a', { isFadingIn: true, fadeTimeRemainingMs: 1200 }))
	await until(() => client.stateOf('a').fadeTimeRemainingMs === 1200)
	assert.equal(client.stateOf('a').fadeTotalDurationMs, 2000, 'the total is the longest time left seen')

	server.push('playback-time-update', timeUpdate('a'))
	await until(() => client.stateOf('a').status === 'playing')
	assert.equal(client.stateOf('a').fadeTotalDurationMs, 0)

	server.push('playback-time-update', timeUpdate('a', { isFadingOut: true, fadeTimeRemainingMs: 800 }))
	await until(() => client.stateOf('a').isFadingOut)
	assert.equal(client.stateOf('a').status, 'fading')
	assert.equal(client.stateOf('a').fadeTotalDurationMs, 800, 'a new fade starts a new total')
})

test('a paused cue is never "fading"', async () => {
	await withCues()
	server.push('playback-time-update', timeUpdate('a', { status: 'paused', isFadingIn: true, fadeTimeRemainingMs: 500 }))
	await until(() => client.stateOf('a').status === 'paused')
	assert.equal(client.stateOf('a').fadeTimeRemainingMs, 0)
})

test('ducking, voices and playlist position come from time updates', async () => {
	await withCues()
	server.push(
		'playback-time-update',
		timeUpdate('p', { isDucked: true, voiceCount: 2, playlistIndex: 1, nextPlaylistIndex: 2 }),
	)
	await until(() => client.stateOf('p').isDucked)
	const state = client.stateOf('p')
	assert.equal(state.voiceCount, 2)
	assert.equal(state.playlistIndex, 1)
	assert.equal(state.nextPlaylistIndex, 2)
})

test('cued_next makes a playlist "cued" with its next item', async () => {
	await withCues()
	server.push('cue_status', { cueId: 'p', status: 'cued_next', playlistIndex: 2 })
	await until(() => client.stateOf('p').status === 'cued')
	assert.equal(client.stateOf('p').playlistIndex, 2)
})

test('the current cue is the most recently started one; it falls back when that stops', async () => {
	await withCues()
	const current = []
	client.on('current', (id) => current.push(id))
	server.push('cue_status', { cueId: 'a', status: 'playing' })
	await until(() => client.currentCueId === 'a')
	await new Promise((r) => setTimeout(r, 5))
	server.push('cue_status', { cueId: 'b', status: 'playing' })
	await until(() => client.currentCueId === 'b')

	// Pausing and resuming a cue doesn't make it current again.
	server.push('cue_status', { cueId: 'a', status: 'paused' })
	server.push('cue_status', { cueId: 'a', status: 'playing' })
	await until(() => client.stateOf('a').status === 'playing')
	assert.equal(client.currentCueId, 'b')

	server.push('cue_status', { cueId: 'b', status: 'stopped' })
	await until(() => client.currentCueId === 'a')
	server.push('cue_status', { cueId: 'a', status: 'stopped' })
	await until(() => client.currentCueId === null)
	assert.deepEqual(current, ['a', 'b', 'a', null])
})

test('time updates and fades alone also make a cue current', async () => {
	await withCues()
	server.push('playback-time-update', timeUpdate('b', { isFadingIn: true, fadeTimeRemainingMs: 300 }))
	await until(() => client.currentCueId === 'b')
})

test('a cue removed from the list is forgotten, and stops being current', async () => {
	await withCues()
	server.push('cue_status', { cueId: 'a', status: 'playing' })
	await until(() => client.currentCueId === 'a')
	server.push('cues-updated', { cues: CUES.filter((c) => c.id !== 'a') })
	await until(() => client.cues.length === 2)
	assert.equal(client.currentCueId, null)
	assert.equal(client.stateOf('a').status, 'stopped')
	assert.equal(client.cueNumberOf('b'), 1, 'numbers follow the new order')
})

test('project name, crossfade mode and master volume', async () => {
	await connected()
	const events = []
	for (const name of ['project', 'crossfade', 'masterVolume']) client.on(name, (v) => events.push([name, v]))
	server.push('workspace-updated', { workspace: { name: 'Friday Show' } })
	server.push('crossfade-mode-updated', { enabled: true })
	server.push('master-volume-updated', { volume: 0.75 })
	await until(() => client.masterVolume === 0.75)
	assert.equal(client.projectName, 'Friday Show')
	assert.equal(client.crossfadeEnabled, true)
	assert.deepEqual(events, [
		['project', 'Friday Show'],
		['crossfade', true],
		['masterVolume', 0.75],
	])
})

test('losing the connection clears playback state (nothing is known to be playing)', async () => {
	await withCues()
	server.push('cue_status', { cueId: 'a', status: 'playing' })
	await until(() => client.currentCueId === 'a')
	server.dropClients()
	await until(() => !client.connected)
	assert.equal(client.stateOf('a').status, 'stopped')
	assert.equal(client.currentCueId, null)
	assert.equal(client.cues.length, 3, 'the cue list is kept (names stay on buttons)')
})

test('unknown and malformed messages are ignored', async () => {
	await withCues()
	server.push('something-new', { x: 1 })
	server.push('cue_status', {})
	server.push('playback-time-update', {})
	server.pushRaw('not json')
	server.push('cue_status', { cueId: 'b', status: 'playing' })
	await until(() => client.stateOf('b').status === 'playing')
})
