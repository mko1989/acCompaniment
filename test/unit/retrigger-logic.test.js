/**
 * Unit tests for src/backend/retriggerLogic.js - the full table of what
 * pressing a playing or paused cue does, for every behavior the UI offers
 * (and the older spellings saved workspaces may still contain).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    RETRIGGER_BEHAVIORS, normalizeRetriggerBehavior, resolveRetrigger,
} = require('../../src/backend/retriggerLogic');

const UI_OPTIONS = [
    'fade_out_and_stop', 'restart', 'play_new_instance', 'do_nothing',
    'stop', 'toggle_pause_play', 'replay_current_item', 'play_next_item',
];

test('every retrigger option in the UI is a known behavior', () => {
    for (const option of UI_OPTIONS) {
        assert.ok(RETRIGGER_BEHAVIORS.includes(option), `${option} missing`);
        assert.equal(normalizeRetriggerBehavior(option), option);
    }
});

test('older spellings map to their current behavior; unknown ones to restart', () => {
    assert.equal(normalizeRetriggerBehavior('pause_resume'), 'toggle_pause_play');
    assert.equal(normalizeRetriggerBehavior('pause'), 'toggle_pause_play');
    assert.equal(normalizeRetriggerBehavior('do_nothing_if_playing'), 'do_nothing');
    assert.equal(normalizeRetriggerBehavior('something_else'), 'restart');
    assert.equal(normalizeRetriggerBehavior(undefined), 'restart');
});

const PLAYING = {
    restart: 'restart',
    toggle_pause_play: 'pause',
    stop: 'stop',
    fade_out_and_stop: 'fade_stop',
    do_nothing: 'nothing',
    play_new_instance: 'new_instance',
    replay_current_item: 'restart',
};

for (const [behavior, action] of Object.entries(PLAYING)) {
    test(`playing + ${behavior} -> ${action}`, () => {
        assert.equal(resolveRetrigger(behavior, 'playing', false), action);
        assert.equal(resolveRetrigger(behavior, 'playing', true), action);
    });
}

test('playing + play_next_item skips to the next item on a playlist, restarts a single file', () => {
    assert.equal(resolveRetrigger('play_next_item', 'playing', true), 'next_item');
    assert.equal(resolveRetrigger('play_next_item', 'playing', false), 'restart');
});

const PAUSED = {
    restart: 'restart',
    toggle_pause_play: 'resume',
    stop: 'stop',
    fade_out_and_stop: 'stop',
    do_nothing: 'nothing',
    play_new_instance: 'restart',
    replay_current_item: 'restart',
};

for (const [behavior, action] of Object.entries(PAUSED)) {
    test(`paused + ${behavior} -> ${action}`, () => {
        assert.equal(resolveRetrigger(behavior, 'paused', false), action);
    });
}

test('paused + play_next_item skips on a playlist, resumes a single file', () => {
    assert.equal(resolveRetrigger('play_next_item', 'paused', true), 'next_item');
    assert.equal(resolveRetrigger('play_next_item', 'paused', false), 'resume');
});

test('no behavior, in any state, resolves to "trigger again" (the old infinite recursion)', () => {
    const actions = new Set(['restart', 'pause', 'resume', 'stop', 'fade_stop', 'nothing', 'new_instance', 'next_item']);
    for (const behavior of [...UI_OPTIONS, 'pause_resume', 'bogus', undefined]) {
        for (const state of ['playing', 'paused']) {
            for (const isPlaylist of [true, false]) {
                assert.ok(actions.has(resolveRetrigger(behavior, state, isPlaylist)));
            }
        }
    }
});
