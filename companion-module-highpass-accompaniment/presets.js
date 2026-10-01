import { combineRgb } from '@companion-module/base'

const WHITE = combineRgb(255, 255, 255)
const BLACK = combineRgb(0, 0, 0)
const GREY = combineRgb(50, 50, 50)
const BLUE = combineRgb(0, 100, 150)

function button(name, text, bgcolor, down = [], feedbacks = []) {
	return {
		type: 'simple',
		name,
		style: { text, size: 'auto', color: WHITE, bgcolor },
		steps: [{ down, up: [] }],
		feedbacks,
	}
}

/**
 * Presets and the sections they're listed in. Returns { structure, presets }
 * for setPresetDefinitions(structure, presets).
 */
export function getPresetDefinitions(self) {
	const v = (name) => `$(${self.label}:${name})`
	const cues = self.client.cues
	const presets = {}
	const groups = { cues: [], times: [], playlists: [], controls: [], current: [] }
	const add = (group, id, preset) => {
		presets[id] = preset
		groups[group].push(id)
	}

	cues.forEach((cue, i) => {
		const n = String(i + 1)
		const opts = { cueNumber: n }
		const label = cue.name || `Cue ${n}`
		add(
			'cues',
			`cue_${n}`,
			button(
				`${n}: ${label}`,
				cue.type === 'playlist' ? `${v(`cue_${n}_name`)}\\n${v(`cue_${n}_playlist_item_name`)}` : v(`cue_${n}_name`),
				BLACK,
				[{ actionId: 'toggle_cue', options: opts }],
				[
					{ feedbackId: 'cue_is_playing', options: opts, style: { bgcolor: combineRgb(0, 160, 0) } },
					{ feedbackId: 'cue_is_paused', options: opts, style: { bgcolor: combineRgb(255, 165, 0), color: BLACK } },
					{ feedbackId: 'cue_is_cued', options: opts, style: { bgcolor: combineRgb(0, 120, 255) } },
					{ feedbackId: 'cue_is_fading_in', options: opts, style: { bgcolor: combineRgb(255, 165, 0), color: BLACK } },
					{ feedbackId: 'cue_is_fading_out', options: opts, style: { bgcolor: combineRgb(255, 100, 0) } },
				],
			),
		)
		add(
			'times',
			`cue_${n}_remaining`,
			button(
				`${n}: ${label} - remaining`,
				`${v(`cue_${n}_name`)}\\n${v(`cue_${n}_remaining_formatted`)}`,
				GREY,
				[],
				[{ feedbackId: 'cue_is_active', options: opts, style: { bgcolor: combineRgb(0, 100, 0) } }],
			),
		)
		if (cue.type === 'playlist') {
			add(
				'playlists',
				`cue_${n}_prev`,
				button(`${label}: previous item`, `◀ PREV\\n${v(`cue_${n}_name`)}`, BLUE, [
					{ actionId: 'playlist_navigate_previous', options: opts },
				]),
			)
			add(
				'playlists',
				`cue_${n}_next`,
				button(`${label}: next item`, `NEXT ▶\\n${v(`cue_${n}_name`)}`, BLUE, [
					{ actionId: 'playlist_navigate_next', options: opts },
				]),
			)
		}
	})

	add(
		'controls',
		'stop_all',
		button('Stop All Audio', 'STOP ALL', combineRgb(200, 0, 0), [
			{ actionId: 'stop_all', options: { behavior: 'app' } },
		]),
	)
	add(
		'controls',
		'crossfade',
		button(
			'Crossfade mode on/off',
			`XFADE\\n${v('crossfade_mode')}`,
			GREY,
			[{ actionId: 'crossfade_mode', options: { mode: 'toggle' } }],
			[{ feedbackId: 'crossfade_enabled', options: {}, style: { bgcolor: combineRgb(255, 200, 0), color: BLACK } }],
		),
	)
	add(
		'controls',
		'volume_down',
		button('Master volume down', `VOL -\\n${v('master_volume')}%`, GREY, [
			{ actionId: 'master_volume', options: { mode: 'adjust', percent: -5 } },
		]),
	)
	add(
		'controls',
		'volume_up',
		button('Master volume up', `VOL +\\n${v('master_volume')}%`, GREY, [
			{ actionId: 'master_volume', options: { mode: 'adjust', percent: 5 } },
		]),
	)
	add(
		'controls',
		'volume_unity',
		button('Master volume 100%', 'VOL\\n100%', GREY, [
			{ actionId: 'master_volume', options: { mode: 'set', percent: 100 } },
		]),
	)
	add(
		'controls',
		'project_name',
		button(
			'Project name',
			v('project_name'),
			GREY,
			[],
			[{ feedbackId: 'connected', options: {}, style: { bgcolor: combineRgb(0, 80, 0) } }],
		),
	)

	add('current', 'current_name', button('Current cue name', v('current_cue_name'), GREY))
	add('current', 'current_time', button('Current time', `TIME\\n${v('current_cue_time_formatted')}`, GREY))
	add('current', 'current_duration', button('Duration', `DURATION\\n${v('current_cue_duration_formatted')}`, GREY))
	add(
		'current',
		'current_remaining',
		button('Remaining time', `REMAINING\\n${v('current_cue_remaining_formatted')}`, GREY),
	)

	const sections = [
		['cues', 'Cues', 'A button per cue: triggers it, coloured by its state'],
		['times', 'Cue Times', 'The remaining time of each cue'],
		['playlists', 'Playlists', 'Previous / next item of each playlist cue'],
		['controls', 'Controls', 'Stop All, crossfade, master volume, project'],
		['current', 'Current Cue', 'The cue started most recently'],
	]
	const structure = sections
		.filter(([id]) => groups[id].length > 0)
		.map(([id, name, description]) => ({
			id,
			name,
			description,
			definitions: [{ id: `${id}_group`, type: 'simple', name, presets: groups[id] }],
		}))

	return { structure, presets }
}
