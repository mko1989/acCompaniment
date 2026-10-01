/**
 * Actions. Cue actions pick a cue by number (1-based, in the app's cue
 * order) from a list of the app's cues, or take a typed number / variable.
 * Companion resolves variables/expressions in options before callbacks run.
 */

function cueNumberOption(self) {
	return {
		type: 'dropdown',
		id: 'cueNumber',
		label: 'Cue',
		default: '1',
		allowCustom: true,
		tooltip: 'Pick a cue, or type its number (1 = first cue). Variables are allowed.',
		choices:
			self.client.cues.length > 0
				? self.client.cues.map((cue, i) => ({ id: String(i + 1), label: `${i + 1}: ${cue.name || cue.id}` }))
				: [{ id: '1', label: '1: (no cues)' }],
	}
}

const text = (value) => String(value ?? '').trim()

export function getActionDefinitions(self) {
	const client = self.client
	const cueOption = cueNumberOption(self)

	/** An action on one cue: resolves the cue, then `run(cue, options)`. */
	function cueAction(name, extraOptions, run, { playlistOnly = false } = {}) {
		return {
			name,
			options: [cueOption, ...extraOptions],
			callback: async (action) => {
				const number = text(action.options.cueNumber)
				const cue = client.cueByNumber(number)
				if (!cue) {
					self.log('warn', `${name}: there is no cue ${number}`)
					return
				}
				if (playlistOnly && cue.type !== 'playlist') {
					self.log('warn', `${name}: cue ${number} (${cue.name}) is not a playlist`)
					return
				}
				if ((await run(cue, action.options)) === false) {
					self.log('warn', `${name}: not connected to acCompaniment`)
				}
			},
		}
	}

	return {
		toggle_cue: cueAction('Trigger Cue', [], (cue) => client.toggleCue(cue.id)),

		play_cue: cueAction('Play Cue', [], (cue) => client.playCue(cue.id)),

		stop_cue: cueAction(
			'Stop Cue',
			[
				{
					type: 'checkbox',
					id: 'fade',
					label: "Fade out (using the cue's fade-out time)",
					default: true,
				},
			],
			// (Buttons made before this option existed have no value: fade.)
			(cue, options) => client.stopCue(cue.id, { fade: options.fade !== false }),
		),

		pause_cue: cueAction('Pause / Resume Cue', [], (cue) => client.togglePause(cue.id)),

		stop_all: {
			name: 'Stop All Audio',
			options: [
				{
					type: 'dropdown',
					id: 'behavior',
					label: 'How',
					default: 'app',
					choices: [
						{ id: 'app', label: 'As set in the app (Stop All behavior)' },
						{ id: 'stop', label: 'Stop instantly' },
						{ id: 'fade_out_and_stop', label: 'Fade out and stop' },
					],
				},
			],
			callback: (action) => {
				const behavior = action.options.behavior
				client.stopAll(behavior === 'stop' || behavior === 'fade_out_and_stop' ? behavior : undefined)
			},
		},

		playlist_navigate_next: cueAction('Playlist: Next Item', [], (cue) => client.playlistNext(cue.id), {
			playlistOnly: true,
		}),

		playlist_navigate_previous: cueAction('Playlist: Previous Item', [], (cue) => client.playlistPrevious(cue.id), {
			playlistOnly: true,
		}),

		playlist_jump_to_item: cueAction(
			'Playlist: Jump to Item',
			[
				{
					type: 'textinput',
					id: 'targetIndex',
					label: 'Item index (0 = first item)',
					default: '0',
					useVariables: true,
					tooltip: 'If the playlist is playing, it plays this item now; otherwise it will start with it.',
				},
			],
			(cue, options) => {
				const index = parseInt(text(options.targetIndex), 10)
				const count = (cue.playlistItems || []).length
				if (!Number.isInteger(index) || index < 0 || index >= count) {
					self.log('warn', `Playlist: Jump to Item: ${cue.name} has items 0-${Math.max(0, count - 1)}`)
					return true
				}
				return client.playlistJump(cue.id, index)
			},
			{ playlistOnly: true },
		),

		crossfade_mode: {
			name: 'Crossfade Mode',
			options: [
				{
					type: 'dropdown',
					id: 'mode',
					label: 'Set to',
					default: 'toggle',
					choices: [
						{ id: 'toggle', label: 'Toggle' },
						{ id: 'on', label: 'On' },
						{ id: 'off', label: 'Off' },
					],
				},
			],
			callback: (action) => {
				const mode = action.options.mode
				client.setCrossfade(mode === 'toggle' ? !client.crossfadeEnabled : mode === 'on')
			},
		},

		master_volume: {
			name: 'Master Volume',
			options: [
				{
					type: 'dropdown',
					id: 'mode',
					label: 'Mode',
					default: 'set',
					choices: [
						{ id: 'set', label: 'Set to' },
						{ id: 'adjust', label: 'Adjust by' },
					],
				},
				{
					type: 'number',
					id: 'percent',
					label: 'Percent (100 = unity, up to 200)',
					default: 100,
					min: -200,
					max: 200,
					step: 1,
				},
			],
			callback: (action) => {
				const percent = Number(action.options.percent) || 0
				const target = action.options.mode === 'adjust' ? client.masterVolume * 100 + percent : percent
				client.setMasterVolume(Math.max(0, Math.min(200, Math.round(target))) / 100)
			},
		},
	}
}
