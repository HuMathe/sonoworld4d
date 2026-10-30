import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { test } from 'node:test';
import { DopplerMotion, setDopplerRate, SOUND_SPEED } from '../scripts/assets/viewer_doppler.mjs';

// Exercise the actual viewer audio graph setup and motion updates without WebGL.
const html = readFileSync(new URL('../demo.html', import.meta.url), 'utf8');
const functions = ['sourceRole', 'audioBufferPeak', 'setAudioPosition',
  'installAudioTrack', 'updateAudioDoppler'].map(name => {
  const match = html.match(new RegExp(`^    function ${name}\\([\\s\\S]*?^    }`, 'm'));
  assert.ok(match, `Viewer function ${name} must be available`);
  return match[0];
}).join('\n');

function parameter(value = 1) {
  return { value, cancelAndHoldAtTime() {},
    setValueAtTime(next) { this.value = next; },
    setTargetAtTime(next) { this.value = next; } };
}

function audioBuffer(samples = [0, 12, -8, .25]) {
  const channel = new Float32Array(samples);
  return { numberOfChannels: 1, duration: 7, getChannelData: () => channel };
}

function harness(metadata = null, overrides = {}) {
  const s = createContext({
    audioSourcesMeta: metadata, audioTracks: new Map(), masterGainNode: {},
    audioSourceOverrides: overrides,
    audioWorldScale: 1, initAudioCtx() {}, playSpeed: 1,
    dopplerMotion: new DopplerMotion(), setDopplerRate,
    isPlaying: true, isScrubbing: false, audioEnabled: true, audioStartCtxTime: 0,
    listenerPosition: [0, 0, 0], positions: new Map(),
    audioCtx: {
      state: 'running', currentTime: 10,
      createGain() { return { gain: parameter(), connect() {} }; },
      createPanner() {
        return { positionX: parameter(0), positionY: parameter(0), positionZ: parameter(0), connect() {} };
      },
    },
  });
  runInContext(`
    const camera = { position: { toArray: () => listenerPosition } };
    function sourcePositionAtTime(source) {
      const position = positions.get(source.source_id) || [100, 0, 0];
      return { x: position[0], y: position[1], z: position[2], toArray: () => position };
    }
    function sourceInitialPosition(source) {
      return source.role === 'background' ? null : sourcePositionAtTime(source);
    }
    ${functions}
  `, s);
  return s;
}

function install(s, source, buffer = audioBuffer()) {
  s.installAudioTrack(source, buffer);
  const track = s.audioTracks.get(source.source_id);
  assert.ok(track);
  return track;
}

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9,
  `${actual} should equal ${expected}`);

test('baked FLOAT stems preserve amplitudes above one without another normalization or fixed gain', () => {
  const s = harness();
  const buffer = audioBuffer();
  const original = Array.from(buffer.getChannelData(0));
  const track = install(s, { source_id: 'car', role: 'dynamic', audio_processing_baked: true,
    peak_db: -24, source_gain_multiplier: .1, doppler_scale: 28.771198272705078 }, buffer);
  assert.equal(track.buffer, buffer);
  assert.deepEqual(Array.from(buffer.getChannelData(0)), original);
  assert.equal(track.sourcePeak, 12);
  assert.equal(track.normalizationGainNode.gain.value, 1);
  assert.equal(track.gainNode.gain.value, 1);
  assert.equal(track.pannerNode.refDistance, 1);
});

test('scene-level baked metadata preserves static and global stems even without source flags', () => {
  const s = harness({ bake: { all_fixed_gains_in_audio: true } });
  for (const role of ['static', 'background']) {
    const track = install(s, { source_id: role, role, peak_db: 20, doppler_scale: 15 });
    assert.equal(track.normalizationGainNode.gain.value, 1);
    assert.equal(track.gainNode.gain.value, 1);
    if (role === 'static') assert.equal(track.pannerNode.refDistance, 1);
    else assert.equal(track.pannerNode, null);
  }
});

test('calibrated baked stems retain their frozen reference distance while keeping unity source gain', () => {
  const s = harness();
  const track = install(s, { source_id: 'calibrated', role: 'dynamic',
    audio_processing_baked: true, canonical_stem_gain_applied: true,
    peak_db: -12, doppler_scale: 28.771198272705078 });
  assert.equal(track.normalizationGainNode.gain.value, 1);
  assert.equal(track.gainNode.gain.value, 1);
  assert.equal(track.pannerNode.refDistance, 28.771198272705078);
});

test('legacy stems keep their existing peak equalization and reference-distance behavior', () => {
  const s = harness({ bake: { all_fixed_gains_in_audio: false } });
  const track = install(s, { source_id: 'legacy', role: 'dynamic', peak_db: -6,
    source_gain_multiplier: .1, audio_processing_baked: false, doppler_scale: 12 }, audioBuffer([.25, -.125]));
  assert.equal(track.normalizationGainNode.gain.value, 4);
  close(track.gainNode.gain.value, 10 ** (-6 / 20));
  assert.equal(track.pannerNode.refDistance, 12);
});

test('authored source overrides apply their exact gain once and allow a zero-gain source', () => {
  const s = harness(null, {
    plane: { gain: 11.626454726085722, reference_distance: 1 },
    bed: { gain: 0, reference_distance: 1 },
  });
  const plane = install(s, { source_id: 'plane', role: 'dynamic', peak_db: -6,
    doppler_scale: 28 }, audioBuffer([.25, -.125]));
  assert.equal(plane.normalizationGainNode.gain.value, 1);
  assert.equal(plane.gainNode.gain.value, 11.626454726085722);
  assert.equal(plane.pannerNode.refDistance, 1);
  const bed = install(s, { source_id: 'bed', role: 'background', peak_db: -12 });
  assert.equal(bed.normalizationGainNode.gain.value, 1);
  assert.equal(bed.gainNode.gain.value, 0);
  assert.equal(bed.pannerNode, null);
});

test('all spatial sources respond to listener motion regardless of offline time_warp while ambience keeps its base rate', () => {
  const s = harness({ bake: { all_fixed_gains_in_audio: true } });
  s.playSpeed = 2;
  for (const source of [
    { source_id: 'car', role: 'dynamic', time_warp: true },
    { source_id: 'bird', role: 'static', time_warp: false },
    { source_id: 'legacy-static', role: 'static' },
    { source_id: 'bed', role: 'background', time_warp: false },
  ]) {
    const track = install(s, source);
    track.sourceNode = { playbackRate: parameter(2) };
  }
  s.updateAudioDoppler();
  s.listenerPosition = [3, 0, 0];
  s.positions.set('car', [97, 0, 0]);
  s.audioCtx.currentTime = 10.1;
  s.updateAudioDoppler();
  close(s.audioTracks.get('car').sourceNode.playbackRate.value,
    2 * (SOUND_SPEED + 30) / (SOUND_SPEED - 30));
  close(s.audioTracks.get('legacy-static').sourceNode.playbackRate.value,
    2 * (SOUND_SPEED + 30) / SOUND_SPEED);
  close(s.audioTracks.get('bird').sourceNode.playbackRate.value,
    2 * (SOUND_SPEED + 30) / SOUND_SPEED);
  assert.ok(s.audioTracks.get('bird').dopplerRatio > 1);
  assert.equal(s.audioTracks.get('bed').sourceNode.playbackRate.value, 2);
  assert.equal(s.audioTracks.get('bed').dopplerRatio, 1);
});

test('bundled Porsche baked metadata installs all 18 sources with unity fixed gains', () => {
  const metadata = JSON.parse(readFileSync(new URL(
    './fixtures/scenes/porsche/audio/sources/sw4d_audio_v8/sources-meta.json', import.meta.url), 'utf8'));
  assert.equal(metadata.bake.all_fixed_gains_in_audio, true);
  assert.equal(metadata.sources.length, 18);
  const s = harness(metadata);
  for (const source of metadata.sources) {
    const track = install(s, source);
    assert.equal(track.normalizationGainNode.gain.value, 1, source.source_id);
    assert.equal(track.gainNode.gain.value, 1, source.source_id);
    if (track.pannerNode) assert.equal(track.pannerNode.refDistance, 1, source.source_id);
  }
});

test('bundled user-study Plane lowers only the aircraft by 6 dB from archived gains without peak normalization', () => {
  const root = new URL('./fixtures/scenes/plane/', import.meta.url);
  const config = JSON.parse(readFileSync(new URL('viewer-config.json', root), 'utf8'));
  assert.equal(config.audio_run, 'sw4d_audio_v6_10s');
  const metadata = JSON.parse(readFileSync(new URL(
    `audio/sources/${config.audio_run}/sources-meta.json`, root), 'utf8'));
  const archived = JSON.parse(readFileSync(new URL('study-render-metadata.json', root), 'utf8'));
  const archivedSources = new Map(archived.sources.map(source => [source.source_id, source]));
  assert.deepEqual(config.provenance.audio_gain_adjustments_db, { source_000: -6 });
  const s = harness(metadata, config.audio_source_overrides);
  assert.equal(Object.keys(config.audio_source_overrides).length, 9);
  let unchangedSources = 0;
  for (const source of metadata.sources) {
    const override = config.audio_source_overrides[source.source_id];
    assert.ok(override, source.source_id);
    const archivedSource = archivedSources.get(source.source_id);
    assert.ok(archivedSource, source.source_id);
    const track = install(s, source, audioBuffer([.25, -.125]));
    assert.equal(track.normalizationGainNode.gain.value, 1, source.source_id);
    assert.equal(track.gainNode.gain.value, override.gain, source.source_id);
    if (track.pannerNode) assert.equal(track.pannerNode.refDistance, 1, source.source_id);
    if (source.source_id === 'source_000') {
      close(track.gainNode.gain.value, archivedSource.source_gain_applied * 10 ** (-6 / 20));
    } else {
      assert.equal(track.gainNode.gain.value, archivedSource.source_gain_applied, source.source_id);
      unchangedSources++;
    }
  }
  assert.equal(unchangedSources, 8);
});
