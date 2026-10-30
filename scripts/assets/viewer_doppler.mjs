// Real-time preview: rate modulation, not an absolute propagation-delay solver.
export const SOUND_SPEED = 343.3;
export const DOPPLER_SMOOTH_SECONDS = 0.05;
const point = p => p != null && p.length === 3 && Array.from(p).every(Number.isFinite);

export function samplePosition(positions, time, fps) {
  if (!positions?.length || !Number.isFinite(time) || !Number.isFinite(fps) || fps <= 0) return null;
  const frame = Math.max(0, Math.min(time * fps, positions.length - 1));
  const left = Math.floor(frame), right = Math.min(left + 1, positions.length - 1);
  if (!point(positions[left]) || !point(positions[right])) return null;
  return positions[left].map((value, axis) => value + (positions[right][axis] - value) * (frame - left));
}

export function dopplerRatio(source, listener, sourceVelocity, listenerVelocity, scale = 1) {
  if (![source, listener, sourceVelocity, listenerVelocity].every(point)
      || !Number.isFinite(scale) || scale <= 0) return 1;
  const delta = source.map((v, i) => v - listener[i]);
  const distance = Math.hypot(...delta);
  if (!Number.isFinite(distance) || distance * scale < 1e-6 || distance === 0) return 1;
  const radial = velocity => velocity.reduce((sum, v, i) => sum + v * delta[i] / distance, 0) * scale;
  const numerator = SOUND_SPEED + radial(listenerVelocity);
  const denominator = SOUND_SPEED + radial(sourceVelocity);
  const ratio = numerator / denominator;
  if (numerator <= 0 || denominator <= 1e-6 || !Number.isFinite(ratio)) return 1;
  return Math.max(0.25, Math.min(4, ratio));
}

export class DopplerMotion {
  reset() { this.previous = null; }

  sample(time, listener, sources, scale) {
    const previous = this.previous;
    const current = new Map([...sources].filter(([, p]) => point(p)).map(([id, p]) => [id, [...p]]));
    this.previous = point(listener) && Number.isFinite(time)
      ? { time, listener: [...listener], sources: current, scale } : null;
    const ratios = new Map([...sources.keys()].map(id => [id, 1]));
    const dt = time - (previous?.time ?? time);
    // A stalled tab, teleport, or new playback segment must not become velocity.
    if (!this.previous || !previous || previous.scale !== scale || dt <= 1e-6 || dt > 2) return ratios;
    const velocity = (now, before) => now.map((v, axis) => (v - before[axis]) / dt);
    const listenerVelocity = velocity(listener, previous.listener);
    for (const [id, position] of current) {
      const before = previous.sources.get(id);
      if (before) ratios.set(id, dopplerRatio(position, listener, velocity(position, before), listenerVelocity, scale));
    }
    return ratios;
  }
}

export function setDopplerRate(param, rate, now, smooth = true) {
  if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(now);
  else {
    const value = param.value;
    param.cancelScheduledValues(now);
    param.setValueAtTime(value, now);
  }
  if (smooth) param.setTargetAtTime(rate, now, DOPPLER_SMOOTH_SECONDS);
  else param.setValueAtTime(rate, now);
}

export class ScenePlaybackClock {
  anchor(now, sceneTime, speed) {
    this.start = now;
    this.sceneTime = sceneTime;
    this.speed = speed;
  }
  time(now) { return this.sceneTime + Math.max(0, now - this.start) * this.speed; }
}
