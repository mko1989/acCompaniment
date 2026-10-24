/**
 * Turns a recording of position-encoded tones (signals.js) back into what
 * was playing: per band and per moment, how loud it was and which
 * segment(s) of the file were sounding.
 *
 * The recording is cut into 2048-sample Hann windows every `hopSec`; each
 * window is FFT'd once and summarised per band:
 *   - level: the amplitude of everything in the band (Parseval over the
 *     band's bins), so it reads the tone's peak amplitude exactly whatever
 *     segment is playing - this is what fades, volumes and ducking are
 *     measured with;
 *   - slots: the amplitude at each segment frequency, to decode position.
 */

const { FFT_SIZE, SLOTS, BAND_BASE_BINS, slotFrequency } = require('./signals');

const BAND_COUNT = BAND_BASE_BINS.length;
// Below this a band counts as silent. The generated tones are 0.5 peak, so
// even a cue at volume 0.05 (0.025) is well clear of it, and a virtual
// loopback device's floor is digital silence.
const SILENCE = 0.004;

function makeFft(n) {
    const levels = Math.log2(n);
    if (!Number.isInteger(levels)) throw new Error('FFT size must be a power of 2');
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
        let r = 0;
        for (let b = 0; b < levels; b++) r = (r << 1) | ((i >>> b) & 1);
        rev[i] = r;
    }
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
        cos[i] = Math.cos((2 * Math.PI * i) / n);
        sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    const re = new Float64Array(n);
    const im = new Float64Array(n);

    /** In: real input (length n). Out: |X_k|^2 for k in [0, n/2]. */
    return function powerSpectrum(input, out) {
        for (let i = 0; i < n; i++) {
            re[rev[i]] = input[i];
            im[rev[i]] = 0;
        }
        for (let size = 2; size <= n; size *= 2) {
            const half = size / 2;
            const step = n / size;
            for (let start = 0; start < n; start += size) {
                for (let k = 0; k < half; k++) {
                    const a = start + k;
                    const b = a + half;
                    const wr = cos[k * step];
                    const wi = -sin[k * step];
                    const tr = re[b] * wr - im[b] * wi;
                    const ti = re[b] * wi + im[b] * wr;
                    re[b] = re[a] - tr;
                    im[b] = im[a] - ti;
                    re[a] += tr;
                    im[a] += ti;
                }
            }
        }
        for (let k = 0; k <= n / 2; k++) out[k] = re[k] * re[k] + im[k] * im[k];
        return out;
    };
}

class Analysis {
    /**
     * @param {{samples: Float32Array, channels: number, sampleRate: number}} recording
     * @param {{hopSec?: number}} [options]
     */
    constructor(recording, { hopSec = 0.01 } = {}) {
        const { samples, channels, sampleRate } = recording;
        this.channels = channels;
        this.sampleRate = sampleRate;
        this.hopSec = hopSec;
        this.durationSec = samples.length / channels / sampleRate;

        const n = FFT_SIZE;
        const binHz = sampleRate / n;
        const hop = Math.max(1, Math.round(hopSec * sampleRate));
        const totalFrames = Math.floor(samples.length / channels);
        const windowCount = Math.max(0, Math.floor((totalFrames - n) / hop) + 1);

        const window = new Float64Array(n);
        let windowPower = 0;
        for (let i = 0; i < n; i++) {
            window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
            windowPower += window[i] * window[i];
        }
        // |X|^2 summed over a tone's bins * scale = (peak amplitude)^2.
        const scale = 4 / (n * windowPower);

        // Bins of every slot and band, at this recording's rate (a 44.1 kHz
        // engine moves them off the 48 kHz bin centres - nearest bin wins).
        const slotBins = [];
        const bandRanges = [];
        for (let b = 0; b < BAND_COUNT; b++) {
            const bins = [];
            for (let s = 0; s < SLOTS; s++) bins.push(Math.round(slotFrequency(b, s) / binHz));
            slotBins.push(bins);
            bandRanges.push([bins[0] - 2, bins[SLOTS - 1] + 2]);
        }

        // levels[ch][band][w], slots[ch][band][w * SLOTS + s]
        this.levels = [];
        this.slots = [];
        this.peakBins = []; // [ch][band][w]: interpolated peak bin, for pitch checks
        const fft = makeFft(n);
        const frame = new Float64Array(n);
        const power = new Float64Array(n / 2 + 1);

        for (let c = 0; c < channels; c++) {
            const chLevels = [];
            const chSlots = [];
            const chPeaks = [];
            for (let b = 0; b < BAND_COUNT; b++) {
                chLevels.push(new Float32Array(windowCount));
                chSlots.push(new Float32Array(windowCount * SLOTS));
                chPeaks.push(new Float32Array(windowCount));
            }
            for (let w = 0; w < windowCount; w++) {
                const start = w * hop;
                for (let i = 0; i < n; i++) frame[i] = samples[(start + i) * channels + c] * window[i];
                fft(frame, power);
                for (let b = 0; b < BAND_COUNT; b++) {
                    const [lo, hi] = bandRanges[b];
                    let sum = 0;
                    let peak = lo;
                    for (let k = lo; k <= hi; k++) {
                        sum += power[k];
                        if (power[k] > power[peak]) peak = k;
                    }
                    chLevels[b][w] = Math.sqrt(sum * scale);
                    // Parabolic interpolation on log power around the peak.
                    const a = Math.log(power[peak - 1] + 1e-30);
                    const m = Math.log(power[peak] + 1e-30);
                    const z = Math.log(power[peak + 1] + 1e-30);
                    const denom = a - 2 * m + z;
                    chPeaks[b][w] = peak + (denom !== 0 ? (0.5 * (a - z)) / denom : 0);
                    for (let s = 0; s < SLOTS; s++) {
                        const k = slotBins[b][s];
                        chSlots[b][w * SLOTS + s] = Math.sqrt((power[k - 1] + power[k] + power[k + 1]) * scale);
                    }
                }
            }
            this.levels.push(chLevels);
            this.slots.push(chSlots);
            this.peakBins.push(chPeaks);
        }
        this.windowCount = windowCount;
        this.hop = hop;
        this.binHz = binHz;
    }

    /** Recording time (s) of window w's centre, and the window at time t. */
    timeOf(w) {
        return (w * this.hop + FFT_SIZE / 2) / this.sampleRate;
    }

    windowAt(t) {
        const w = Math.round((t * this.sampleRate - FFT_SIZE / 2) / this.hop);
        return Math.max(0, Math.min(this.windowCount - 1, w));
    }

    _channels(channel) {
        return channel == null ? [...Array(this.channels).keys()] : [channel];
    }

    /** Band level at time t (loudest of the channels unless one is given). */
    levelAt(band, t, { channel } = {}) {
        const w = this.windowAt(t);
        return Math.max(...this._channels(channel).map((c) => this.levels[c][band][w]));
    }

    /** Median band level over [t0, t1] - robust to a window or two of transition. */
    level(band, t0, t1, { channel } = {}) {
        const values = [];
        for (let w = this.windowAt(t0); w <= this.windowAt(t1); w++) {
            values.push(Math.max(...this._channels(channel).map((c) => this.levels[c][band][w])));
        }
        values.sort((a, b) => a - b);
        return values[Math.floor(values.length / 2)] ?? 0;
    }

    /** [{t, level}] for the whole recording (or [t0, t1]). */
    envelope(band, { channel, t0 = 0, t1 = this.durationSec } = {}) {
        const out = [];
        for (let w = this.windowAt(t0); w <= this.windowAt(t1); w++) {
            out.push({ t: this.timeOf(w), level: Math.max(...this._channels(channel).map((c) => this.levels[c][band][w])) });
        }
        return out;
    }

    /**
     * The segment slots sounding at time t in a band, loudest first: every
     * slot at least `relative` of the loudest one. Empty when silent.
     */
    slotsAt(band, t, { channel, relative = 0.35, floor = SILENCE } = {}) {
        const w = this.windowAt(t);
        const amps = new Array(SLOTS).fill(0);
        for (const c of this._channels(channel)) {
            for (let s = 0; s < SLOTS; s++) amps[s] = Math.max(amps[s], this.slots[c][band][w * SLOTS + s]);
        }
        const max = Math.max(...amps);
        if (max < floor) return [];
        return amps
            .map((amp, slot) => ({ slot, amp }))
            .filter(({ amp }) => amp >= max * relative)
            .sort((a, b) => b.amp - a.amp);
    }

    /** The loudest slot at time t, or null when the band is silent. */
    slotAt(band, t, options) {
        return this.slotsAt(band, t, options)[0]?.slot ?? null;
    }

    /**
     * Number of distinct playback positions in a band at time t: slots that
     * are peaks in their own right (not the neighbour of a louder slot a
     * window straddling a segment change also picks up).
     */
    voicesAt(band, t, options) {
        const slots = this.slotsAt(band, t, options).map((s) => s.slot);
        const kept = [];
        for (const slot of slots) {
            if (!kept.some((k) => Math.abs(k - slot) <= 1 || Math.abs(k - slot) >= SLOTS - 1)) kept.push(slot);
        }
        return kept.length;
    }

    /** [{t, slot}] across [t0, t1] (slot null when silent). */
    positions(band, t0, t1, options) {
        const out = [];
        for (let w = this.windowAt(t0); w <= this.windowAt(t1); w++) {
            const t = this.timeOf(w);
            out.push({ t, slot: this.slotAt(band, t, options) });
        }
        return out;
    }

    /** The measured frequency (Hz) of the loudest tone in a band at time t. */
    frequencyAt(band, t, { channel = 0 } = {}) {
        return this.peakBins[channel][band][this.windowAt(t)] * this.binHz;
    }

    /**
     * First time >= `after` the band's level is above `threshold` (default:
     * not silent) for `holdSec` - or null.
     */
    onset(band, { after = 0, threshold = SILENCE * 2, holdSec = 0.03, channel } = {}) {
        const t = this._firstRun(band, after, (l) => l > threshold, holdSec, channel);
        // A window starts hearing a tone before its centre reaches it:
        // measured, the first window over the threshold is centred ~0.2 of
        // a window before the true start (test/unit/audio-analyzer.test.js).
        return t === null ? null : t + (0.2 * FFT_SIZE) / this.sampleRate;
    }

    /** First time >= `after` the band falls below `threshold` and stays there for `holdSec` - or null. */
    offset(band, { after = 0, threshold = SILENCE, holdSec = 0.05, channel } = {}) {
        const t = this._firstRun(band, after, (l) => l < threshold, holdSec, channel);
        // The first silent window is the first one entirely past the end:
        // centred half a window after it.
        return t === null ? null : t - (0.5 * FFT_SIZE) / this.sampleRate;
    }

    _firstRun(band, after, test, holdSec, channel) {
        const need = Math.max(1, Math.round(holdSec / this.hopSec));
        let run = 0;
        for (let w = this.windowAt(after); w < this.windowCount; w++) {
            const level = Math.max(...this._channels(channel).map((c) => this.levels[c][band][w]));
            run = test(level) ? run + 1 : 0;
            if (run >= need) return this.timeOf(w - need + 1);
        }
        return null;
    }

    /**
     * Times a band's level crosses `fraction` of `reference` (rising or
     * falling, first one after `after`). Used to time fades: a linear fade
     * crosses 90% and 10% of its level 80% of the fade apart.
     */
    crossing(band, { after = 0, fraction, reference, direction = 'falling', channel } = {}) {
        const target = fraction * reference;
        for (let w = this.windowAt(after) + 1; w < this.windowCount; w++) {
            const prev = Math.max(...this._channels(channel).map((c) => this.levels[c][band][w - 1]));
            const cur = Math.max(...this._channels(channel).map((c) => this.levels[c][band][w]));
            const crossed = direction === 'falling' ? prev >= target && cur < target : prev <= target && cur > target;
            if (crossed) {
                // Interpolate between the two windows.
                const frac = (target - prev) / (cur - prev || 1);
                return this.timeOf(w - 1) + frac * this.hopSec;
            }
        }
        return null;
    }
}

function analyze(recording, options) {
    return new Analysis(recording, options);
}

module.exports = { analyze, Analysis, SILENCE, BAND_COUNT };
