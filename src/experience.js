import { MathUtils, Vector3 } from 'three';
import { createFoldable, loadModel } from './device/foldable.js';
import { HIGHLIGHTS } from './device/highlights.js';
import { loadLockScreen, loadPanelImage, loadStaticImage, paintCustomImage } from './device/screens.js';
import { createStage } from './stage/stage.js';

const SLIDER_STEPS = 1000;
const SETTLE_SECONDS = 1.15;
const TAP_SETTLE_SECONDS = 1.6;
const NUDGE_DAMPING = 10;
const ARRIVAL_SECONDS = 2.2;
const MAX_STEP_SECONDS = 1 / 20;
const CLICK_TOLERANCE = 4;
const FOLD_DAMPING = 4.5;
const SETTLED_MARGIN = 0.02;
const NOTICE_SECONDS = 4.2;
const PARALLAX_FALLOFF = 1.5;
const FADE_START = 0.2;
const FADE_END = 0.8;
const FADE_SECONDS = 0.6;
const ARRIVAL_POSE = [0, Math.PI * 0.75, 0];
const ARRIVAL_VIEW = { distance: 34, pitch: 1.53, yaw: 0.3 };
// Share of the loading bar each phase fills; the model download dominates.
const IMAGES_SHARE = 0.15;
const MODEL_SHARE = 0.7;
const STELE_URL = './assets/stele.webp';
const OUTER_IMAGE_URL = './assets/outer.jpg';
const INNER_IMAGE_URL = './assets/inner.png';

function easeInOut(progress) {
  return progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
}

function offsetOf(highlight) {
  return [highlight.shift ?? 0, highlight.lift ?? 0];
}

function turn(from, to, amount) {
  const delta = MathUtils.euclideanModulo(to - from + Math.PI, Math.PI * 2) - Math.PI;
  return from + delta * amount;
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export async function start({ host, rack, rail, notice, loader, uploader, bindSelect }) {
  let imagesDone = 0;
  let modelDone = 0;
  const report = (message) =>
    loader.setProgress(0.02 + IMAGES_SHARE * imagesDone + MODEL_SHARE * modelDone, message);

  // Start every download before touching WebGL: creating the renderer and its environment map blocks the
  // main thread, and the model and lock screen artwork download side by side rather than one after another.
  const downloads = Promise.all([
    loadModel((fraction) => {
      modelDone = fraction;
      report(fraction < 1 ? 'Loading 3D model' : 'Loading textures');
    }),
    loadLockScreen().then((screen) => {
      imagesDone = 1;
      report('Loading 3D model');
      return screen;
    }),
  ]);
  downloads.catch(() => {});

  // Let the menu and loader paint before the renderer set-up claims the main thread.
  await nextFrame();
  let stage;
  try {
    stage = createStage(host, rack);
  } catch {
    loader.fail('WebGL is not available.');
    notice.show('This browser could not start WebGL, so the device cannot be drawn.');
    return;
  }

  let foldable;
  try {
    const [model, lockScreen] = await downloads;
    modelDone = 1;
    report('Preparing device');
    await nextFrame();
    foldable = createFoldable(model, lockScreen, stage.renderer.capabilities.getMaxAnisotropy(), stage.scene.environment);
    stage.content.add(foldable.root);
    loader.setProgress(0.92, 'Preparing device');
    // Compile shaders up front (in parallel where the GPU driver allows) so the first frames don't stall.
    await stage.renderer.compileAsync(stage.scene, stage.camera);
  } catch (error) {
    console.error(error);
    loader.fail('The model could not be loaded.');
    notice.show('The device model could not be loaded. Refresh the page to try again.');
    return;
  }

  loadPanelImage(OUTER_IMAGE_URL, 'outer').then(
    (image) => foldable.setPanelImage('outer', image),
    (error) => console.error(error),
  );
  loadPanelImage(INNER_IMAGE_URL, 'inner').then(
    (image) => foldable.setPanelImage('inner', image),
    (error) => console.error(error),
  );

  let stelePromise = null;
  function stele() {
    stelePromise ??= loadStaticImage(STELE_URL);
    return stelePromise;
  }

  let openness = HIGHLIGHTS[0].openness;
  let foldTarget = openness;
  let settle = null;
  let showing = rail.current;
  const nudge = { yaw: 0, pitch: 0, shownYaw: 0, shownPitch: 0 };
  let hasCustomUpload = false;

  function setOpenness(value) {
    openness = value;
    foldable.setOpenness(value);
    if (document.activeElement !== rail.slider) rail.slider.value = String(Math.round(value * SLIDER_STEPS));
  }

  function orbitAllowed() {
    return !settle && (openness <= SETTLED_MARGIN || openness >= 1 - SETTLED_MARGIN);
  }

  function showScreenImage(highlight) {
    if (hasCustomUpload) return;
    if (highlight.image !== 'stele') {
      foldable.clearImage();
      return;
    }
    stele().then(
      (image) => {
        if (!hasCustomUpload && rail.current === highlight) foldable.showImage(image);
      },
      (error) => console.error(error),
    );
  }

  function arrive(highlight, keepOpenness) {
    settle = null;
    foldable.setBlend(1);
    if (!keepOpenness) {
      setOpenness(highlight.openness);
      foldTarget = highlight.openness;
    }
    stage.applyView({
      distance: highlight.view.distance,
      pitch: highlight.view.pitch + nudge.shownPitch,
      yaw: highlight.view.yaw + nudge.shownYaw,
    });
    nudge.yaw = nudge.pitch = nudge.shownYaw = nudge.shownPitch = 0;
    stage.setPose(highlight.pose);
    stage.setOffset(offsetOf(highlight));
    stage.setOrbitEnabled(orbitAllowed());
  }

  function settleOn(highlight, { seconds = SETTLE_SECONDS, keepOpenness = false } = {}) {
    showing = highlight;
    nudge.yaw = nudge.pitch = nudge.shownYaw = nudge.shownPitch = 0;
    foldable.setRoll(highlight.roll ?? null, highlight.screen ?? 'inner');
    foldable.setFocus(highlight.screen ?? null);
    showScreenImage(highlight);
    if (seconds <= 0) {
      arrive(highlight, keepOpenness);
      return;
    }
    settle = {
      highlight,
      fromOpenness: keepOpenness ? null : openness,
      fromView: stage.readView(),
      fromPose: stage.readPose(),
      fromOffset: stage.readOffset(),
      seconds,
      elapsed: 0,
    };
    stage.setOrbitEnabled(false);
  }

  function advance(step) {
    if (!settle) return;
    settle.elapsed += step;
    const progress = Math.min(settle.elapsed / settle.seconds, 1);
    const eased = easeInOut(progress);
    foldable.setBlend(MathUtils.smoothstep(progress, FADE_START, FADE_END));
    const { highlight, fromView, fromPose, fromOffset, fromOpenness } = settle;
    if (fromOpenness !== null) setOpenness(MathUtils.lerp(fromOpenness, highlight.openness, eased));
    nudge.shownYaw = MathUtils.damp(nudge.shownYaw, nudge.yaw, NUDGE_DAMPING, step);
    nudge.shownPitch = MathUtils.damp(nudge.shownPitch, nudge.pitch, NUDGE_DAMPING, step);
    stage.applyView({
      distance: MathUtils.lerp(fromView.distance, highlight.view.distance, eased),
      pitch: MathUtils.lerp(fromView.pitch, highlight.view.pitch, eased) + nudge.shownPitch,
      yaw: turn(fromView.yaw, highlight.view.yaw, eased) + nudge.shownYaw,
    });
    stage.setPose([
      turn(fromPose[0], highlight.pose[0], eased),
      turn(fromPose[1], highlight.pose[1], eased),
      turn(fromPose[2], highlight.pose[2], eased),
    ]);
    const offset = offsetOf(highlight);
    stage.setOffset([
      MathUtils.lerp(fromOffset[0], offset[0], eased),
      MathUtils.lerp(fromOffset[1], offset[1], eased),
    ]);
    if (progress === 1) arrive(highlight, fromOpenness === null);
  }

  bindSelect((highlight) => settleOn(highlight));

  rail.slider.addEventListener('pointerdown', () => {
    stage.setOrbitEnabled(false);
    settleOn(rail.current, { keepOpenness: true });
  });
  rail.slider.addEventListener('input', () => {
    if (settle?.fromOpenness === null) settle = null;
    stage.setOrbitEnabled(false);
    foldTarget = Number(rail.slider.value) / SLIDER_STEPS;
  });

  const canvas = stage.renderer.domElement;

  let press = null;
  let handingOff = false;

  function engage(from) {
    if (from.adjustable) {
      foldTarget = openness >= 0.5 ? 1 : 0;
      settle = null;
      return;
    }
    const target = HIGHLIGHTS.find((entry) => entry.id === from.tapTarget);
    if (target && showing !== target) settleOn(target, { seconds: TAP_SETTLE_SECONDS });
  }

  // A drag that engaged interactive mode keeps going: once orbiting unlocks, replay the press so the
  // controls pick up the same gesture instead of waiting for the next one.
  function handOff() {
    if (!press?.engaged || press.handedOff || !stage.orbitEnabled()) return;
    press.handedOff = true;
    handingOff = true;
    canvas.dispatchEvent(
      new PointerEvent('pointerdown', {
        pointerId: press.pointerId,
        pointerType: press.pointerType,
        isPrimary: true,
        button: 0,
        buttons: 1,
        clientX: press.lastX,
        clientY: press.lastY,
        bubbles: true,
      }),
    );
    handingOff = false;
  }

  function release() {
    press = null;
    canvas.classList.remove('is-grabbing');
  }

  // Raycasting the full mesh is costly, so hover checks run at most once per frame.
  let hoverAt = null;
  function checkHover() {
    if (!hoverAt || press) return;
    canvas.classList.toggle('is-grabbable', stage.hitsContent(hoverAt.x, hoverAt.y));
    hoverAt = null;
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (handingOff) return;
    if (!event.isPrimary) {
      release();
      return;
    }
    const onModel = stage.hitsContent(event.clientX, event.clientY);
    press = {
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      onModel,
      from: rail.current,
      lastX: event.clientX,
      lastY: event.clientY,
      engaged: false,
      handedOff: false,
    };
    canvas.setPointerCapture(event.pointerId);
    if (onModel || stage.orbitEnabled()) canvas.classList.add('is-grabbing');
    rail.collapse();
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!press) {
      if (event.pointerType === 'mouse') hoverAt = { x: event.clientX, y: event.clientY };
      return;
    }
    if (event.pointerId !== press.pointerId) return;
    if (press.engaged && settle && !stage.orbitEnabled()) {
      const turnPerPixel = (Math.PI * 2) / Math.max(canvas.clientHeight, 1);
      nudge.yaw -= (event.clientX - press.lastX) * turnPerPixel;
      nudge.pitch = MathUtils.clamp(
        nudge.pitch - (event.clientY - press.lastY) * turnPerPixel,
        -settle.highlight.view.pitch + 0.05,
        Math.PI - settle.highlight.view.pitch - 0.05,
      );
    }
    press.lastX = event.clientX;
    press.lastY = event.clientY;
    const travel = Math.hypot(event.clientX - press.x, event.clientY - press.y);
    if (press.engaged || !press.onModel || stage.orbitEnabled() || travel <= CLICK_TOLERANCE) return;
    press.engaged = true;
    engage(press.from);
  });

  canvas.addEventListener('pointerleave', () => {
    hoverAt = null;
    if (!press) canvas.classList.remove('is-grabbable');
  });
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerup', (event) => {
    if (!press) return;
    const travel = Math.hypot(event.clientX - press.x, event.clientY - press.y);
    const { onModel, from, engaged } = press;
    release();
    if (event.pointerType === 'mouse') hoverAt = { x: event.clientX, y: event.clientY };
    if (engaged || travel > CLICK_TOLERANCE || !onModel) return;
    engage(from);
  });

  uploader.onChange(async (file) => {
    try {
      const image = await paintCustomImage(file);
      hasCustomUpload = true;
      foldable.showImage(image);
      uploader.setCustom(true);
      rail.select(HIGHLIGHTS[1]);
    } catch {
      notice.show('Unable to read this image. Choose a PNG, JPG, or WebP file.', NOTICE_SECONDS);
    }
  });
  uploader.onReset(() => {
    hasCustomUpload = false;
    showScreenImage(rail.current);
  });

  const eye = new Vector3();
  function trackViewpoint() {
    eye.copy(stage.eyeInContent());
    const reach = eye.length();
    foldable.setViewpoint(eye, reach > 0 ? MathUtils.clamp(eye.z / reach, 0, 1) ** PARALLAX_FALLOFF : 1);
  }

  stage.setPose(ARRIVAL_POSE);
  stage.applyView(ARRIVAL_VIEW);
  setOpenness(0);
  foldTarget = 0;
  rail.unlock();
  uploader.setDisabled(false);
  settleOn(rail.current, { seconds: ARRIVAL_SECONDS });

  let previous = performance.now();
  function frame(now) {
    const step = Math.min((now - previous) / 1000, MAX_STEP_SECONDS);
    previous = now;
    advance(step);
    if (!settle) foldable.advanceBlend(step / FADE_SECONDS);
    if (!settle && Math.abs(foldTarget - openness) > 0.0005) {
      setOpenness(MathUtils.damp(openness, foldTarget, FOLD_DAMPING, step));
      stage.setOrbitEnabled(orbitAllowed());
    }
    handOff();
    checkHover();
    trackViewpoint();
    foldable.render(stage.renderer);
    stage.render();
  }

  // Draw the first frame before revealing the canvas so the fade-in never shows an empty stage.
  frame(previous);
  stage.renderer.setAnimationLoop(frame);
  await nextFrame();
  loader.done();
  foldable.warmUp();

  const prefetch = () => void stele().catch(() => {});
  if ('requestIdleCallback' in window) window.requestIdleCallback(prefetch, { timeout: 3000 });
  else setTimeout(prefetch, 1500);
}