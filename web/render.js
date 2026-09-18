// Renders one stadium through the shared HitRenderer (so the still carries
// everything the live view draws: the lit park, mound, bases, plate and foul
// lines) from the fixed RENDER_CAMERA, then publishes the result in the DOM
// for render_stadiums.py to collect:
//
//   <pre id="rio-render">{ stadium, width, height, matrix, scene, glow }</pre>
//
// `scene` is the finished park (webp). `glow` is only the light-emitting parts
// on a transparent background (png), for pulsing over the still. `matrix` maps
// stadium coordinates (x, 0, z, 1) to clip space (column-major, includes the
// x-flip) so anything can be pinned to the picture.
//
// Query: stadium=<name>  w=1400 h=1050  live=1 (keep animating, no output)
//        cx cy cz tx ty tz fov (camera overrides while tuning)  shadows=0

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { HitRenderer } from './renderer.js';
import { pulseGlow, RENDER_CAMERA } from './stadium.js';
import { getRenderTheme, hasNight } from './themes.js';

const params = new URLSearchParams(location.search);
const num = (key, fallback) => (params.has(key) && Number.isFinite(Number(params.get(key))) ? Number(params.get(key)) : fallback);
const status = document.getElementById('status');

async function main() {
  const stadiumName = params.get('stadium') || 'Mario Stadium';
  const width = num('w', RENDER_CAMERA.width);
  const height = num('h', RENDER_CAMERA.height);
  const live = params.get('live') === '1';
  const shadows = params.get('shadows') !== '0';
  const theme = getRenderTheme(stadiumName);

  const viewport = document.getElementById('viewport');
  viewport.style.width = `${width}px`;
  viewport.style.height = `${height}px`;
  const hr = new HitRenderer({
    viewport, labels: document.getElementById('labels'),
    orbit: false, autoRender: false, shadows, night: hasNight(stadiumName),
  });
  hr.renderer.setPixelRatio(1);
  hr.renderer.setSize(width, height, false);
  if (shadows) hr.sunLight.shadow.mapSize.set(4096, 4096);

  const [px, py, pz] = RENDER_CAMERA.position;
  const [tx, ty, tz] = RENDER_CAMERA.target;
  const camera = hr.camera;
  camera.fov = num('fov', RENDER_CAMERA.fov);
  camera.aspect = width / height;
  camera.near = 1;
  camera.far = 4000;
  camera.position.set(num('cx', px), num('cy', py), num('cz', pz));
  camera.lookAt(num('tx', tx), num('ty', ty), num('tz', tz));
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();

  const composer = new EffectComposer(hr.renderer);
  composer.setSize(width, height);
  composer.addPass(new RenderPass(hr.scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(width, height), 0.42, 0.55, 0.86));
  composer.addPass(new OutputPass());

  const json = await (await fetch(`/api/stadium/${encodeURIComponent(stadiumName)}`)).json();
  hr.setStadium(stadiumName, json);
  hr.world.updateMatrixWorld(true);
  const built = hr._stadiumBuild;

  if (live) {
    const animate = () => {
      requestAnimationFrame(animate);
      pulseGlow(hr.pulsingMaterials, performance.now());
      composer.render();
    };
    animate();
    status.textContent = `${stadiumName} · ${theme.label} · live`;
    return;
  }

  // Base pass: the finished park (shadow maps bake on this first render).
  pulseGlow(hr.pulsingMaterials, 0, 0);
  composer.render();
  const sceneUrl = hr.renderer.domElement.toDataURL('image/webp', 0.92);

  // Glow pass: only what emits light, on a transparent background.
  for (const child of hr.stadiumGroup.children) child.visible = child === built.group;
  for (const child of built.group.children) child.visible = built.glow.includes(child);
  hr.scene.background = null;
  hr.renderer.setClearColor(0x000000, 0);
  hr.renderer.render(hr.scene, camera);
  const glowUrl = hr.renderer.domElement.toDataURL('image/png');

  const matrix = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(hr.world.matrixWorld);
  const pre = document.createElement('pre');
  pre.id = 'rio-render';
  pre.hidden = true;
  pre.textContent = JSON.stringify({ stadium: stadiumName, width, height, matrix: matrix.elements, scene: sceneUrl, glow: glowUrl });
  document.body.appendChild(pre);
  status.textContent = `${stadiumName} · ${theme.label} · ready`;
  document.title = 'rio-render-ready';
}

main().catch((error) => { status.textContent = `failed: ${error.message}`; console.error(error); });
