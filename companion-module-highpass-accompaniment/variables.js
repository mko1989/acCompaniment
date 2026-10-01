/**
 * Companion variables, computed from an AccompanimentClient's state.
 *
 *   project_name, crossfade_mode ('on'/'off'), master_volume (percent),
 *   playing_count
 *   current_cue_*  the cue started most recently that's still playing/paused
 *   cue_N_*        cue N (1-based, in the app's cue order)
 *
 * Per-cue fields: name, status ('playing' | 'paused' | 'fading' | 'cued' |
 * 'stopped'), playlist_item_name, next_playlist_item_name, time/duration/
 * remaining (formatted, and _sec in whole seconds), is_fading_in, is_fading_out,
 * fade_remaining_ms, fade_total_ms, is_ducked.
 */

export const CUE_FIELDS = [
	['name', 'Name'],
	['status', 'Status'],
	['playlist_item_name', 'Playlist Item Name'],
	['next_playlist_item_name', 'Next Playlist Item Name'],
	['time_formatted', 'Time Formatted'],
	['duration_formatted', 'Duration Formatted'],
	['remaining_formatted', 'Remaining Formatted'],
	['time_sec', 'Time (s)'],
	['duration_sec', 'Duration (s)'],
	['remaining_sec', 'Remaining (s)'],
	['is_fading_in', 'Is Fading In'],
	['is_fading_out', 'Is Fading Out'],
	['fade_remaining_ms', 'Fade Remaining (ms)'],
	['fade_total_ms', 'Fade Total (ms)'],
	['is_ducked', 'Is Ducked'],
]

export function getVariableDefinitions(cueCount) {
	const definitions = {
		project_name: { name: 'Project Name' },
		crossfade_mode: { name: 'Crossfade Mode (on/off)' },
		master_volume: { name: 'Master Volume (%)' },
		playing_count: { name: 'Number of Cues Playing' },
	}
	for (const [field, label] of CUE_FIELDS) {
		definitions[`current_cue_${field}`] = { name: `Current Cue ${label}` }
	}
	for (let i = 1; i <= Math.max(0, cueCount || 0); i++) {
		for (const [field, label] of CUE_FIELDS) {
			definitions[`cue_${i}_${field}`] = { name: `Cue ${i} ${label}` }
		}
	}
	return definitions
}

/** The fields of one cue, as `${prefix}_field` values. cueId null = nothing. */
export function cueValues(client, cueId, prefix) {
	const cue = cueId ? client.cues.find((c) => c.id === cueId) : null
	const state = client.stateOf(cueId)
	const active = state.status !== 'stopped'
	const values = {
		name: cue ? cue.name || `Cue ${client.cueNumberOf(cueId)}` : 'N/A',
		status: state.status,
		playlist_item_name: '',
		next_playlist_item_name: '',
		time_formatted: state.currentTimeFormatted,
		duration_formatted: state.totalDurationFormatted,
		remaining_formatted: state.remainingTimeFormatted,
		// Whole seconds, like the _formatted times: fractional ones would
		// change the variables on every 100 ms time update.
		time_sec: Math.floor(state.currentTimeSec),
		duration_sec: Math.floor(state.totalDurationSec),
		remaining_sec: Math.floor(state.remainingTimeSec),
		is_fading_in: state.isFadingIn,
		is_fading_out: state.isFadingOut,
		fade_remaining_ms: state.fadeTimeRemainingMs,
		fade_total_ms: state.fadeTotalDurationMs,
		is_ducked: state.isDucked,
	}
	if (cue && cue.type === 'playlist') {
		// A playing/paused/cued playlist names its item; an idle one names
		// the item it will start with.
		const index = active && state.playlistIndex != null ? state.playlistIndex : cue.currentPlaylistIndex || 0
		values.playlist_item_name = client.playlistItemName(cueId, index)
		if (state.nextPlaylistIndex != null) {
			values.next_playlist_item_name = client.playlistItemName(cueId, state.nextPlaylistIndex)
		}
	}
	const out = {}
	for (const [field, value] of Object.entries(values)) out[`${prefix}_${field}`] = value
	return out
}

export function globalValues(client) {
	return {
		project_name: client.projectName || '',
		crossfade_mode: client.crossfadeEnabled ? 'on' : 'off',
		master_volume: Math.round(client.masterVolume * 100),
		playing_count: Object.values(client.states).filter((s) => ['playing', 'fading'].includes(s.status)).length,
	}
}

/** Values for one cue: its cue_N_* and, if it's the current cue, current_cue_*. */
export function valuesForCue(client, cueId) {
	const values = {}
	const number = client.cueNumberOf(cueId)
	if (number) Object.assign(values, cueValues(client, cueId, `cue_${number}`))
	if (client.currentCueId === cueId) Object.assign(values, cueValues(client, cueId, 'current_cue'))
	values.playing_count = globalValues(client).playing_count
	return values
}

export function allValues(client) {
	const values = { ...globalValues(client), ...cueValues(client, client.currentCueId, 'current_cue') }
	client.cues.forEach((cue, i) => Object.assign(values, cueValues(client, cue.id, `cue_${i + 1}`)))
	return values
}
