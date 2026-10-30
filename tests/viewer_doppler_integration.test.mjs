import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { test } from 'node:test';
import { DopplerMotion, ScenePlaybackClock, setDopplerRate, SOUND_SPEED } from '../scripts/assets/viewer_doppler.mjs';

// Exercise the viewer's actual playback handlers without requiring WebGL or an audio device.
const html = readFileSync(new URL('../demo.html', import.meta.url), 'utf8');
const names = [
  'resetDopplerMotion', 'updateAudioDoppler', 'rebasePlaybackClock', 'scenePlaybackTime',
  'capturePlaybackTime', 'setPlaybackSpeed', 'setAudioEnabled', 'beginScrub', 'endScrub',
  'seekFromSlider', 'hasPlayableAudio', 'createSpatialAudioSources', 'createAudioSrc',
  'resumeAudio', 'pauseAudio', 'togglePlay', 'restartPlayback', 'renderLoop',
];
const functions = names.map(name => {
  const match = html.match(new RegExp(`^    function ${name}\\([\\s\\S]*?^    }`, 'm'));
  assert.ok(match, `Viewer function ${name} must be available to the integration harness`);
  return match[0];
}).join('\n');
const apiMethods = ['setTime', 'renderAt'].map(name => {
  const match = html.match(new RegExp(`^      (?:async )?${name}\\([\\s\\S]*?^      },`, 'm'));
  assert.ok(match, `Viewer API ${name} must be available to the integration harness`);
  return match[0];
}).join('\n');
const scrubBindings = html.match(/^    (?:timeSlider|window)\.addEventListener\('(?:pointerdown|input|pointerup|pointercancel|blur)',\s*[\w$]+\);$/gm)?.join('\n');
assert.ok(scrubBindings, 'Viewer timeline events must be available to the integration harness');

function parameter() {
  return {
    value: 1, targets: [],
    cancelAndHoldAtTime() {},
    setValueAtTime(value) { this.value = value; },
    setTargetAtTime(value, time, smoothing) {
      this.value = value;
      this.targets.push([value, time, smoothing]);
    },
  };
}

function harness() {
  const nodes = [];
  const handlers = new Map();
  const register = target => (event, callback) => handlers.set(`${target}:${event}`, callback);
  const track = (sourceId, spatial) => ({ sourceId, source: { source_id: sourceId },
    sourceNode: null, normalizationGainNode: {}, buffer: { duration: 10 }, pannerNode: spatial ? {} : null });
  const tracks = new Map([['car', track('car', true)], ['static', track('static', true)], ['bed', track('bed', false)]]);
  const s = createContext({
    dopplerMotion: new DopplerMotion(), playbackClock: new ScenePlaybackClock(), playbackClockKind: null,
    setDopplerRate, audioTracks: tracks, audioBuffer: null, audioEnabled: true,
    isPlaying: true, isScrubbing: false, isUiLocked: false, sceneLoaded: true,
    audioWorldScale: 1, playSpeed: 1, currentTime: 4, duration: 10,
    audioStartCtxTime: 0, audioStartSceneTime: 0, audioSrcNode: null,
    toggleAudioBtn: {}, leftVolumeEl: { style: {} }, rightVolumeEl: { style: {} },
    timeSlider: { value: 400, addEventListener: register('slider') },
    window: { addEventListener: register('window') }, speedSelect: { value: '1' }, fallbackGainNode: {},
    sourceX: 100, listenerX: 0, wallNow: 10000, frameApplications: [], renderCalls: 0,
    clock: { getDelta: () => .4 }, followVggtCamera: true, customCameraActive: false,
    velocity: { subVectors() { return this; }, divideScalar() {}, set() {} },
    prevPos: { copy() {} }, rAFId: null, infoFpsEl: {},
    initAudioCtx() {}, startRenderLoop() {}, updatePlayBtns() {}, updateTimeLabel() {},
    updateAudioSourceVisuals() {}, updateAudioSpatialization() {},
    updateTrajectoryLabels() {}, updateAudioSourceLabels() {}, clearPresentHold() {},
    audioCtx: { state: 'running', currentTime: 10, resume() { this.state = 'running'; },
      createBufferSource() {
        const node = { playbackRate: parameter(), connect() {}, disconnect() { this.disconnected = true; },
          start(...args) { this.started = args; }, stop() { this.stopped = true; } };
        nodes.push(node);
        return node;
      } },
  });
  runInContext(`
    const performance = { now: () => wallNow };
    const camera = { position: { toArray: () => [listenerX, 0, 0] } };
    function sourcePositionAtTime(source) {
      return { toArray: () => [source.source_id === 'static' ? 100 : sourceX, 0, 0] };
    }
    function applyFrame() { frameApplications.push(currentTime); }
    function renderCurrentView() { renderCalls++; }
    function requestAnimationFrame(callback) { if (callback !== renderLoop) callback(); return 1; }
    ${functions}
    ${scrubBindings}
    const api = { ${apiMethods} getState() { return { time: currentTime, playing: isPlaying }; } };
    globalThis.api = api;
  `, s);
  return { s, tracks, nodes, fire(target, event) {
    const handler = handlers.get(`${target}:${event}`);
    assert.ok(handler, `${target} must handle ${event}`);
    handler();
  } };
}

const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9,
  message || `${actual} should equal ${expected}`);
const started = node => Array.from(node.started);

test('scheduled stems start together; only spatial motion shifts pitch and never the scene clock', () => {
  const { s, tracks } = harness();
  s.resumeAudio();
  for (const track of tracks.values()) {
    assert.deepEqual(started(track.sourceNode), [10.02, 4]);
    assert.equal(track.sourceNode.loop, false);
  }
  close(s.scenePlaybackTime(), 4); // The 20 ms scheduling lead is not scene motion.
  s.audioCtx.currentTime = 10.03; s.updateAudioDoppler();
  s.sourceX = 97; s.audioCtx.currentTime = 10.13; s.updateAudioDoppler();
  close(tracks.get('car').sourceNode.playbackRate.value, SOUND_SPEED / (SOUND_SPEED - 30));
  assert.equal(tracks.get('static').sourceNode.playbackRate.value, 1);
  assert.equal(tracks.get('bed').sourceNode.playbackRate.value, 1);
  close(s.scenePlaybackTime(), 4.11);
});

test('metric scaling is applied once and listener motion shifts static positional sound', () => {
  const { s, tracks } = harness();
  s.audioWorldScale = 10;
  s.resumeAudio();
  s.audioCtx.currentTime = 10.03; s.updateAudioDoppler();
  s.listenerX = .3; s.sourceX = 99.8;
  s.audioCtx.currentTime = 10.13; s.updateAudioDoppler();
  close(tracks.get('car').sourceNode.playbackRate.value, (SOUND_SPEED + 30) / (SOUND_SPEED - 20));
  close(tracks.get('static').sourceNode.playbackRate.value, (SOUND_SPEED + 30) / SOUND_SPEED);
  assert.equal(tracks.get('bed').sourceNode.playbackRate.value, 1);
});

test('a slow render frame advances by audio time instead of the capped controls delta', () => {
  const { s } = harness();
  s.resumeAudio();
  s.audioCtx.currentTime = 10.42;
  s.renderLoop();
  close(s.currentTime, 4.4);
  close(s.frameApplications.at(-1), 4.4);
  s.audioCtx.currentTime = 10.82;
  s.renderLoop();
  close(s.currentTime, 4.8);
});

test('pause captures elapsed audio time; seek teardown never overwrites the requested time', () => {
  const { s, tracks, nodes } = harness();
  s.resumeAudio(); const old = [...nodes];
  s.audioCtx.currentTime = 10.52;
  s.togglePlay();
  close(s.currentTime, 4.5);
  assert.equal(s.isPlaying, false);
  assert.ok(old.every(node => node.stopped));
  assert.ok([...tracks.values()].every(track => track.sourceNode === null));
  s.currentTime = 2;
  s.audioCtx.currentTime = 50;
  s.pauseAudio();
  assert.equal(s.currentTime, 2);
  s.togglePlay();
  assert.deepEqual(started(tracks.get('car').sourceNode), [50.02, 2]);
  assert.equal(tracks.get('car').sourceNode.playbackRate.value, 1);
  s.audioCtx.currentTime = 50.52;
  close(s.scenePlaybackTime(), 2.5);
});

test('speed changes preserve position and use the new base rate for ambience as well as spatial stems', () => {
  const { s, tracks } = harness();
  s.resumeAudio();
  s.audioCtx.currentTime = 10.52;
  s.setPlaybackSpeed(2);
  close(s.currentTime, 4.5);
  assert.equal(s.playSpeed, 2);
  for (const track of tracks.values()) assert.equal(track.sourceNode.playbackRate.value, 2);
  s.audioCtx.currentTime = 11.02;
  close(s.scenePlaybackTime(), 5.5);
  s.togglePlay();
  s.setPlaybackSpeed(.5);
  close(s.currentTime, 5.5);
  s.audioCtx.currentTime = 20;
  s.togglePlay();
  assert.deepEqual(started(tracks.get('bed').sourceNode), [20.02, 5.5]);
});

test('a speed change during the scheduling lead does not start scene time before the stems', () => {
  const { s, tracks } = harness();
  s.resumeAudio();
  s.audioCtx.currentTime = 10.01;
  s.setPlaybackSpeed(2);
  s.updateAudioDoppler();
  close(s.currentTime, 4);
  close(s.scenePlaybackTime(), 4);
  assert.equal(tracks.get('car').sourceNode.playbackRate.targets.length, 0);
  s.audioCtx.currentTime = 10.12;
  close(s.scenePlaybackTime(), 4.2);
});

test('muting switches to wall time and unmuting resumes all stems at the advanced scene position', () => {
  const { s, tracks } = harness();
  s.resumeAudio();
  s.audioCtx.currentTime = 10.52;
  s.setAudioEnabled(false);
  close(s.currentTime, 4.5);
  assert.ok([...tracks.values()].every(track => track.sourceNode === null));
  s.wallNow += 250;
  close(s.scenePlaybackTime(), 4.75);
  s.audioCtx.currentTime = 30;
  s.setAudioEnabled(true);
  close(s.currentTime, 4.75);
  assert.deepEqual(started(tracks.get('car').sourceNode), [30.02, 4.75]);
  s.audioCtx.currentTime = 30.52;
  close(s.scenePlaybackTime(), 5.25);
});

test('silent scenes still run, pause, change speed and resume on a continuous wall clock', () => {
  const { s, tracks } = harness();
  tracks.clear();
  s.resumeAudio();
  s.wallNow += 600;
  s.capturePlaybackTime();
  close(s.currentTime, 4.6);
  s.setPlaybackSpeed(2);
  s.wallNow += 250;
  s.togglePlay();
  close(s.currentTime, 5.1);
  s.wallNow += 10000;
  s.togglePlay();
  s.wallNow += 250;
  close(s.scenePlaybackTime(), 5.6);
});

test('keyboard slider input seeks and restarts audio even without pointer scrubbing', () => {
  const { s, tracks, nodes } = harness();
  s.resumeAudio(); const old = [...nodes];
  s.audioCtx.currentTime = 10.52;
  s.timeSlider.value = 200;
  s.seekFromSlider();
  assert.equal(s.currentTime, 2);
  assert.equal(s.isScrubbing, false);
  assert.ok(old.every(node => node.stopped));
  assert.deepEqual(started(tracks.get('car').sourceNode), [10.54, 2]);
  s.audioCtx.currentTime = 10.79;
  close(s.scenePlaybackTime(), 2.25);
});

test('scrubbing holds time through mute, speed and unmute; release resumes only once', () => {
  const { s, tracks, nodes } = harness();
  s.resumeAudio();
  s.audioCtx.currentTime = 10.52;
  s.beginScrub();
  assert.equal(s.isScrubbing, true);
  s.timeSlider.value = 300; s.seekFromSlider();
  const count = nodes.length;
  s.setAudioEnabled(false);
  s.wallNow += 3000;
  s.setPlaybackSpeed(2);
  s.setAudioEnabled(true);
  assert.equal(s.currentTime, 3);
  assert.equal(nodes.length, count);
  assert.ok([...tracks.values()].every(track => track.sourceNode === null));
  s.audioCtx.currentTime = 20;
  s.endScrub();
  assert.equal(s.isScrubbing, false);
  assert.deepEqual(started(tracks.get('car').sourceNode), [20.02, 3]);
  const afterRelease = nodes.length;
  s.endScrub();
  assert.equal(nodes.length, afterRelease); // window + element release may both fire.
});

test('timeline wiring resumes after pointer release outside the slider, cancellation, or focus loss', () => {
  for (const release of ['pointerup', 'pointercancel', 'blur']) {
    const { s, tracks, fire } = harness();
    s.resumeAudio();
    fire('slider', 'pointerdown');
    s.timeSlider.value = 250;
    fire('slider', 'input');
    assert.equal(s.currentTime, 2.5);
    assert.equal(tracks.get('car').sourceNode, null);
    fire('window', release);
    assert.equal(s.isScrubbing, false);
    assert.deepEqual(started(tracks.get('car').sourceNode), [10.02, 2.5]);
  }
});

test('stem EOF never loops; Play after scene EOF restarts every stem and the scene clock', () => {
  const { s, tracks, nodes } = harness();
  s.resumeAudio();
  const car = tracks.get('car').sourceNode;
  car.onended();
  assert.equal(tracks.get('car').sourceNode, null);
  assert.equal(s.isPlaying, true);
  s.audioCtx.currentTime = 16.5;
  s.renderLoop();
  assert.equal(s.currentTime, 10);
  assert.equal(s.isPlaying, false);
  assert.ok([...tracks.values()].every(track => track.sourceNode === null));
  const count = nodes.length;
  s.togglePlay();
  assert.equal(nodes.length, count + tracks.size);
  assert.equal(s.currentTime, 0);
  assert.equal(s.isPlaying, true);
  for (const track of tracks.values()) {
    assert.deepEqual(started(track.sourceNode), [16.52, 0]);
    assert.equal(track.sourceNode.playbackRate.value, 1);
  }
  s.audioCtx.currentTime = 17.02;
  close(s.scenePlaybackTime(), .5);
});

test('legacy final mix anchors its immediate start correctly and receives no source Doppler', () => {
  const { s, tracks } = harness();
  tracks.clear(); s.audioBuffer = { duration: 10 };
  s.resumeAudio();
  assert.deepEqual(started(s.audioSrcNode), [0, 4]);
  s.audioCtx.currentTime = 10.52;
  close(s.scenePlaybackTime(), 4.52);
  s.updateAudioDoppler();
  assert.equal(s.audioSrcNode.playbackRate.value, 1);
  s.setPlaybackSpeed(2);
  assert.equal(s.audioSrcNode.playbackRate.value, 2);
  s.audioSrcNode.onended();
  assert.equal(s.audioSrcNode, null);
  assert.equal(s.isPlaying, true);
});

test('setTime and renderAt remain deterministic paused rendering APIs during playback or a scrub', async () => {
  const { s, tracks } = harness();
  s.resumeAudio();
  s.audioCtx.currentTime = 11;
  assert.equal(s.api.setTime(1.25), 1.25);
  assert.equal(s.isPlaying, false);
  assert.ok([...tracks.values()].every(track => track.sourceNode === null));
  s.togglePlay(); s.beginScrub();
  await s.api.renderAt(2.5);
  assert.equal(s.currentTime, 2.5);
  assert.equal(s.isPlaying, false);
  assert.equal(s.isScrubbing, false);
  assert.equal(s.renderCalls, 2);
  s.endScrub();
  assert.ok([...tracks.values()].every(track => track.sourceNode === null));
  assert.equal(s.api.setTime(-1), 0);
  assert.equal(s.api.setTime(100), 10);
  assert.throws(() => s.api.setTime(NaN), /finite/);
});
