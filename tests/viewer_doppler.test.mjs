import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DopplerMotion, dopplerRatio, samplePosition, ScenePlaybackClock, setDopplerRate } from '../scripts/assets/viewer_doppler.mjs';

const zero = [0, 0, 0], source = [100, 0, 0];
test('stationary, approaching, receding, common motion and scale', () => {
  assert.equal(dopplerRatio(source, zero, zero, zero), 1);
  assert.ok(dopplerRatio(source, zero, [-30, 0, 0], zero) > 1);
  assert.ok(dopplerRatio(source, zero, [30, 0, 0], zero) < 1);
  assert.ok(dopplerRatio(source, zero, zero, [30, 0, 0]) > 1);
  assert.ok(dopplerRatio(source, zero, zero, [-30, 0, 0]) < 1);
  assert.equal(dopplerRatio(source, zero, [30, 2, 3], [30, 2, 3]), 1);
  assert.equal(dopplerRatio(source, zero, [0, 20, 0], [0, -20, 0]), 1);
  assert.equal(dopplerRatio(source, zero, [-2, 0, 0], [1, 0, 0], 10),
    dopplerRatio(source, zero, [-20, 0, 0], [10, 0, 0]));
});

test('limits and invalid geometry do not reach AudioParam', () => {
  assert.equal(dopplerRatio(source, zero, [-340, 0, 0], zero), 4);
  assert.equal(dopplerRatio(source, zero, [2000, 0, 0], zero), .25);
  for (const args of [
    [zero, zero, zero, zero], [null, zero, zero, zero],
    [[NaN, 0, 0], zero, zero, zero], [source, zero, [-400, 0, 0], zero],
    [source, zero, zero, zero, Infinity],
  ]) assert.equal(dopplerRatio(...args), 1);
});

test('geometry sampling follows FPS rather than audio length or nearest frame', () => {
  assert.deepEqual(samplePosition([[0, 0, 0], [10, 2, 4]], .02, 25), [5, 1, 2]);
  assert.deepEqual(samplePosition([[0, 0, 0], [10, 2, 4]], 20, 25), [10, 2, 4]);
  assert.equal(samplePosition([[0, 0, 0], [NaN, 2, 4]], .02, 25), null);
  assert.deepEqual(samplePosition([[3, 2, 1]], 20, 25), [3, 2, 1]);
  assert.deepEqual(samplePosition([[0, 0, 0], [10, 2, 4]], -1, 25), [0, 0, 0]);
  assert.equal(samplePosition([], 0, 25), null);
  assert.equal(samplePosition([[0, 0, 0]], 0, 0), null);
  assert.equal(samplePosition([[0, 0, 0]], NaN, 25), null);
});

test('velocity uses elapsed playback time; resets, scale changes and stalls clear history', () => {
  const motion = new DopplerMotion();
  const sample = (t, x, scale = 1) => motion.sample(t, zero, new Map([['car', [x, 0, 0]]]), scale).get('car');
  assert.equal(sample(0, 100), 1);
  const normal = sample(.1, 98);
  assert.ok(normal > 1);
  assert.ok(sample(.2, 94) > normal); // Twice as fast in the same wall time.
  motion.reset();
  assert.equal(sample(.3, 20), 1); // seek/camera switch/resume
  assert.equal(sample(.4, 10, 10), 1); // units changed
  assert.equal(sample(3, 100, 10), 1); // tab stalled
  const missing = motion.sample(3.1, zero, new Map([['car', null]]), 10);
  assert.equal(missing.get('car'), 1);
  assert.equal(sample(3.2, 1, 10), 1); // reacquired track has no valid previous sample
});

test('clock anchors preserve time through speed changes and scheduled audio starts', () => {
  const clock = new ScenePlaybackClock();
  clock.anchor(10.02, 3, 1);
  assert.equal(clock.time(10), 3);
  assert.ok(Math.abs(clock.time(11.02) - 4) < 1e-9);
  const atChange = clock.time(11.02);
  clock.anchor(11.02, atChange, 2);
  assert.ok(Math.abs(clock.time(12.02) - 6) < 1e-9);
  clock.anchor(20, 1.5, .5); // resume after seeking, no pause time accumulated
  assert.equal(clock.time(21), 2);
});

test('rate smoothing is cancelled when motion history is reset', () => {
  const calls = [];
  const param = { value: 1, cancelAndHoldAtTime: t => calls.push(['hold', t]),
    setTargetAtTime: (...args) => calls.push(['target', ...args]),
    setValueAtTime: (...args) => calls.push(['value', ...args]) };
  setDopplerRate(param, 1.2, 10);
  assert.deepEqual(calls, [['hold', 10], ['target', 1.2, 10, .05]]);
  calls.length = 0;
  setDopplerRate(param, 2, 11, false);
  assert.deepEqual(calls, [['hold', 11], ['value', 2, 11]]);
});


test('listener motion shifts static sources consistently across frame rates', () => {
  const evaluate = dt => {
    const motion = new DopplerMotion();
    const positions = new Map([['static', source]]);
    motion.sample(0, zero, positions, 1);
    return motion.sample(dt, [30 * dt, 0, 0], positions, 1).get('static');
  };
  const at60fps = evaluate(1 / 60);
  const at10fps = evaluate(1 / 10);
  assert.ok(at60fps > 1);
  assert.ok(Math.abs(at60fps - at10fps) < 1e-12);
});

test('invalid listener or non-advancing audio clock cannot create a pitch spike', () => {
  const motion = new DopplerMotion();
  const positions = new Map([['car', source]]);
  const ratio = (time, listener) => motion.sample(time, listener, positions, 1).get('car');
  assert.equal(ratio(0, zero), 1);
  assert.equal(ratio(.1, [NaN, 0, 0]), 1);
  assert.equal(ratio(.2, [10, 0, 0]), 1); // reacquisition has no valid history
  assert.equal(ratio(.2, [100, 0, 0]), 1); // suspended audio clock
  assert.equal(ratio(.1, [200, 0, 0]), 1); // clock moved backwards
  motion.reset();
  assert.equal(ratio(.3, [0, 0, 0]), 1); // teleport after explicit reset
});

test('AudioParam fallback cancels queued modulation before restoring the base rate', () => {
  const calls = [];
  const param = { value: 1.1,
    cancelScheduledValues: time => calls.push(['cancel', time]),
    setValueAtTime: (...args) => calls.push(['value', ...args]),
    setTargetAtTime: (...args) => calls.push(['target', ...args]) };
  setDopplerRate(param, 1.2, 10);
  assert.deepEqual(calls, [['cancel', 10], ['value', 1.1, 10], ['target', 1.2, 10, .05]]);
  calls.length = 0;
  setDopplerRate(param, .5, 11, false);
  assert.deepEqual(calls, [['cancel', 11], ['value', 1.1, 11], ['value', .5, 11]]);
});
