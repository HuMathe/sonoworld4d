import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { test } from 'node:test';

const html = readFileSync(new URL('../demo.html', import.meta.url), 'utf8');
const functions = ['validRunName', 'loadViewerConfig', 'audioSourceRunUrls',
  'fetchFirstOptionalJson', 'loadAudioSourceMetadata', 'sceneArtifactUrl',
  'decodeFirstAudio', 'loadSpatialAudioTracks', 'loadLegacyAudioFallback',
  'applyFixedProjection', 'enterFreeExploreAtSceneStart'].map(name => {
  const match = html.match(new RegExp(`^    (?:async )?function ${name}\\([\\s\\S]*?^    }`, 'm'));
  assert.ok(match, `Viewer function ${name} must be available`);
  return match[0];
}).join('\n');

function harness(responses = new Map()) {
  const requests = [], logs = [];
  const tracks = new Map();
  const s = createContext({
    audioRunOverride: null, audioSourcesMeta: null, audioTracks: tracks, focusObjectId: '0',
    initialCameraPose: null, fallbackCameraFrames: [], projectionUpdates: 0,
    FIXED_FOV_DEG: Number(html.match(/const FIXED_FOV_DEG\s*=\s*([\d.]+);/)?.[1]),
    cameraViewportAspect: () => 16 / 9,
    console: { info: (...args) => logs.push(args), warn() {} },
    fetch: async url => {
      requests.push(url);
      const entry = responses.get(url);
      return { ok: entry !== undefined && !entry.status, status: entry?.status || (entry === undefined ? 404 : 200),
        json: async () => {
          if (entry?.malformed) throw new SyntaxError('Invalid JSON');
          return entry?.json;
        },
        arrayBuffer: async () => ({ url }),
      };
    },
    audioCtx: { decodeAudioData: async data => data },
    clearAudioTracks: () => tracks.clear(),
    installAudioTrack: (source, buffer) => tracks.set(String(source.source_id), { source, buffer, sourcePeak: 1 }),
    sourceRole: source => source.role,
  });
  runInContext(`
    const camera = { near: .05, far: 2000, fov: FIXED_FOV_DEG,
      updateProjectionMatrix() { projectionUpdates++; } };
    globalThis.camera = camera;
    function enterFreeExploreAtVggtFrame(frame) { fallbackCameraFrames.push(frame); }
    ${functions}
  `, s);
  return { s, requests, logs, responses };
}

const base = '/scene';
const run = 'sw4d_audio_v6_10s';
const runPath = `${base}/audio/sources/${run}`;

test('configured audio run loads only its metadata and WAV fallbacks while honoring declared paths first', async () => {
  const metadata = { sources: [
    { source_id: 'plane', role: 'dynamic', audio: 'custom/authored.wav', geometry_object_id: 0 },
    { source_id: 'grass', role: 'static', source_index: 1, geometry_object_id: 5 },
  ], object_audios: [null, `audio/sources/${run}/listed.wav`] };
  const { s, requests, logs } = harness(new Map([
    [`${base}/viewer-config.json`, { json: { audio_run: ` ${run} ` } }],
    [`${runPath}/sources-meta.json`, { json: metadata }],
    [`${base}/custom/authored.wav`, {}], [`${runPath}/object_0.wav`, {}],
    [`${runPath}/object_5.wav`, {}],
  ]));
  const config = await s.loadViewerConfig(base);
  s.audioRunOverride = config.audio_run;
  s.audioSourcesMeta = (await s.loadAudioSourceMetadata(base)).data;
  assert.equal(await s.loadSpatialAudioTracks(base), 2);
  assert.equal(s.audioTracks.get('plane').buffer.url, `${base}/custom/authored.wav`);
  assert.equal(s.audioTracks.get('grass').buffer.url, `${runPath}/object_5.wav`);
  assert.ok(requests.includes(`${runPath}/listed.wav`));
  assert.ok(!requests.some(url => url.includes('/sw4d_audio_v8')));
  assert.ok(!requests.includes(`${runPath}/object_0.wav`));
  assert.ok(logs.some(args => args[0] === 'Audio source run:' && args[1] === run));
});

test('missing or malformed configured metadata fails without silently probing another audio version', async () => {
  for (const entry of [undefined, { malformed: true }, { json: null }]) {
    const { s, requests, responses } = harness(new Map([
      [`${base}/audio/sources/sw4d_audio_v8/sources-meta.json`, { json: { sources: [] } }],
    ]));
    if (entry) responses.set(`${runPath}/sources-meta.json`, entry);
    s.audioRunOverride = run;
    await assert.rejects(s.loadAudioSourceMetadata(base), /Configured audio run.*sources-meta/);
    assert.deepEqual(requests, [`${runPath}/sources-meta.json`]);
  }
});

test('a configured final-mix fallback cannot pick an unrelated legacy object WAV', async () => {
  const { s, requests, responses } = harness(new Map([
    [`${base}/audio/sources/sw4d_audio_v8_dev/object_0.wav`, {}],
  ]));
  s.audioRunOverride = run;
  s.audioSourcesMeta = {};
  assert.equal(await s.loadLegacyAudioFallback(base), null);
  assert.deepEqual(requests, [`${runPath}/object_0.wav`]);
  requests.length = 0;
  responses.set(`${runPath}/object_0.wav`, {});
  assert.equal((await s.loadLegacyAudioFallback(base)).url, `${runPath}/object_0.wav`);
});

test('scenes without viewer-config keep the existing v8_dev then v8 discovery and fallback order', async () => {
  const { s, requests } = harness(new Map([
    [`${base}/audio/sources/sw4d_audio_v8/sources-meta.json`, { json: { sources: [] } }],
  ]));
  const config = await s.loadViewerConfig(base);
  s.audioRunOverride = config.audio_run ?? null;
  const result = await s.loadAudioSourceMetadata(base);
  assert.equal(result.url, `${base}/audio/sources/sw4d_audio_v8/sources-meta.json`);
  assert.deepEqual(requests, [`${base}/viewer-config.json`,
    `${base}/audio/sources/sw4d_audio_v8_dev/sources-meta.json`,
    `${base}/audio/sources/sw4d_audio_v8/sources-meta.json`]);
  assert.deepEqual(Array.from(s.audioSourceRunUrls(base, 'object_2.wav')), [
    `${base}/audio/sources/sw4d_audio_v8_dev/object_2.wav`,
    `${base}/audio/sources/sw4d_audio_v8/object_2.wav`,
  ]);
});

test('invalid configs fail explicitly, including malformed JSON and invalid runtime source gains', async () => {
  const invalid = [
    null, [], { audio_run: '../wrong' }, { audio_run: 'a/b' }, { audio_run: '' },
    { audio_source_overrides: [] },
    { audio_source_overrides: { plane: { gain: -1, reference_distance: 1 } } },
    { audio_source_overrides: { plane: { gain: 1, reference_distance: 0 } } },
    { audio_source_overrides: { plane: { gain: '1', reference_distance: 1 } } },
    { audio_source_overrides: { plane: { gain: Infinity, reference_distance: 1 } } },
  ];
  for (const json of invalid) {
    const { s } = harness(new Map([[`${base}/viewer-config.json`, { json }]]));
    await assert.rejects(s.loadViewerConfig(base), /viewer-config/);
  }
  for (const entry of [{ malformed: true }, { status: 500 }]) {
    const { s } = harness(new Map([[`${base}/viewer-config.json`, entry]]));
    await assert.rejects(s.loadViewerConfig(base));
  }
  const { s } = harness(new Map([[`${base}/viewer-config.json`, { json: {
    audio_source_overrides: { bed: { gain: 0, reference_distance: 1 } },
  } }]]));
  assert.equal((await s.loadViewerConfig(base)).audio_source_overrides.bed.gain, 0);
});

test('bundled Plane keeps the user-study audio but starts at the original VGGT free view and 60 degree FOV', async () => {
  const root = new URL('./fixtures/scenes/plane/', import.meta.url);
  const rawConfig = JSON.parse(readFileSync(new URL('viewer-config.json', root), 'utf8'));
  const { s } = harness(new Map([[`${base}/viewer-config.json`, { json: rawConfig }]]));
  const config = await s.loadViewerConfig(base);
  assert.equal(config.audio_run, 'sw4d_audio_v6_10s');
  assert.equal(Object.hasOwn(config, 'initial_camera'), false);
  assert.deepEqual(config.provenance, rawConfig.provenance); // unrelated config fields survive validation
  s.initialCameraPose = config.initial_camera || null;
  s.camera.fov = 35;
  s.enterFreeExploreAtSceneStart();
  s.applyFixedProjection();
  assert.deepEqual(Array.from(s.fallbackCameraFrames), [0]);
  assert.equal(s.camera.fov, 60);
  assert.equal(s.projectionUpdates, 1);
});

test('invalid starting poses and FOVs are rejected instead of changing the authored view', async () => {
  const valid = { coordinate_system: 'threejs_world_gl', position: [1, 2, 3],
    quaternion_xyzw: [0, 0, 0, 1], fov_degrees: 35 };
  const invalid = [null, {},
    { ...valid, coordinate_system: 'opencv_world' },
    { ...valid, position: [1, 2] }, { ...valid, position: [NaN, 2, 3] },
    { ...valid, position: [Infinity, 2, 3] }, { ...valid, position: ['1', 2, 3] },
    { ...valid, quaternion_xyzw: [0, 0, 1] },
    { ...valid, quaternion_xyzw: [0, 0, 0, 0] },
    { ...valid, quaternion_xyzw: [0, 0, Infinity, 1] },
    ...[0, -1, 180, 181, Infinity, NaN, '35'].map(fov_degrees => ({ ...valid, fov_degrees })),
  ];
  for (const initial_camera of invalid) {
    const { s } = harness(new Map([[`${base}/viewer-config.json`, { json: { initial_camera } }]]));
    await assert.rejects(s.loadViewerConfig(base), /initial_camera/);
  }
  const { fov_degrees, ...poseWithoutFov } = valid;
  const { s } = harness(new Map([[`${base}/viewer-config.json`, { json: { initial_camera: poseWithoutFov } }]]));
  s.initialCameraPose = (await s.loadViewerConfig(base)).initial_camera;
  s.applyFixedProjection();
  assert.equal(s.camera.fov, 60);
});

test('an unconfigured scene keeps the first VGGT free view and resets the previous scene FOV to 60', async () => {
  const { s } = harness();
  s.initialCameraPose = { fov_degrees: 35 };
  s.applyFixedProjection();
  assert.equal(s.camera.fov, 35);
  const config = await s.loadViewerConfig(base);
  s.initialCameraPose = config.initial_camera || null;
  s.enterFreeExploreAtSceneStart();
  s.applyFixedProjection();
  assert.deepEqual(Array.from(s.fallbackCameraFrames), [0]);
  assert.equal(s.camera.fov, 60);
});
