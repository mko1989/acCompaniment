/**
 * What triggering a cue does when it is already playing or paused - a pure
 * table from (retrigger behavior, current state) to an action, so every
 * combination is unit-testable and none can fall through to "trigger it
 * again" (which used to recurse forever for behaviors the server didn't
 * know, like the UI's toggle_pause_play).
 *
 * Actions: 'restart' | 'pause' | 'resume' | 'stop' | 'fade_stop' |
 *          'nothing' | 'new_instance' | 'next_item'
 */

// Accepted spellings -> canonical behavior. 'pause_resume' and 'pause' are
// older names for the UI's 'toggle_pause_play'.
const BEHAVIOR_ALIASES = {
    pause_resume: 'toggle_pause_play',
    pause: 'toggle_pause_play',
    do_nothing_if_playing: 'do_nothing',
};

const RETRIGGER_BEHAVIORS = [
    'restart',
    'toggle_pause_play',
    'stop',
    'fade_out_and_stop',
    'do_nothing',
    'play_new_instance',
    'replay_current_item',
    'play_next_item',
];

function normalizeRetriggerBehavior(behavior) {
    const canonical = BEHAVIOR_ALIASES[behavior] || behavior;
    return RETRIGGER_BEHAVIORS.includes(canonical) ? canonical : 'restart';
}

/**
 * @param {string} behavior   cue.retriggerBehavior (any accepted spelling)
 * @param {'playing'|'paused'} state
 * @param {boolean} isPlaylist
 */
function resolveRetrigger(behavior, state, isPlaylist = false) {
    const b = normalizeRetriggerBehavior(behavior);

    if (state === 'paused') {
        switch (b) {
            case 'restart':
            case 'replay_current_item':
            case 'play_new_instance':
                // A new instance of a paused cue plays from the top, in
                // place of the paused one (rather than layering over a
                // voice frozen in pause).
                return 'restart';
            case 'stop':
            case 'fade_out_and_stop':
                // A paused cue renders nothing, so it has nothing to fade.
                return 'stop';
            case 'do_nothing':
                return 'nothing';
            case 'play_next_item':
                return isPlaylist ? 'next_item' : 'resume';
            default:
                // toggle_pause_play: carry on from where it was paused.
                return 'resume';
        }
    }

    switch (b) {
        case 'toggle_pause_play':
            return 'pause';
        case 'stop':
            return 'stop';
        case 'fade_out_and_stop':
            return 'fade_stop';
        case 'do_nothing':
            return 'nothing';
        case 'play_new_instance':
            return 'new_instance';
        case 'play_next_item':
            return isPlaylist ? 'next_item' : 'restart';
        default:
            // restart, replay_current_item: start the current item over.
            return 'restart';
    }
}

module.exports = {
    RETRIGGER_BEHAVIORS,
    normalizeRetriggerBehavior,
    resolveRetrigger,
};
