import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { test } from 'node:test';

const html = readFileSync(new URL('../demo.html', import.meta.url), 'utf8');
const helper = html.match(/^    function compositeSkyDepthPush\([\s\S]*?^    }/m)?.[0];
assert.ok(helper, 'Viewer sky-depth policy must be available to the test harness');

const layer = (sortBias, overrides = {}) => ({
  sortBias, loaded: true, visible: true, mesh: { visible: true }, ...overrides,
});

function harness(backgroundLayers, bgVisible = true) {
  const state = createContext({ backgroundLayers, bgVisible });
  runInContext(helper, state);
  return state;
}

test('Plane sky-only background moves behind the aircraft while occluders retain their separate pass', () => {
  const s = harness([layer('sky'), layer(undefined)]);
  const push = s.compositeSkyDepthPush();
  assert.equal(push, 1e6);
  // A finite sky shell closer than the aircraft must no longer win the depth comparison.
  const skyDepth = 5, aircraftDepth = 100;
  assert.ok(skyDepth < aircraftDepth);
  assert.ok(skyDepth + push > aircraftDepth);
});

test('Porsche mixed sky and support preserve road depths', () => {
  const s = harness([layer('sky'), layer('contact'), layer(undefined)]);
  assert.equal(s.compositeSkyDepthPush(), 0);
  s.backgroundLayers = [layer('contact')];
  assert.equal(s.compositeSkyDepthPush(), 0);
});

test('only loaded, enabled and actually visible background meshes affect the sky policy', () => {
  for (const inactiveSupport of [
    layer('contact', { loaded: false }),
    layer('contact', { visible: false }),
    layer('contact', { mesh: null }),
    layer('contact', { mesh: { visible: false } }),
  ]) {
    assert.equal(harness([layer('sky'), inactiveSupport]).compositeSkyDepthPush(), 1e6);
  }
  for (const layers of [
    [], [layer(undefined)],
    [layer('sky', { loaded: false })],
    [layer('sky', { visible: false })],
    [layer('sky', { mesh: null })],
    [layer('sky', { mesh: { visible: false } })],
  ]) {
    assert.equal(harness(layers).compositeSkyDepthPush(), 0);
  }
  assert.equal(harness([layer('sky')], false).compositeSkyDepthPush(), 0);
});

test('scene transitions recompute the policy without keeping the previous sky offset', () => {
  const sky = layer('sky'), support = layer('contact', { loaded: false, mesh: null });
  const s = harness([sky, support]);
  assert.equal(s.compositeSkyDepthPush(), 1e6);
  sky.loaded = false; sky.mesh = null; // cleared Plane assets
  assert.equal(s.compositeSkyDepthPush(), 0);
  support.loaded = true; support.mesh = { visible: true }; // Porsche support arrives
  assert.equal(s.compositeSkyDepthPush(), 0);
  sky.loaded = true; sky.mesh = { visible: true };
  assert.equal(s.compositeSkyDepthPush(), 0); // mixed Porsche background
  support.loaded = false; support.mesh = null; // switch back to sky-only Plane
  assert.equal(s.compositeSkyDepthPush(), 1e6);
});

test('composite shader receives the live offset only on background depth', () => {
  const material = html.match(/const compositeMaterial = new THREE\.ShaderMaterial\(\{[\s\S]*?fragmentShader: `([\s\S]*?)`/);
  assert.ok(material, 'Depth composite shader must remain available');
  assert.match(material[0], /uSkyDepthPush:\s*\{\s*value:\s*0\.0\s*\}/);
  const shader = material[1];
  assert.match(shader, /uniform float [^;]*\buSkyDepthPush\b[^;]*;/);
  assert.match(shader, /float bD\s*=\s*depthOf\(texture2D\(tBd,\s*vUv\)\)\s*\+\s*uSkyDepthPush\s*;/);
  assert.match(shader, /float marginB\s*=\s*\(bD\s*\+\s*uTolerance\)\s*-\s*fD\s*;/);
  assert.match(shader, /float oD\s*=\s*depthOf\(texture2D\(tOd,\s*vUv\)\)\s*;/);
  assert.match(shader, /bool fgBeatsO\s*=\s*fD\s*<\s*oD\s*;/);
  assert.match(html, /u\.uSkyDepthPush\.value\s*=\s*compositeSkyDepthPush\(\);\s*renderer\.render\(compositeScene,\s*compositeCamera\)/);
});
