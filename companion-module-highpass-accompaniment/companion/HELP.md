# acCompaniment

Controls the [acCompaniment](https://github.com/mko1989/acCompaniment) soundboard: trigger and stop cues, step through playlists, switch crossfade mode and set the master volume, with live cue state, times and fades on your buttons.

## Configuration

- **acCompaniment IP Address**: the machine running acCompaniment (`127.0.0.1` if it's this one).
- **acCompaniment Port**: the port of acCompaniment's web interface, **3333** by default (the address shown in the acCompaniment tray menu and in its settings, under HTTP Remote). The module talks to the same port as the web interface; there is no separate Companion port any more.
- **Attempt Reconnect**: keep trying every 5 seconds when acCompaniment isn't running or the connection drops.

Connections made with version 1.x of this module (port 8877) are moved to 3333 automatically.

## Choosing a cue

Cues are picked by **number**: their position in acCompaniment, 1 = the first cue. Actions offer a list of the current cues; you can also type a number or a variable, e.g. `$(internal:custom_cue)`. If you reorder cues in the app, the numbers follow the new order.

## Actions

- **Trigger Cue**: what clicking the cue in the app does - plays it, or, if it's already playing, applies its retrigger behavior (restart, stop, fade out, pause...).
- **Play Cue**: starts the cue.
- **Stop Cue**: stops the cue, fading out with the cue's own fade-out time (untick _Fade out_ to cut instantly).
- **Pause / Resume Cue**: pauses a playing cue, resumes a paused one.
- **Stop All Audio**: as set in the app's Stop All setting, or choose _Stop instantly_ / _Fade out and stop_.
- **Playlist: Next Item** / **Playlist: Previous Item**: moves a playlist cue to its next / previous item.
- **Playlist: Jump to Item**: plays item N of a playing playlist now (0 = first item), or makes an idle playlist start with it.
- **Crossfade Mode**: on, off or toggle.
- **Master Volume**: set to a percentage (100% = unity, up to 200%) or adjust by some percent.

## Feedbacks

- **Cue is Playing**, **Cue is Paused**, **Cue is Stopped / Inactive**
- **Cue is Fading**, **Cue is Fading In**, **Cue is Fading Out**
- **Cue is Active**: playing, fading or paused.
- **Playlist is Cued**: a playlist that stops after each item is waiting to play its next one.
- **Cue is Ducked**: the cue is turned down by a ducking trigger cue.
- **Crossfade Mode is On**
- **Connected to acCompaniment**

## Variables

- `project_name`, `crossfade_mode` (on/off), `master_volume` (%), `playing_count`
- `current_cue_*`: the cue started most recently that is still playing or paused
- `cue_N_*`: cue number N

Each cue has `name`, `status` (playing, paused, fading, cued, stopped), `playlist_item_name`, `next_playlist_item_name`, `time_formatted`, `duration_formatted`, `remaining_formatted`, `time_sec`, `duration_sec`, `remaining_sec` (whole seconds), `is_fading_in`, `is_fading_out`, `fade_remaining_ms`, `fade_total_ms`, `is_ducked`.

For example `$(accompaniment:cue_1_remaining_formatted)` (use your connection's label).

## Presets

- **Cues**: a button per cue showing its name (and playlist item), coloured by its state.
- **Cue Times**: the remaining time of each cue.
- **Playlists**: next / previous for each playlist cue.
- **Controls**: Stop All, crossfade on/off, master volume up / down / 100%, project name.
- **Current Cue**: name, time, duration and remaining time of the current cue.
