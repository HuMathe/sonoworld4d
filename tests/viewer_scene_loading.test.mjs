import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { test } from 'node:test';

const html = readFileSync(new URL('../demo.html', import.meta.url), 'utf8');
const localRoot = 'output-scenes/test-vggt';
const hfRoot = 'https://huggingface.co/datasets/DerongJin/SonoWorld4D-Demo-Scenes/resolve/1f980c1ae2ddbf5646cc40172a785cf499348d0b/output-scenes/test-vggt';
const functions = ['sceneRootForHostname', 'listScenes', 'populateSceneOptions',
  'selectScenePath', 'setUiLocked', 'fetchOptionalJson', 'sceneArtifactUrl',
  'validRunName', 'loadViewerConfig', 'fetchFirstOptionalJson', 'audioSourceRunUrls',
  'loadAudioSourceMetadata', 'decodeFirstAudio', 'loadSpatialAudioTracks'].map(name => {
  const match = html.match(new RegExp(`^    (?:async )?function ${name}\\([\\s\\S]*?^    }`, 'm'));
  assert.ok(match, `Viewer function ${name} is available`);
  return match[0];
}).join('\n');

function harness(hostname = 'humathe.github.io', respond = () => ({ scenes: ['porsche', 'plane'] })) {
  const requests = [], tracks = new Map();
  const select = {
    value: '', disabled: true, options: [],
    replaceChildren(...options) { this.options = options; this.value = options[0]?.value || ''; },
    add(option) { this.options.push(option); },
  };
  const status = { hidden: true, textContent: '' }, button = { disabled: true };
  const nodes = { scenePathInput: select, sceneListStatus: status, loadSceneBtn: button };
  const s = createContext({
    window: { location: { hostname } }, loadSceneBtn: button, isUiLocked: false,
    document: { getElementById: id => nodes[id] || { classList: { toggle() {} } } },
    Option: function(text, value) { this.text = text; this.value = value; },
    DOMParser: class {
      parseFromString(text) {
        return { querySelectorAll: () => JSON.parse(text).map(href => ({ getAttribute: () => href })) };
      }
    },
    fetch: async url => {
      requests.push(url);
      const data = await respond(url);
      return { ok: data !== undefined, status: data === undefined ? 404 : 200,
        json: async () => {
          if (data === 'invalid-json') throw new SyntaxError('Invalid JSON');
          return data;
        },
        text: async () => JSON.stringify(data), arrayBuffer: async () => ({ url }) };
    },
    audioRunOverride: null, audioSourcesMeta: null, audioTracks: tracks,
    audioCtx: { decodeAudioData: async value => value },
    clearAudioTracks: () => tracks.clear(), sourceRole: source => source.role,
    installAudioTrack: (source, buffer) => tracks.set(String(source.source_id), { source, buffer }),
    console: { info() {}, warn() {} },
  });
  const rootDeclaration = html.match(/^    const SCENE_ROOT = .*;$/m)?.[0];
  assert.ok(rootDeclaration);
  runInContext(`${functions}\n${rootDeclaration}\nglobalThis.root = SCENE_ROOT;`, s);
  return { s, requests, select, status, button, tracks };
}

test('loopback previews stay local and hosted pages use the pinned HF revision', () => {
  for (const url of ['http://localhost:8000/demo.html', 'http://127.0.0.1:8000/demo.html',
    'http://[::1]:8000/demo.html', 'http://[0:0:0:0:0:0:0:1]:8000/demo.html']) {
    assert.equal(harness(new URL(url).hostname).s.root, localRoot);
  }
  assert.equal(harness('::1').s.root, localRoot);
  for (const host of ['humathe.github.io', 'preview.example.org', 'localhost.example.org']) {
    assert.equal(harness(host).s.root, hfRoot);
  }
});

test('manifest order, default scene, and option paths follow the selected resource root', async () => {
  for (const hostname of ['localhost', 'humathe.github.io']) {
    const h = harness(hostname);
    await h.s.populateSceneOptions();
    assert.deepEqual(h.requests, [`${h.s.root}/scenes.json`]);
    assert.deepEqual(h.select.options.map(option => option.text), ['porsche', 'plane']);
    assert.deepEqual(h.select.options.map(option => option.value),
      ['porsche', 'plane'].map(scene => `${h.s.root}/${scene}`));
    assert.equal(h.select.value, `${h.s.root}/porsche`);
    assert.equal(h.select.disabled, false);
    assert.equal(h.button.disabled, false);
    assert.equal(h.status.hidden, true);
  }
});

test('HF failures show a recoverable message and never request a directory or another root', async () => {
  for (const result of [undefined, 'invalid-json', {}, { scenes: [] }, { scenes: ['../plane'] }]) {
    const h = harness('humathe.github.io', () => result);
    await h.s.populateSceneOptions();
    h.s.setUiLocked(false);
    assert.deepEqual(h.requests, [`${hfRoot}/scenes.json`]);
    assert.equal(h.select.value, '');
    assert.equal(h.select.disabled, true);
    assert.equal(h.button.disabled, true);
    assert.equal(h.status.hidden, false);
    assert.match(h.status.textContent, /connection.*reload/i);
  }
  const h = harness('humathe.github.io', () => { throw new TypeError('offline'); });
  await h.s.populateSceneOptions();
  assert.deepEqual(h.requests, [`${hfRoot}/scenes.json`]);
  assert.equal(h.status.hidden, false);
  assert.equal(h.button.disabled, true);
});

test('only local previews retain directory discovery when their manifest is absent', async () => {
  const h = harness('127.0.0.1', url => url.endsWith('scenes.json')
    ? undefined : ['../', '.hidden/', 'porsche/', 'plane/']);
  await h.s.populateSceneOptions();
  assert.deepEqual(h.requests, [`${localRoot}/scenes.json`, `${localRoot}/`]);
  assert.deepEqual(h.select.options.map(option => option.text), ['porsche', 'plane']);
});

test('a pending manifest cannot overwrite or disable an explicit API scene selection', async () => {
  for (const manifest of [{ scenes: ['porsche', 'plane'] }, undefined]) {
    let release;
    const h = harness('humathe.github.io', () => new Promise(resolve => { release = resolve; }));
    const pending = h.s.populateSceneOptions();
    const path = 'https://example.org/custom-scene';
    h.s.selectScenePath(path);
    h.s.setUiLocked(true);
    release(manifest);
    await pending;
    assert.equal(h.select.value, path);
    assert.equal(h.select.disabled, false);
    assert.equal(h.button.disabled, true);
    h.s.setUiLocked(false);
    assert.equal(h.button.disabled, false);
  }
});

test('explicit API selection remains usable after a scene-list failure', async () => {
  const h = harness('humathe.github.io', () => undefined);
  await h.s.populateSceneOptions();
  h.s.selectScenePath(`${localRoot}/porsche`);
  h.s.setUiLocked(false);
  assert.equal(h.select.value, `${localRoot}/porsche`);
  assert.equal(h.select.disabled, false);
  assert.equal(h.button.disabled, false);
  assert.equal(h.status.hidden, true);
});

test('published scene configuration, assets, and all 27 audio stems stay under one pinned root', async () => {
  let totalTracks = 0;
  for (const [scene, count, run, assetCount] of [
    ['porsche', 18, 'sw4d_audio_v8', 75], ['plane', 9, 'sw4d_audio_v6_10s', 48],
  ]) {
    const base = `${hfRoot}/${scene}`;
    const fixtureRoot = new URL(`./fixtures/scenes/${scene}/`, import.meta.url);
    const exported = JSON.parse(readFileSync(new URL('demo-export.json', fixtureRoot), 'utf8'));
    const assets = new Map(exported.files.map(file => [file.path, file]));
    assert.equal(assets.size, assetCount);
    assert.equal(assets.size, exported.files.length, 'Export paths must be unique');
    const jsonPaths = [`audio/sources/${run}/sources-meta.json`];
    if (scene === 'plane') {
      assert.equal(exported.viewer_config, 'viewer-config.json');
      jsonPaths.push(exported.viewer_config, 'study-render-metadata.json');
    }
    const jsonFixtures = new Map(jsonPaths.map(path => {
      const raw = readFileSync(new URL(path, fixtureRoot));
      const entry = assets.get(path);
      if (entry) {
        assert.equal(raw.byteLength, entry.bytes, path);
        assert.equal(createHash('sha256').update(raw).digest('hex'), entry.sha256, path);
      }
      return [path, JSON.parse(raw.toString('utf8'))];
    }));
    // Verified JSON and export allowlists from HF commit
    // 1f980c1ae2ddbf5646cc40172a785cf499348d0b; no local scene assets or network needed.
    const h = harness('humathe.github.io', url => {
      assert.ok(url.startsWith(`${base}/`), `Unexpected resource root: ${url}`);
      const path = url.slice(base.length + 1);
      if (jsonFixtures.has(path)) return jsonFixtures.get(path);
      return assets.has(path) && path.endsWith('.wav') ? {} : undefined;
    });
    const config = await h.s.loadViewerConfig(base);
    h.s.audioRunOverride = config.audio_run ?? null;
    const metadata = await h.s.loadAudioSourceMetadata(base);
    h.s.audioSourcesMeta = metadata.data;
    assert.equal(metadata.url, `${base}/audio/sources/${run}/sources-meta.json`);
    assert.equal(await h.s.loadSpatialAudioTracks(base), count);
    totalTracks += h.tracks.size;
    for (const track of h.tracks.values()) {
      assert.ok(track.buffer.url.startsWith(`${base}/audio/sources/${run}/`));
      assert.ok(assets.has(track.buffer.url.slice(base.length + 1)), track.source.source_id);
    }
    assert.equal((await h.s.fetch(`${base}/audio/sources/${run}/not-exported.wav`)).ok, false);
    for (const file of exported.files) {
      const url = h.s.sceneArtifactUrl(base, file.path);
      assert.equal(url, `${base}/${file.path}`);
      assert.equal(new URL(file.path, `${base}/`).href, url, 'Asset paths must stay inside their scene');
      assert.ok(Number.isSafeInteger(file.bytes) && file.bytes > 0, file.path);
      assert.match(file.sha256, /^[a-f0-9]{64}$/, file.path);
    }
  }
  assert.equal(totalTracks, 27);
});
