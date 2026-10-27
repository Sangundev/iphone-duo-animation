import {
  BufferAttribute,
  Group,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  SRGBColorSpace,
  Texture,
  Vector2,
  Vector3,
  Vector4,
} from 'three';
import { USDLoader } from 'three/addons/loaders/USDLoader.js';
import { paintPanelLockScreen } from './screens.js';
import { ScreenWipe } from './wipe.js';

const MODEL_URL = './assets/iPhone_Duo_Render.usdc';
// Fallback for progress when the server compresses the response and omits its length.
const MODEL_BYTES = 3_638_212;
const MODEL_SCALE = 100;
const MODEL_DROP = 5.8974;
const COVER_HALF = 'upTUAKvMVkPOMKq';
const CAMERA_HALF = 'SiftyleUEEZwLhF';
const INNER_SCREEN = 'UXtsBZYlaUvHoEh';
const OUTER_SCREEN = 'hhgAIoCGsHXeDPY';
const FLEXIBLE_MESHES = new Set(['JnJdTkxbQgUtLwU', 'xdyyaajWsatVNxN', INNER_SCREEN, 'MvKPXGSdYDVvSpk']);
const UI_REFERENCE_EYE = new Vector3(0, 0, 40);
const INNER_UI_FRAME = new Vector4(-7.89935, 0.34562 - MODEL_DROP, 15.7987, 11.1035);
const OUTER_UI_FRAME = new Vector4(0.23396, 0.27173 - MODEL_DROP, 7.73936, 11.2513).multiplyScalar(
  (UI_REFERENCE_EYE.z - 0.24948) / (UI_REFERENCE_EYE.z - 0.825538),
);
const INNER_PIXEL = new Vector2(1 / 1600, 1 / 1125);
const OUTER_PIXEL = new Vector2(1 / 774, 1 / 1125);
const CLOSED_ZOOM = 1.47;

const LAYER_DEPTH = { sky: 0.47, mountain: 1, dune: 0.7 };
const VIBRANCE = 1;
const screenShader = `
uniform float foldAngle;
uniform vec4 screenFrame;
uniform vec3 uiReferenceEye;
uniform float uiParallax;
uniform float uiSettle;
uniform float uiPreviousParallax;
uniform float uiPreviousSettle;
uniform float uiBlend;
uniform sampler2D uiPreviousMap;
uniform float uiVibrance;
uniform vec2 uiShade;
uniform float uiWipePosition;
varying vec3 vUIPosition;
vec3 vibrance(vec3 color) {
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  return max(vec3(0.0), mix(vec3(luma), color, uiVibrance));
}
vec3 screenLayer(sampler2D map, float parallax, float settle) {
  float depth = (0.24948 - uiReferenceEye.z) / (vUIPosition.z - uiReferenceEye.z);
  vec2 plane = uiReferenceEye.xy + (vUIPosition.xy - uiReferenceEye.xy) * depth;
  #ifndef INNER_UI
    float c = cos(foldAngle), s = sin(foldAngle);
    vec2 hingeEdge = vec2(-0.23396, -0.27463 - 0.275454);
    vec2 foldedEdge = vec2(c * hingeEdge.x + s * hingeEdge.y,
      -s * hingeEdge.x + c * hingeEdge.y + 0.275454);
    float edgeDepth = (0.24948 - uiReferenceEye.z) / (foldedEdge.y - uiReferenceEye.z);
    plane.x += screenFrame.x - (uiReferenceEye.x + (foldedEdge.x - uiReferenceEye.x) * edgeDepth);
  #endif
  float progress = clamp(foldAngle / 3.141592654, 0.0, 1.0) * settle;
  #ifdef INNER_UI
    float wipeAmount = progress;
  #else
    float wipeAmount = clamp(1.0 - 2.0 * abs(progress - 0.5), 0.0, 1.0) * 0.5;
  #endif
  plane = mix(screenFrame.xy + vEmissiveMapUv * screenFrame.zw, plane, parallax);
  vec2 uv = ((plane - screenFrame.xy) / screenFrame.zw - 0.5) / 1.12 + 0.5;
  float distanceToWipe = distance(vEmissiveMapUv.x, uiWipePosition);
  float wipe = 1.0 - clamp(smoothstep(uiShade.x, uiShade.y, distanceToWipe) * wipeAmount * 1.5, 0.0, 1.0);
  float edges = smoothstep(1.1, 1.0, uv.x) * smoothstep(-0.1, 0.0, uv.x)
    * smoothstep(1.1, 1.0, uv.y) * smoothstep(-0.1, 0.0, uv.y);
  #ifdef INNER_UI
    edges = mix(edges, edges * smoothstep(0.05, 0.5, uv.x), smoothstep(0.0, 0.55, wipeAmount));
  #else
    float along = vEmissiveMapUv.x + (vEmissiveMapUv.y - 0.5) * 0.18;
    float offset = along - mix(1.25, -0.25, smoothstep(0.08, 0.8, progress));
    float band = 0.72 * exp(-offset * offset / 0.02) + 0.28 * exp(-offset * offset / 0.0016);
    float glint = sin(3.141592654 * clamp((progress - 0.04) / 0.8, 0.0, 1.0));
  #endif
  vec3 color = vibrance(texture(map, uv).rgb) * wipe * edges;
  #ifndef INNER_UI
    color = mix(color, vec3(1.0, 0.985, 0.96), 0.15 * glint * band);
  #endif
  return color;
}
vec3 screenColor() {
  vec3 incoming = screenLayer(emissiveMap, uiParallax, uiSettle);
  if (uiBlend >= 1.0) return incoming;
  return mix(screenLayer(uiPreviousMap, uiPreviousParallax, uiPreviousSettle), incoming, uiBlend);
}
`;
const foldShader = `
uniform float foldAngle;
vec2 rotateHinge(vec2 p) {
  float c = cos(foldAngle), s = sin(foldAngle);
  p.y -= 0.275454;
  return vec2(c * p.x + s * p.y, -s * p.x + c * p.y + 0.275454);
}
#ifdef FLEXIBLE_SCREEN
vec2 bendStrip(vec3 p) {
  float halfWidth = 0.35;
  if (p.x >= halfWidth) return vec2(p.x, p.z);
  if (p.x <= -halfWidth) return rotateHinge(p.xz);
  float t = (p.x + halfWidth) / (2.0 * halfWidth);
  float t2 = t*t, t3 = t2*t;
  vec2 a = rotateHinge(vec2(-halfWidth, p.z));
  vec2 b = vec2(halfWidth, p.z);
  vec2 ta = 2.0 * halfWidth * vec2(cos(foldAngle), -sin(foldAngle));
  vec2 tb = vec2(2.0 * halfWidth, 0.0);
  return (2.0*t3-3.0*t2+1.0)*a + (t3-2.0*t2+t)*ta + (-2.0*t3+3.0*t2)*b + (t3-t2)*tb;
}
#endif
`;
const LAYERS = ['sky', 'mountain', 'dune'];

// The USD references a few textures that are not shipped. A texture whose image never loaded samples as
// black, so an absent AO map darkens the hinge cover and an absent base map blacks out the camera plate.
const TEXTURE_SLOTS = [
  'map',
  'roughnessMap',
  'metalnessMap',
  'normalMap',
  'aoMap',
  'alphaMap',
  'clearcoatMap',
  'clearcoatNormalMap',
  'clearcoatRoughnessMap',
  'specularColorMap',
  'specularIntensityMap',
  'sheenColorMap',
  'transmissionMap',
];
const SHELL_COLOR = 0xf5f1ea;
// The hinge liner and cover ship dark; give them the titanium frame's finish so the spine reads silver.
const HINGE_MESHES = new Set(['xdyyaajWsatVNxN', 'MvKPXGSdYDVvSpk', 'pmvwSuCeZpxeLmT', 'bsNHOLGaZbhIluH']);
const FRAME_COLOR = 0xe3d9c8;
const FRAME_ROUGHNESS = 0.16;

function matchFrame(material) {
  material.color.set(FRAME_COLOR);
  material.metalness = 1;
  material.roughness = FRAME_ROUGHNESS;
  material.map = material.aoMap = material.roughnessMap = material.metalnessMap = null;
  material.needsUpdate = true;
}

function dropMissingTextures(material) {
  for (const slot of TEXTURE_SLOTS) {
    const texture = material[slot];
    if (!(texture instanceof Texture) || texture.image) continue;
    material[slot] = null;
    if (slot === 'map') material.color?.set(SHELL_COLOR);
    material.needsUpdate = true;
  }
}

function createTexture(image, anisotropy, premultiplied = false) {
  const texture = new Texture(image);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = anisotropy;
  texture.premultiplyAlpha = premultiplied;
  texture.needsUpdate = true;
  return texture;
}

function belongsToCoverHalf(object) {
  let ancestor = object;
  while (ancestor && ancestor.name !== COVER_HALF && ancestor.name !== CAMERA_HALF) {
    ancestor = ancestor.parent;
  }
  return ancestor?.name === COVER_HALF;
}

function frameLayer(openness, depth, frame) {
  const shut = 1 + (CLOSED_ZOOM - 1) * depth;
  const zoom = MathUtils.lerp(shut, 1, MathUtils.smoothstep(openness, 0.3, 1));
  const width = INNER_UI_FRAME.z * zoom;
  const height = INNER_UI_FRAME.w * zoom;
  frame.set(-width / 2, INNER_UI_FRAME.y + INNER_UI_FRAME.w / 2 - height / 2, width, height);
}

function frameWithin(panel, layer, out) {
  return out.set(
    (panel.x - layer.x) / layer.z,
    (panel.y - layer.y) / layer.w,
    panel.z / layer.z,
    panel.w / layer.w,
  );
}

function sameDress(a, b) {
  return (
    a.backdrop === b.backdrop &&
    a.layered === b.layered &&
    a.clock === b.clock &&
    a.fit === b.fit &&
    a.settled === b.settled &&
    a.dim === b.dim
  );
}

export function loadModel(onProgress) {
  return new USDLoader().loadAsync(MODEL_URL, (event) => {
    const total = event.total || MODEL_BYTES;
    onProgress?.(Math.min(event.loaded / total, 1));
  });
}

export function createFoldable(model, lockScreen, anisotropy, environment) {
  const root = new Group();
  const bend = { value: 0 };
  const referenceEye = { value: UI_REFERENCE_EYE.clone() };
  const backdrop = createTexture(lockScreen.backdrop, anisotropy);
  const sky = createTexture(lockScreen.sky, anisotropy, true);
  const mountain = createTexture(lockScreen.mountain, anisotropy, true);
  // Each fitted lock screen is a full-size canvas paint, so only paint the ones a highlight asks for.
  const fitted = { inner: {}, outer: {} };

  function fittedTexture(kind, direction) {
    const cached = fitted[kind][direction];
    if (cached) return cached;
    const texture = createTexture(paintPanelLockScreen(lockScreen, kind, direction), anisotropy);
    fitted[kind][direction] = texture;
    return texture;
  }

  function warmUp() {
    const pending = [];
    for (const kind of ['inner', 'outer'])
      for (const direction of ['none', 'clockwise', 'anticlockwise'])
        if (!fitted[kind][direction]) pending.push([kind, direction]);
    // The render loop can keep a slow device from ever going idle, so each job also has a deadline.
    const idle = (callback) => {
      if ('requestIdleCallback' in window) window.requestIdleCallback(callback, { timeout: 1000 });
      else setTimeout(callback, 120);
    };
    const next = () => {
      const job = pending.shift();
      if (!job) return;
      fittedTexture(job[0], job[1]);
      idle(next);
    };
    idle(next);
  }

  let customTexture = null;
  let retired = null;
  const turn = { inner: 'none', outer: 'none' };
  let focus = null;
  let fade = 1;

  function fits(kind) {
    return turn[kind] !== 'none' || focus === kind;
  }

  function dressFor(kind) {
    const fit = fits(kind);
    const common = {
      fit,
      settled: focus === kind,
      dim: kind === 'inner' && focus === 'outer',
    };
    if (customTexture) return { ...common, backdrop: customTexture, layered: false, clock: false };
    return {
      ...common,
      backdrop: fit ? fittedTexture(kind, turn[kind]) : backdrop,
      layered: !fit,
      clock: !fit,
    };
  }

  const sizes = {
    inner: new Vector2(1 / INNER_PIXEL.x, 1 / INNER_PIXEL.y),
    outer: new Vector2(1 / OUTER_PIXEL.x, 1 / OUTER_PIXEL.y),
  };
  const wipe = new ScreenWipe(anisotropy, sizes);
  const previousWipe = new ScreenWipe(anisotropy, sizes);

  function createScreen(kind) {
    const inner = kind === 'inner';
    const clock = inner ? lockScreen.innerClock : lockScreen.outerClock;
    const knobs = {
      settle: { value: 1 },
      previousSettle: { value: 1 },
      parallax: { value: 1 },
      previousParallax: { value: 1 },
      blend: { value: 1 },
    };
    return {
      material: new MeshStandardMaterial({
        color: 0x000000,
        emissive: 0xffffff,
        emissiveMap: wipe.texture(kind),
        envMap: environment,
        roughness: inner ? 1 : 0.06,
        metalness: 0,
        envMapIntensity: inner ? 0 : 0.35,
        toneMapped: false,
      }),
      plates: {
        time: createTexture(clock.time, anisotropy, true),
        chrome: createTexture(clock.chrome, anisotropy, true),
      },
      knobs,
      current: dressFor(kind),
      previous: null,
      uniforms: {
        foldAngle: bend,
        uiSettle: knobs.settle,
        uiPreviousSettle: knobs.previousSettle,
        uiParallax: knobs.parallax,
        uiPreviousParallax: knobs.previousParallax,
        uiBlend: knobs.blend,
        uiPreviousMap: { value: previousWipe.texture(kind) },
        screenFrame: { value: inner ? INNER_UI_FRAME : OUTER_UI_FRAME },
        uiWipePosition: { value: inner ? 1 : 0 },
        uiShade: { value: inner ? new Vector2(0.5, 1) : new Vector2(0, 1) },
        uiVibrance: { value: VIBRANCE },
        uiReferenceEye: referenceEye,
      },
    };
  }

  const screens = { inner: createScreen('inner'), outer: createScreen('outer') };
  let dirty = true;
  let openness = 1;
  let shut = 0;
  let viewAmount = 1;
  const layerFrame = new Vector4();
  const composed = { sky: new Vector4(), mountain: new Vector4(), dune: new Vector4() };

  model.scale.multiplyScalar(MODEL_SCALE);
  model.updateMatrixWorld(true);
  let halfWidth = 0;
  const shell = [];

  model.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const geometry = object.geometry.clone().applyMatrix4(object.matrixWorld);
    geometry.translate(0, -MODEL_DROP, 0);
    const moving = belongsToCoverHalf(object);
    const flexible = FLEXIBLE_MESHES.has(object.name);
    const kind = object.name === INNER_SCREEN ? 'inner' : object.name === OUTER_SCREEN ? 'outer' : null;
    const material = kind ? screens[kind].material : object.material.clone();
    if (!kind) dropMissingTextures(material);
    if (HINGE_MESHES.has(object.name)) matchFrame(material);
    if (!kind && material.color) shell.push({ color: material.color, base: material.color.clone() });
    if (!moving) {
      geometry.computeBoundingBox();
      halfWidth = Math.max(halfWidth, geometry.boundingBox?.max.x ?? 0);
    }
    if (kind) {
      const position = geometry.getAttribute('position');
      const uv = new Float32Array(position.count * 2);
      for (let i = 0; i < position.count; i++) {
        uv[i * 2] =
          kind === 'inner'
            ? (position.getX(i) + 7.89935) / 15.7987
            : (-0.23396 - position.getX(i)) / 7.73936;
        uv[i * 2 + 1] =
          kind === 'inner'
            ? (position.getY(i) + MODEL_DROP - 0.34562) / 11.1035
            : (position.getY(i) + MODEL_DROP - 0.27173) / 11.2513;
      }
      geometry.setAttribute('uv', new BufferAttribute(uv, 2));
    }
    if (moving || flexible) {
      material.onBeforeCompile = (shader) => {
        shader.uniforms.foldAngle = bend;
        if (kind) {
          Object.assign(shader.uniforms, screens[kind].uniforms);
          shader.fragmentShader = shader.fragmentShader
            .replace(
              '#include <emissivemap_pars_fragment>',
              `#include <emissivemap_pars_fragment>
              ${kind === 'inner' ? '#define INNER_UI' : ''}
              ${screenShader}`,
            )
            .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance *= screenColor();');
          shader.vertexShader = `varying vec3 vUIPosition;\n${shader.vertexShader}`.replace(
            '#include <project_vertex>',
            `vUIPosition = transformed;
            #include <project_vertex>`,
          );
        }
        shader.vertexShader = `${flexible ? '#define FLEXIBLE_SCREEN\n' : ''}${foldShader}\n${shader.vertexShader}`
          .replace(
            '#include <begin_vertex>',
            `vec2 folded = ${flexible ? 'bendStrip(position)' : 'rotateHinge(position.xz)'};
            vec3 transformed = vec3(folded.x, position.y, folded.y);`,
          )
          .replace(
            '#include <beginnormal_vertex>',
            `vec3 objectNormal = vec3(normal);
            float a = foldAngle${flexible ? ' * (1.0 - smoothstep(-1.6, 1.6, position.x))' : ''};
            objectNormal.x = cos(a) * normal.x + sin(a) * normal.z;
            objectNormal.z = -sin(a) * normal.x + cos(a) * normal.z;`,
          );
      };
      material.customProgramCacheKey = () => `${flexible ? 'fold-flexible' : 'fold-cover'}-${kind ?? 'body'}`;
    }
    const mesh = new Mesh(geometry, material);
    mesh.name = object.name;
    mesh.frustumCulled = false;
    root.add(mesh);
  });

  function light() {
    const lit = MathUtils.lerp(0.25, 1, MathUtils.smoothstep(openness, 0.02, 0.3));
    const glow = (dress) => (dress.dim ? 0.1 : lit);
    const { current, previous } = screens.inner;
    screens.inner.material.emissiveIntensity = previous
      ? MathUtils.lerp(glow(previous), glow(current), fade)
      : glow(current);
    screens.outer.material.emissiveIntensity = 1;
  }

  function sync() {
    for (const kind of ['inner', 'outer']) {
      const { current, previous, knobs } = screens[kind];
      knobs.settle.value = current.settled ? 0 : 1;
      knobs.parallax.value = current.fit ? 0 : viewAmount;
      knobs.previousSettle.value = previous?.settled ? 0 : 1;
      knobs.previousParallax.value = previous?.fit ? 0 : viewAmount;
      knobs.blend.value = previous ? fade : 1;
    }
    light();
  }

  function setOpenness(value) {
    openness = value;
    bend.value = (1 - value) * Math.PI;
    shut = 1 - value;
    dirty = true;
    root.position.x = (-halfWidth / 2) * (1 - value);
    light();
  }

  function dress() {
    const changed = new Set();
    for (const kind of ['inner', 'outer']) {
      const screen = screens[kind];
      const next = dressFor(kind);
      if (sameDress(next, screen.current)) continue;
      if (!screen.previous || fade >= 0.5) screen.previous = screen.current;
      screen.current = next;
      changed.add(kind);
    }
    if (changed.size === 0) return;
    for (const kind of ['inner', 'outer']) {
      if (!changed.has(kind) && fade >= 0.5) screens[kind].previous = null;
    }
    fade = 0;
    dirty = true;
    sync();
  }

  function setRoll(direction, panel = 'inner') {
    turn.inner = panel === 'inner' && direction ? direction : 'none';
    turn.outer = panel === 'outer' && direction ? direction : 'none';
    dress();
  }

  function setFocus(kind) {
    focus = kind;
    dress();
  }

  function setBlend(amount) {
    fade = MathUtils.clamp(amount, 0, 1);
    if (fade >= 1) {
      screens.inner.previous = null;
      screens.outer.previous = null;
      retired?.dispose();
      retired = null;
    }
    sync();
  }

  function advanceBlend(delta) {
    if (screens.inner.previous || screens.outer.previous) setBlend(fade + delta);
  }

  function paint(renderer, target, kind, look) {
    const screen = screens[kind];
    const panel = kind === 'inner' ? INNER_UI_FRAME : OUTER_UI_FRAME;
    for (const layer of LAYERS) {
      if (look.fit) layerFrame.copy(panel);
      else frameLayer(openness, LAYER_DEPTH[layer], layerFrame);
      frameWithin(panel, layerFrame, composed[layer]);
    }
    const swept = kind === 'inner' ? shut : Math.max(0, 1 - 2 * Math.abs(shut - 0.5)) / 2;
    target.render(
      renderer,
      kind,
      {
        backdrop: look.backdrop,
        backdropFrame: composed.mountain,
        landscape: look.layered
          ? {
              sky,
              skyFrame: composed.sky,
              mountain,
              mountainFrame: composed.mountain,
              duneFrame: composed.dune,
            }
          : null,
        clock: look.clock ? screen.plates : null,
      },
      look.settled ? 0 : swept,
    );
  }

  function render(renderer) {
    if (!dirty) return;
    dirty = false;
    for (const kind of ['inner', 'outer']) {
      const screen = screens[kind];
      paint(renderer, wipe, kind, screen.current);
      if (screen.previous) paint(renderer, previousWipe, kind, screen.previous);
    }
  }

  function setViewpoint(eye, amount) {
    referenceEye.value.copy(eye);
    viewAmount = amount;
    sync();
  }

  function swapImage(texture) {
    retired?.dispose();
    retired = customTexture;
    customTexture = texture;
    dress();
  }

  function showImage(image) {
    swapImage(createTexture(image, anisotropy));
  }

  function clearImage() {
    swapImage(null);
  }

  return {
    root,
    setOpenness,
    setRoll,
    setFocus,
    setViewpoint,
    setBlend,
    advanceBlend,
    showImage,
    clearImage,
    render,
    warmUp,
  };
}