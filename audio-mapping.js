(() => {
  'use strict';
  const root = document.getElementById('audio-mapping');
  if (!root) return;
  const $ = id => root.querySelector(`#${id}`);
  const play = $('am-play'), scrub = $('am-scrub'), video = $('am-video');
  const demo = $('am-real-demo');
  const isOpen = () => !demo || demo.open;
  const soundToggle = document.getElementById('sound-toggle');
  const modeButtons = [...root.querySelectorAll('[data-am-direction]')];
  const listenButtons = [...root.querySelectorAll('[data-am-listen]')];
  const base = new URL('assets/audio-mapping/plane/', document.baseURI);
  const tracks = {}, names = { object: 'Object source', camera: 'At the camera', inverse: 'Inverse result' };
  let data, palette, worldBounds;
  let loading = false, ready = false, playing = false, starting = false;
  let mode = 'forward', selected = 'camera', cursor = 0, frame = 0, generation = 0;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function lookup(xs, ys, x) {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
    let lo = 0, hi = xs.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
    const w = (x - xs[lo]) / (xs[hi] - xs[lo]);
    return Array.isArray(ys[lo]) ? ys[lo].map((v, i) => v + w * (ys[hi][i] - v)) : ys[lo] + w * (ys[hi] - ys[lo]);
  }
  const at = (key, t) => lookup(data.motion.times, data.motion[key], t);
  const receive = u => lookup(data.motion.sourceTime, data.motion.times, u);
  const cameraTime = () => selected === 'camera' ? cursor : receive(cursor);
  function domain(key = selected) {
    const times = data.motion.times, sourceTimes = data.motion.sourceTime;
    if (key === 'camera') return [Math.max(0, receive(0)), Math.min(data.duration, receive(data.duration), times[times.length - 1])];
    return [Math.max(0, sourceTimes[0]), Math.min(data.duration, sourceTimes[sourceTimes.length - 1])];
  }
  function getPalette() {
    const css = getComputedStyle(root), get = name => css.getPropertyValue(name).trim();
    palette = { source: get('--am-a'), camera: get('--am-b'), text: get('--am-text'), muted: get('--am-muted'), grid: get('--am-grid'), surface: get('--am-surface'), line: get('--am-line') };
  }
  function surface(canvas) {
    const rect = canvas.getBoundingClientRect(), w = rect.width, h = rect.height, dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    ctx.font = '12px "Google Sans", system-ui, sans-serif'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    return { ctx, w, h };
  }
  function line(ctx, p, q, color, width = 1) {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath(); ctx.moveTo(...p); ctx.lineTo(...q); ctx.stroke();
  }
  function prepareBounds() {
    const points = [...data.motion.sourcePos, ...data.motion.cameraPos];
    const xs = points.map(p => p[0]), zs = points.map(p => p[2]);
    worldBounds = { x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) };
  }
  function drawScene(t) {
    const { ctx, w, h } = surface($('am-scene')), b = worldBounds;
    const scale = Math.min((w - 85) / Math.max(30, b.x1 - b.x0), (h - 95) / Math.max(30, b.z1 - b.z0));
    const project = p => [w / 2 + (p[0] - (b.x0 + b.x1) / 2) * scale, h / 2 + 5 - (p[2] - (b.z0 + b.z1) / 2) * scale];
    function plot(points, color, limit = Infinity) {
      ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.beginPath();
      points.forEach((p, i) => { if (i > limit) return; const q = project(p); if (!i) ctx.moveTo(...q); else ctx.lineTo(...q); });
      ctx.stroke();
    }
    plot(data.motion.sourcePos, palette.line);
    plot(data.motion.sourcePos, palette.source, Math.floor(t / data.duration * (data.motion.times.length - 1)));
    plot(data.motion.cameraPos, palette.camera);
    const source = project(at('sourcePos', t)), camera = project(at('cameraPos', t));
    ctx.setLineDash([3, 5]); line(ctx, source, camera, palette.muted); ctx.setLineDash([]);
    const next = project(at('sourcePos', Math.min(t + 0.08, data.duration))), previous = project(at('sourcePos', Math.max(t - 0.08, 0)));
    ctx.save(); ctx.translate(...source); ctx.rotate(Math.atan2(next[1] - previous[1], next[0] - previous[0])); ctx.fillStyle = palette.source;
    ctx.beginPath(); ctx.moveTo(12, 0); ctx.lineTo(-8, -7); ctx.lineTo(-4, 0); ctx.lineTo(-8, 7); ctx.closePath(); ctx.fill(); ctx.restore();
    ctx.fillStyle = palette.surface; ctx.strokeStyle = palette.camera; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(...camera, 8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = palette.text; ctx.textAlign = 'center';
    ctx.fillText('Plane', clamp(source[0], 32, w - 32), clamp(source[1] - 16, 42, h - 12));
    const near = Math.hypot(source[0] - camera[0], source[1] - camera[1]) < 50;
    ctx.fillText('Camera', clamp(camera[0], 35, w - 35), clamp(camera[1] + (near ? 29 : 23), 40, h - 12));
    ctx.fillStyle = palette.muted; ctx.textAlign = 'left'; ctx.fillText('Recorded trajectory · X–Z projection', 13, 20);
  }
  // Waveforms and native playback use the same exported PCM bytes.
  function decodeWav(buffer) {
    const view = new DataView(buffer), text = (offset, n) => String.fromCharCode(...new Uint8Array(buffer, offset, n));
    if (text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE') throw new Error('Unsupported audio file');
    let format, channels, sr, bits, dataOffset, dataSize;
    for (let offset = 12; offset + 8 <= buffer.byteLength;) {
      const id = text(offset, 4), length = view.getUint32(offset + 4, true), start = offset + 8;
      if (id === 'fmt ') {
        format = view.getUint16(start, true); channels = view.getUint16(start + 2, true); sr = view.getUint32(start + 4, true); bits = view.getUint16(start + 14, true);
        if (format === 65534) format = view.getUint16(start + 24, true);
      }
      if (id === 'data') { dataOffset = start; dataSize = Math.min(length, buffer.byteLength - start); }
      offset = start + length + (length % 2);
    }
    if (!dataOffset || channels !== 1 || !((format === 1 && bits === 16) || (format === 3 && bits === 32))) throw new Error('Expected mono PCM16 or float WAV');
    const bytes = bits / 8, count = Math.floor(dataSize / bytes), bins = 2400;
    const low = new Float32Array(bins), high = new Float32Array(bins);
    for (let i = 0; i < count; i++) {
      const sample = format === 3 ? view.getFloat32(dataOffset + i * bytes, true) : view.getInt16(dataOffset + i * bytes, true) / 32768;
      const bin = Math.min(bins - 1, Math.floor(i / count * bins)); low[bin] = Math.min(low[bin], sample); high[bin] = Math.max(high[bin], sample);
    }
    return { low, high, duration: count / sr };
  }
  function drawWave(canvas, track, position, tint, clock, reference = null) {
    const { ctx, w, h } = surface(canvas), pad = 8, top = 20, bottom = h - 32, center = (top + bottom) / 2, amplitude = (bottom - top) * 0.47;
    line(ctx, [pad, center], [w - pad, center], palette.line);
    function paint(item, color, alpha) {
      ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = 1;
      const columns = Math.max(1, Math.floor(w - 2 * pad)); ctx.beginPath();
      for (let x = 0; x < columns; x++) {
        const first = Math.floor(x / columns * item.low.length), last = Math.min(item.low.length, Math.max(first + 1, Math.floor((x + 1) / columns * item.low.length)));
        let low = 0, high = 0;
        for (let i = first; i < last; i++) { low = Math.min(low, item.low[i]); high = Math.max(high, item.high[i]); }
        ctx.moveTo(pad + x, center - high * amplitude); ctx.lineTo(pad + x, center - low * amplitude);
      }
      ctx.stroke(); ctx.globalAlpha = 1;
    }
    if (reference) paint(reference, palette.muted, 0.3);
    paint(track, tint, 0.95);
    const x = pad + clamp(position / data.duration, 0, 1) * (w - 2 * pad);
    line(ctx, [x, top - 4], [x, bottom + 3], palette.text, 1.5);
    ctx.fillStyle = palette.text; ctx.textAlign = x > w * 0.7 ? 'right' : 'left';
    ctx.fillText(`${clock} = ${position.toFixed(2)} s`, clamp(x + (x > w * 0.7 ? -5 : 5), 8, w - 8), 12);
    ctx.fillStyle = palette.muted;
    for (const v of [0, data.duration / 2, data.duration]) {
      ctx.textAlign = v === 0 ? 'left' : v === data.duration ? 'right' : 'center';
      ctx.fillText(`${v.toFixed(0)} s`, pad + v / data.duration * (w - 2 * pad), h - 8);
    }
  }
  function syncVideo(t, force = false) {
    if (!Number.isFinite(video.duration)) return;
    const target = clamp(t, 0, Math.max(0, video.duration - 0.02));
    if (force || Math.abs(video.currentTime - target) > 0.12) video.currentTime = target;
    video.playbackRate = selected === 'camera' ? 1 : clamp(1 / at('rate', t), 0.25, 4);
  }
  function draw() {
    if (!ready || !isOpen()) return;
    getPalette();
    const t = cameraTime(), u = at('sourceTime', t), ratio = at('rate', t);
    drawScene(t);
    drawWave($('am-object-wave'), tracks[mode === 'forward' ? 'object' : 'inverse'], u, palette.source, 'u', mode === 'inverse' ? tracks.object : null);
    drawWave($('am-camera-wave'), tracks.camera, t, palette.camera, 't');
    $('am-distance').textContent = `≈${at('distance', t).toFixed(1)} m`; $('am-pitch').textContent = `×${ratio.toFixed(2)}`;
    const motion = Math.abs(ratio - 1) < 0.025 ? 'Plane · passing the camera' : ratio > 1 ? 'Plane · approaching / higher pitch' : 'Plane · receding / lower pitch';
    if ($('am-motion').textContent !== motion) $('am-motion').textContent = motion;
    $('am-time').textContent = `${cursor.toFixed(2)} s`; scrub.value = cursor; syncVideo(t);
  }
  function setText() {
    const forward = mode === 'forward'; root.dataset.direction = mode;
    modeButtons.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.amDirection === mode)));
    listenButtons.forEach(b => { b.hidden = b.dataset.amListen === 'inverse' && forward; b.setAttribute('aria-pressed', String(b.dataset.amListen === selected)); });
    $('am-objects-title').textContent = forward ? 'Object source · plane' : 'Inverse result · plane';
    $('am-cam-title').textContent = 'At the input camera';
    $('am-operator-name').textContent = forward ? 'Forward rendering ℛ' : 'Inverse rendering 𝒬';
    $('am-operation').textContent = forward ? 'Time warp · air absorption · distance gain' : 'Known plane component · undo propagation';
    $('am-flow-arrow').textContent = forward ? '→' : '←';
    $('am-clock-label').textContent = selected === 'camera' ? 'Camera reception time t' : 'Object emission time u';
    scrub.setAttribute('aria-label', selected === 'camera' ? 'Camera reception time t in seconds' : 'Object emission time u in seconds');
    $('am-audition-status').textContent = `${names[selected]} · ${selected === 'camera' ? 'camera clock' : 'object clock'} · linked video and waveforms`;
    $('am-formula-forward').hidden = !forward;
    $('am-formula-inverse').hidden = forward;
    $('am-formula').setAttribute('aria-label', forward ? 'Forward acoustic rendering formula' : 'Inverse propagation of the known plane contribution');
    $('am-object-wave').setAttribute('aria-label', forward ? 'Real plane source waveform on the object emission clock' : 'Inverse-rendered plane waveform, with the original source faintly overlaid');
    $('am-caption').textContent = forward
      ? 'Listen to the actual plane source, then switch to its camera rendering. Recorded motion changes the timing, pitch, spectrum, and level of the same sound.'
      : 'Listen to the camera contribution and its inverse-rendered result (original source faintly overlaid). The known plane contribution is provided here; this demonstrates inverse propagation, not the source-separation model.';
    $('am-footnote').textContent = 'Real 10 s plane stem and trajectory, re-rendered with the archived model. Plane contribution only; no background mix. All tracks share one playback gain and waveform scale. The inverse removes the mix gain and approximately reverses propagation. Playback covers the common valid time interval. Distances follow the run’s provisional meter scale.';
    if (ready) { const bounds = domain(); scrub.min = bounds[0]; scrub.max = bounds[1]; cursor = clamp(cursor, ...bounds); }
  }
  function updateMute() {
    const muted = soundToggle ? soundToggle.getAttribute('aria-pressed') !== 'true' : false;
    Object.values(tracks).forEach(track => { track.audio.muted = muted; });
  }
  function stop() {
    generation++;
    if (ready && (playing || starting)) cursor = Math.min(tracks[selected].audio.currentTime, domain()[1]);
    playing = false; starting = false; root.dataset.playing = 'false'; cancelAnimationFrame(frame);
    Object.values(tracks).forEach(track => track.audio.pause()); video.pause();
    if (ready && isOpen()) syncVideo(cameraTime(), true);
    play.textContent = ready && cursor >= domain()[1] - 0.03 ? 'Replay with sound' : ready ? 'Play with sound' : 'Load & play';
    play.setAttribute('aria-pressed', 'false');
  }
  function tick() {
    if (!playing) return;
    const audio = tracks[selected].audio; cursor = Math.min(audio.currentTime, domain()[1]); draw();
    if (audio.ended || cursor >= domain()[1] - 0.02) { stop(); draw(); return; }
    frame = requestAnimationFrame(tick);
  }
  async function start(enableSound = true) {
    if (!ready || !isOpen()) return;
    stop(); const request = generation;
    if (cursor >= domain()[1] - 0.03) cursor = domain()[0];
    const audio = tracks[selected].audio;
    document.querySelectorAll('.result-pair.is-playing').forEach(pair => { if (typeof pair._stopAll === 'function') pair._stopAll(); });
    if (enableSound && soundToggle && soundToggle.getAttribute('aria-pressed') !== 'true') soundToggle.click();
    updateMute(); audio.currentTime = cursor;
    starting = true; play.textContent = 'Starting…'; play.setAttribute('aria-pressed', 'true');
    try {
      await audio.play();
      if (request !== generation) return;
      if (!isOpen() || document.hidden) { stop(); return; }
      starting = false; playing = true; root.dataset.playing = 'true'; play.textContent = 'Pause'; play.setAttribute('aria-pressed', 'true');
      syncVideo(cameraTime(), true); video.play().catch(() => {}); frame = requestAnimationFrame(tick);
    } catch (_) { if (request !== generation) return; stop(); $('am-load-status').textContent = 'Audio could not start. Press Play to try again.'; }
  }
  function chooseTrack(key) {
    if (!ready || !tracks[key]) return;
    const resume = playing || starting, t = cameraTime(); stop(); selected = key; cursor = key === 'camera' ? t : at('sourceTime', t);
    setText(); syncVideo(cameraTime(), true); draw(); if (resume) start(false);
  }
  function chooseMode(value) { mode = value; if (ready) chooseTrack(mode === 'forward' ? 'camera' : 'inverse'); else setText(); }
  async function load() {
    if (ready || loading || !isOpen()) return;
    loading = true; $('am-load-status').textContent = 'Loading real plane audio…';
    try {
      const response = await fetch(new URL('data.json', base)); if (!response.ok) throw new Error('Scene data unavailable'); data = await response.json();
      await Promise.all(['object', 'camera', 'inverse'].map(async key => {
        const asset = typeof data.tracks[key] === 'string' ? data.tracks[key] : data.tracks[key].url;
        const response = await fetch(new URL(asset, base)); if (!response.ok) throw new Error(`${names[key]} unavailable`);
        const bytes = await response.arrayBuffer(), decoded = decodeWav(bytes);
        const audio = new Audio(URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' })));
        audio.preload = 'auto'; audio.muted = true; audio.hidden = true; audio.dataset.amTrack = key;
        root.appendChild(audio);
        audio.addEventListener('ended', () => { if (selected === key) { cursor = domain()[1]; stop(); draw(); } });
        tracks[key] = { ...decoded, audio };
        await new Promise((resolve, reject) => {
          audio.addEventListener('loadedmetadata', resolve, { once: true });
          audio.addEventListener('error', () => reject(new Error('Unsupported audio playback')), { once: true }); audio.load();
        });
      }));
      prepareBounds(); ready = true; play.disabled = false;
      modeButtons.forEach(b => { b.disabled = false; }); listenButtons.forEach(b => { b.disabled = false; }); scrub.disabled = false;
      setText(); stop(); draw(); $('am-load-status').textContent = 'Real plane audio ready · choose a track to compare';
    } catch (error) { $('am-load-status').textContent = 'Could not load plane audio. Reload this page to retry.'; console.error('Plane audio mapping:', error); }
    finally { loading = false; }
  }
  play.addEventListener('click', () => { if (playing || starting) stop(); else start(); });
  scrub.addEventListener('input', () => {
    if (!ready) return;
    const target = Number(scrub.value); stop(); cursor = clamp(target, ...domain()); tracks[selected].audio.currentTime = cursor;
    syncVideo(cameraTime(), true); draw(); play.textContent = cursor >= domain()[1] - 0.03 ? 'Replay with sound' : 'Play with sound';
  });
  modeButtons.forEach(button => { button.disabled = true; button.addEventListener('click', () => chooseMode(button.dataset.amDirection)); });
  listenButtons.forEach(button => { button.disabled = true; button.addEventListener('click', () => chooseTrack(button.dataset.amListen)); });
  scrub.disabled = true;
  if (soundToggle) new MutationObserver(updateMute).observe(soundToggle, { attributes: true, attributeFilter: ['aria-pressed'] });
  video.addEventListener('loadedmetadata', () => { if (ready && isOpen()) syncVideo(cameraTime(), true); });
  if (demo) {
    // Observe the open attribute so a close invalidates pending playback immediately.
    new MutationObserver(() => {
      if (!isOpen()) { stop(); return; }
      if (ready) { syncVideo(cameraTime(), true); draw(); } else load();
    }).observe(demo, { attributes: true, attributeFilter: ['open'] });
    if (demo.open) load();
  }
  new IntersectionObserver(entries => {
    if (!entries[0].isIntersecting) { if (playing || starting) stop(); }
    else if (!demo) load();
  }, { threshold: 0 }).observe(demo || root);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  const resize = new ResizeObserver(() => draw()); root.querySelectorAll('canvas').forEach(canvas => resize.observe(canvas));
  setText();
})();
