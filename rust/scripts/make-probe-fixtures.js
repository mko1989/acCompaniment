#!/usr/bin/env node
/**
 * Builds rust/app-fixtures/probe/: small audio files that exercise music-metadata's rules for
 * duration, bitrate, sample rate, channels and tags, for the `probe` ops of
 * rust/scripts/diff-data.js (the Rust probe must report exactly what music-metadata reports).
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ffmpegBinary } = require('../../test/audio/lib/signals');

const OUT = path.join(__dirname, '..', 'app-fixtures', 'probe');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const ffmpeg = ffmpegBinary();
const sine = (sec, f = 440) => ['-f', 'lavfi', '-i', `sine=frequency=${f}:duration=${sec}`];
const tags = ['-metadata', 'title=Zażółć title', '-metadata', 'artist=Artist A', '-metadata', 'album=Album 🎵'];

const files = [
    ['cbr.mp3', [...sine(1.5), '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '96k', ...tags]],
    ['cbr-noxing.mp3', [...sine(1.5), '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '64k', '-write_xing', '0']],
    ['vbr.mp3', [...sine(2), '-ac', '2', '-c:a', 'libmp3lame', '-q:a', '4', ...tags, '-id3v2_version', '3']],
    ['vbr-noxing.mp3', [...sine(2, 1000), '-ac', '1', '-c:a', 'libmp3lame', '-q:a', '2', '-write_xing', '0']],
    ['mpeg2.mp3', [...sine(1), '-ac', '1', '-ar', '22050', '-c:a', 'libmp3lame', '-b:a', '32k']],
    ['id3v1.mp3', [...sine(1), '-c:a', 'libmp3lame', '-b:a', '64k', '-write_id3v1', '1', '-id3v2_version', '0', ...tags]],
    ['multi-artist-v23.mp3', [...sine(1), '-c:a', 'libmp3lame', '-b:a', '64k', '-id3v2_version', '3', '-metadata', 'artist=One/Two/Three', '-metadata', 'title=T']],
    ['mono.aac', [...sine(1.2), '-ac', '1', '-ar', '22050', '-c:a', 'aac', '-f', 'adts']],
    ['u8.wav', [...sine(0.7), '-ac', '1', '-ar', '8000', '-c:a', 'pcm_u8']],
    ['float.wav', [...sine(0.5), '-ac', '2', '-ar', '32000', '-c:a', 'pcm_f32le', ...tags]],
    ['tagged.flac', [...sine(1), '-ac', '2', '-ar', '44100', '-sample_fmt', 's32', '-c:a', 'flac', ...tags]],
    ['tagged.ogg', [...sine(1.3), '-ac', '1', '-ar', '48000', '-c:a', 'libvorbis', ...tags, '-metadata', 'artists=X']],
    ['tagged.m4a', [...sine(1.1), '-ac', '2', '-ar', '48000', '-c:a', 'aac', '-b:a', '96k', ...tags]],
];
for (const [name, args] of files) {
    execFileSync(ffmpeg, ['-v', 'error', ...args, path.join(OUT, name)]);
}

// Odd-length data chunk with a LIST/INFO after it, written by hand.
const frames = 4411;
const data = Buffer.alloc(frames);
for (let i = 0; i < frames; i++) data[i] = 128 + Math.round(60 * Math.sin(i / 7));
const info = Buffer.concat([Buffer.from('INFO'), Buffer.from('INAM'), Buffer.from([5, 0, 0, 0]), Buffer.from('Hand\0\0'), Buffer.from('IART'), Buffer.from([3, 0, 0, 0]), Buffer.from('Me\0\0')]);
const fmt = Buffer.alloc(16);
fmt.writeUInt16LE(1, 0); fmt.writeUInt16LE(1, 2); fmt.writeUInt32LE(11025, 4); fmt.writeUInt32LE(11025, 8); fmt.writeUInt16LE(1, 12); fmt.writeUInt16LE(8, 14);
const chunk = (id, body) => Buffer.concat([Buffer.from(id), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(body.length, 0); return b; })(), body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
const wave = Buffer.concat([Buffer.from('WAVE'), chunk('fmt ', fmt), chunk('data', data), chunk('LIST', info)]);
const riffSize = Buffer.alloc(4);
riffSize.writeUInt32LE(wave.length, 0);
fs.writeFileSync(path.join(OUT, 'odd-info.wav'), Buffer.concat([Buffer.from('RIFF'), riffSize, wave]));
fs.writeFileSync(path.join(OUT, 'not-audio.mp3'), 'this is not audio at all, just some text that is long enough to scan '.repeat(10));
fs.writeFileSync(path.join(OUT, 'empty.wav'), '');
console.log(`probe fixtures written to ${path.relative(process.cwd(), OUT)}`);
