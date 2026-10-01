import { combineRgb } from '@companion-module/base'

/**
 * Boolean feedbacks. Cue feedbacks take a cue number (1-based, in the app's
 * cue order). Companion resolves variables/expressions in it before the
 * callback runs.
 */

const cueNumberOption = {
	type: 'textinput',
	label: 'Cue Number (1-based)',
	id: 'cueNumber',
	default: '1',
	useVariables: true,
	tooltip: "The cue's position in the app (1 = first cue). Variables are allowed.",
}

/** Whether a cue's state matches - `test(state)` - for the cue the options name. */
function cueFeedback(self, name, description, defaultStyle, test) {
	return {
		type: 'boolean',
		name,
		description,
		defaultStyle,
		options: [cueNumberOption],
		callback: (feedback) => {
			const cue = self.client.cueByNumber(String(feedback.options.cueNumber ?? '').trim())
			return test(self.client.stateOf(cue ? cue.id : null), cue)
		},
	}
}

const BLACK = combineRgb(0, 0, 0)
const WHITE = combineRgb(255, 255, 255)

export function getFeedbackDefinitions(self) {
	return {
		cue_is_playing: cueFeedback(
			self,
			'Cue is Playing',
			'The cue is playing (not paused, not fading).',
			{ color: BLACK, bgcolor: combineRgb(0, 255, 0) },
			(s) => s.status === 'playing',
		),
		cue_is_paused: cueFeedback(
			self,
			'Cue is Paused',
			'The cue is paused.',
			{ color: BLACK, bgcolor: combineRgb(255, 165, 0) },
			(s) => s.status === 'paused',
		),
		cue_is_stopped: cueFeedback(
			self,
			'Cue is Stopped / Inactive',
			'The cue is not playing, paused or cued.',
			{ color: WHITE, bgcolor: BLACK },
			(s) => s.status === 'stopped',
		),
		cue_is_fading: cueFeedback(
			self,
			'Cue is Fading',
			'The cue is fading in or out.',
			{ color: BLACK, bgcolor: combineRgb(255, 165, 0) },
			(s) => s.status === 'fading',
		),
		cue_is_fading_in: cueFeedback(
			self,
			'Cue is Fading In',
			'The cue is fading in.',
			{ color: BLACK, bgcolor: combineRgb(255, 165, 0) },
			(s) => s.status === 'fading' && s.isFadingIn,
		),
		cue_is_fading_out: cueFeedback(
			self,
			'Cue is Fading Out',
			'The cue is fading out.',
			{ color: WHITE, bgcolor: combineRgb(255, 100, 0) },
			(s) => s.status === 'fading' && s.isFadingOut,
		),
		cue_is_active: cueFeedback(
			self,
			'Cue is Active',
			'The cue is playing, fading or paused.',
			{ color: BLACK, bgcolor: combineRgb(0, 160, 0) },
			(s) => ['playing', 'fading', 'paused'].includes(s.status),
		),
		cue_is_cued: cueFeedback(
			self,
			'Playlist is Cued',
			'A playlist cue has finished an item and waits to play the next one.',
			{ color: BLACK, bgcolor: combineRgb(0, 120, 255) },
			(s) => s.status === 'cued',
		),
		cue_is_ducked: cueFeedback(
			self,
			'Cue is Ducked',
			'The cue is playing turned down by a ducking trigger cue.',
			{ color: WHITE, bgcolor: combineRgb(90, 60, 160) },
			(s) => s.isDucked && s.status !== 'stopped',
		),
		crossfade_enabled: {
			type: 'boolean',
			name: 'Crossfade Mode is On',
			description: 'Crossfade mode is switched on in the app.',
			defaultStyle: { color: BLACK, bgcolor: combineRgb(255, 200, 0) },
			options: [],
			callback: () => self.client.crossfadeEnabled,
		},
		connected: {
			type: 'boolean',
			name: 'Connected to acCompaniment',
			description: 'The module is connected to the app.',
			defaultStyle: { color: BLACK, bgcolor: combineRgb(0, 200, 0) },
			options: [],
			callback: () => self.client.connected,
		},
	}
}

export const CUE_FEEDBACK_IDS = [
	'cue_is_playing',
	'cue_is_paused',
	'cue_is_stopped',
	'cue_is_fading',
	'cue_is_fading_in',
	'cue_is_fading_out',
	'cue_is_active',
	'cue_is_cued',
	'cue_is_ducked',
]
