/* =============================================================================
   Transmutación Hero
   -----------------------------------------------------------------------------
   Carrusel infinito de stills + cámara en perspectiva con depth y parallax
   + capa de proyección (haz volumétrico, polvo, grain, vignette, flicker,
   gate weave).

   Sistema de coordenadas (unidades de mundo):
   - El alto visible en el plano z = 0 es VISIBLE_HEIGHT.
   - X crece a la derecha. Las imágenes viajan hacia −X.
   - Z positivo se acerca a la cámara. Las diferencias son sutiles.
   - La cámara mira al origen con un FOV estrecho (perspectiva ligera,
     no gran angular).

   En WordPress, sustituir STILLS[].src por URLs absolutas de la mediateca.
   Las rutas relativas se resuelven respecto a este archivo.
   ============================================================================= */

// --- Configuración ----------------------------------------------------------

const THREE_URL =
  "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js";

/** Tope de devicePixelRatio. 1.5 basta para el movimiento y ahorra fill-rate. */
const MAX_PIXEL_RATIO = 1.5;

/** Alto del encuadre en unidades de mundo. El ancho sale de la proporción real. */
const VISIBLE_HEIGHT = 10;

/**
 * Perspectiva sutil. 28° deja leer la diferencia de Z sin deformar
 * los bordes como lo haría un gran angular.
 */
const CAMERA_FOV = 28;

/** Tope duro del parallax, en grados. El eje combinado no lo supera. */
const MAX_PARALLAX_DEG = 1;

/** Respuesta del seguimiento. Más bajo = más lento, más atmosférico. */
const PARALLAX_RESPONSE = 1.35;

/** Margen extra, en px, para empezar a cargar antes de entrar en vista. */
const PRELOAD_MARGIN = "240px 0px";

const STILLS = [
  {
    src: "../assets/stills/01-vli.webp",
    alt: "Still de proyección, caverna violeta y figura en barca",
    depth: -1.2,
  },
  {
    src: "../assets/stills/02-fep.webp",
    alt: "Still de proyección, retrato en blanco y negro",
    depth: -0.35,
  },
  {
    src: "../assets/stills/03-pndr.jpg",
    alt: "Still de proyección, retrato contra cielo azul",
    depth: 0.08,
  },
  {
    src: "../assets/stills/04-chr.jpg",
    alt: "Still de proyección, figura bajo lámpara en biblioteca",
    depth: 0.3,
  },
  {
    src: "../assets/stills/05-kb.jpg",
    alt: "Still de proyección, dos figuras con helados al anochecer",
    depth: -0.15,
  },
  {
    src: "../assets/stills/06-tpos.jpg",
    alt: "Still de proyección, figura entre un rebaño",
    depth: -0.75,
  },
];

const LAYOUT = {
  /** Alto del still respecto al alto visible. Deja margen negro arriba y abajo. */
  planeHeightRatio: 0.74,
  /** ~2:1. Coincide con los covers cinematográficos (1024×516). */
  planeAspect: 1024 / 516,
  /** Separación entre stills, como fracción del ancho de cada plano. */
  gapRatio: 0.1,
  /**
   * Unidades de mundo por segundo.
   * Con el encuadre actual, un still tarda unos 20 s en ceder su lugar al siguiente.
   */
  speed: 0.62,
};

const PROJECTION = {
  /** Opacity del haz primario / secundario (aditivo). */
  beamOpacity: 0.365,
  beamOpacitySecondaryRatio: 0.08 / 0.14,
  /** Opacity del frame: flicker entre estos extremos. */
  flickerMin: 0.904,
  flickerMax: 1,
  /** Velocidad del flicker (cuánto se acerca al objetivo por segundo). */
  flickerResponse: 2.4,
  /** Gate weave: traslación en px y rotación en grados. */
  weaveX: 1.94,
  weaveY: 1.6415,
  weaveRot: 0.0597,
  weaveResponse: 3.2,
  /** Overlay CSS de grain. */
  grainOpacity: 0.185,
  /** Veces por segundo que se reposiciona el grain. */
  grainHz: 8,
  /** Partículas de polvo dentro del haz. */
  dustCount: 380,
};

/*
  TEMPORAL — panel lil-gui para calibrar la proyección.
  Quitar ENABLE_DEBUG_GUI y el bloque mountDebugGui antes de la versión final.
*/
const ENABLE_DEBUG_GUI = true;
const LIL_GUI_URL = "https://cdn.jsdelivr.net/npm/lil-gui@0.19.2/+esm";
const WEAVE_BASE = { x: 0.65, y: 0.55, rot: 0.02 };

let debugGui = null;

// --- Estado compartido del arranque -----------------------------------------

const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
let reducedMotion = motionQuery.matches;
const instances = new Set();

function onMotionPreferenceChange(event) {
  reducedMotion = event.matches;
  instances.forEach((instance) => {
    if (reducedMotion) {
      resetParallax(instance);
      resetProjectionFx(instance);
    }
    syncLoop(instance);
  });
}

if (motionQuery.addEventListener) {
  motionQuery.addEventListener("change", onMotionPreferenceChange);
} else if (motionQuery.addListener) {
  motionQuery.addListener(onMotionPreferenceChange);
}

let elementorHooked = false;

// --- Arranque ---------------------------------------------------------------

function boot() {
  const nodes = document.querySelectorAll("[data-tm-hero]:not([data-tm-ready])");
  nodes.forEach((root) => {
    root.setAttribute("data-tm-ready", "");
    mount(root);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

/*
  Elementor puede inyectar el widget después de DOMContentLoaded
  (editor y, a veces, el front). El hook evita una segunda escena gracias
  a data-tm-ready.
*/
window.addEventListener("elementor/frontend/init", hookElementor);
hookElementor();

function hookElementor() {
  if (elementorHooked) return;
  const hooks = window.elementorFrontend && window.elementorFrontend.hooks;
  if (!hooks) return;
  elementorHooked = true;
  hooks.addAction("frontend/element_ready/html.default", boot);
}

// --- Montaje de una instancia -----------------------------------------------

function mount(root) {
  const stage = root.querySelector(".tm-hero__stage");
  const frame = root.querySelector("[data-tm-frame]") || stage;
  const fallback = root.querySelector(".tm-hero__fallback");
  const grain = root.querySelector("[data-tm-grain]");
  if (!stage || !fallback) return;

  const instance = {
    root,
    stage,
    frame,
    fallback,
    grain,
    disposed: false,
    started: false,
    visible: false,
    pageVisible: !document.hidden,
  };

  if (grain) {
    grain.style.backgroundImage = `url("${grainDataUrl()}")`;
  }

  const onVisibilityChange = () => {
    instance.pageVisible = !document.hidden;
    syncLoop(instance);
  };

  /*
    Dos observadores a propósito:
    - near: empieza a cargar un poco antes de entrar.
    - visible: el rAF solo corre cuando el escenario corta el viewport.
  */
  const near = new IntersectionObserver(
    (entries) => {
      if (entries[0] && entries[0].isIntersecting) {
        ensureExperience(instance);
      }
    },
    { root: null, rootMargin: PRELOAD_MARGIN, threshold: 0 }
  );

  const visibility = new IntersectionObserver(
    (entries) => {
      instance.visible = Boolean(entries[0] && entries[0].isIntersecting);
      syncLoop(instance);
    },
    { root: null, rootMargin: "0px", threshold: 0 }
  );

  near.observe(stage);
  visibility.observe(stage);
  instance.near = near;
  instance.visibility = visibility;
  instance.onVisibilityChange = onVisibilityChange;
  document.addEventListener("visibilitychange", onVisibilityChange);
  instances.add(instance);
}

/**
 * Crea la escena la primera vez que el hero se acerca al viewport.
 * Si WebGL no existe, muestra el fallback y no vuelve a intentarlo.
 */
async function ensureExperience(instance) {
  if (instance.started || instance.disposed) return;
  instance.started = true;

  if (!hasWebGL()) {
    showFallback(instance);
    return;
  }

  let THREE;
  try {
    THREE = await import(THREE_URL);
  } catch (error) {
    showFallback(instance);
    return;
  }

  if (instance.disposed || !instance.root.isConnected) return;

  try {
    createScene(instance, THREE);
  } catch (error) {
    showFallback(instance);
  }
}

// --- Escena, cámara y renderer ----------------------------------------------

function createScene(instance, THREE) {
  const { stage, frame } = instance;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 100);
  const cameraZ = distanceForVisibleHeight(VISIBLE_HEIGHT, CAMERA_FOV);
  camera.position.set(0, 0, cameraZ);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({
    antialias: window.innerWidth >= 768,
    alpha: false,
    powerPreference: "default",
  });
  renderer.setClearColor(0x000000, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(pixelRatio());
  renderer.domElement.className = "tm-hero__canvas";
  renderer.domElement.setAttribute("aria-hidden", "true");
  frame.appendChild(renderer.domElement);

  const planeHeight = VISIBLE_HEIGHT * LAYOUT.planeHeightRatio;
  const planeWidth = planeHeight * LAYOUT.planeAspect;
  const gap = planeWidth * LAYOUT.gapRatio;
  const slot = planeWidth + gap;

  instance.THREE = THREE;
  instance.scene = scene;
  instance.camera = camera;
  instance.cameraZ = cameraZ;
  instance.renderer = renderer;
  instance.planes = [];
  instance.slot = slot;
  instance.planeWidth = planeWidth;
  instance.scroll = 0;
  instance.running = false;
  instance.rafId = 0;
  instance.lastTime = 0;
  resetParallax(instance);
  resetProjectionFx(instance);
  bindParallax(instance);
  buildProjection(instance);

  resize(instance);

  const resizeObserver = new ResizeObserver(() => {
    if (instance.disposed) return;
    resize(instance);
    if (!instance.running) renderFrame(instance);
  });
  resizeObserver.observe(stage);
  instance.resizeObserver = resizeObserver;

  renderer.domElement.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    showFallback(instance);
  });

  loadStills(instance).then((textures) => {
    if (instance.disposed || !instance.root.isConnected) {
      textures.forEach((texture) => texture.dispose());
      return;
    }
    buildPlanes(instance, textures, planeWidth, planeHeight);
    layoutPlanes(instance);
    applyBeamOpacity(instance);
    applyGrainOpacity(instance);
    renderFrame(instance);
    applyProjectionFx(instance);
    instance.root.classList.add("is-ready");
    syncLoop(instance);
    if (ENABLE_DEBUG_GUI) mountDebugGui(instance);
  });
}

/**
 * Distancia de cámara para que el plano z = 0 cubra exactamente `height`
 * unidades de alto con el FOV dado.
 */
function distanceForVisibleHeight(height, fovDeg) {
  const halfFov = (fovDeg * Math.PI) / 180 / 2;
  return height / 2 / Math.tan(halfFov);
}

function pixelRatio() {
  const dpr = window.devicePixelRatio || 1;
  return Math.min(dpr, MAX_PIXEL_RATIO);
}

function resize(instance) {
  const { stage, camera, renderer } = instance;
  if (!renderer || !camera) return;

  const width = stage.clientWidth;
  const height = stage.clientHeight;
  if (width < 2 || height < 2) return;

  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(pixelRatio());
  renderer.setSize(width, height, false);
}

// --- Carga de imágenes (lazy) -----------------------------------------------

async function loadStills(instance) {
  const { THREE } = instance;
  const anisotropy = Math.min(4, instance.renderer.capabilities.getMaxAnisotropy());

  const textures = await Promise.all(
    STILLS.map((still, index) => loadStill(THREE, still, index, anisotropy))
  );

  return textures;
}

async function loadStill(THREE, still, index, anisotropy) {
  try {
    const image = await loadImage(resolveSrc(still.src));
    return textureFromImage(THREE, rasterize(image), anisotropy);
  } catch (error) {
    return createGeneratedTexture(THREE, index, anisotropy);
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.crossOrigin = "anonymous";
    image.onload = () => {
      if (image.decode) {
        image.decode().then(() => resolve(image)).catch(() => resolve(image));
        return;
      }
      resolve(image);
    };
    image.onerror = () => reject(new Error("No se pudo cargar " + src));
    image.src = src;
  });
}

function resolveSrc(src) {
  if (/^(https?:)?\/\//.test(src) || src.startsWith("data:") || src.startsWith("blob:")) {
    return src;
  }
  return new URL(src, import.meta.url).href;
}

function rasterize(image) {
  const width = image.naturalWidth || image.width || 1500;
  const height = image.naturalHeight || image.height || 1000;
  if (width < 2 || height < 2) {
    throw new Error("imagen sin tamaño");
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, width, height);
  return canvas;
}

function textureFromImage(THREE, image, anisotropy) {
  const texture = new THREE.Texture(image);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = anisotropy;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Si una URL falla, el hueco no se rompe: un campo de color distinto
 * ocupa el mismo plano hasta que se sustituya el archivo.
 */
function createGeneratedTexture(THREE, index, anisotropy) {
  const palettes = [
    ["#141820", "#3a2a22", "#c9854a"],
    ["#cbb89a", "#8a623c", "#2a211c"],
    ["#12110f", "#3c342c", "#d7c3a4"],
    ["#8ea0a8", "#1d313c", "#d5ddd8"],
    ["#8d928c", "#2c312e", "#d8d2c8"],
    ["#9aa3a0", "#4d5854", "#dfe3df"],
  ];
  const [top, bottom, accent] = palettes[index % palettes.length];
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 800;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, top);
  gradient.addColorStop(1, bottom);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = accent;
  ctx.fillRect(canvas.width * 0.62, canvas.height * 0.28, canvas.width * 0.08, canvas.height * 0.16);

  return textureFromImage(THREE, canvas, anisotropy);
}

// --- Planos ------------------------------------------------------------------

function buildPlanes(instance, textures, planeWidth, planeHeight) {
  const { THREE, scene } = instance;
  const geometry = new THREE.PlaneGeometry(planeWidth, planeHeight);

  textures.forEach((texture, index) => {
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.z = STILLS[index].depth;
    mesh.userData.depth = STILLS[index].depth;
    scene.add(mesh);
    instance.planes.push(mesh);
  });

  instance.geometry = geometry;
}

/**
 * Coloca los 6 planos en una tira y envuelve la coordenada X para que
 * el desplazamiento sea infinito. El salto ocurre fuera del encuadre.
 */
function layoutPlanes(instance) {
  const { planes, slot, scroll } = instance;
  const count = planes.length;
  if (!count) return;

  const strip = count * slot;

  for (let i = 0; i < count; i += 1) {
    let x = i * slot - scroll + strip / 2;
    x = ((x % strip) + strip) % strip;
    x -= strip / 2;
    planes[i].position.x = x;
    planes[i].position.z = planes[i].userData.depth;
  }
}

// --- Capa de proyección (haz + polvo en Three.js) ---------------------------

function buildProjection(instance) {
  const { THREE, scene } = instance;

  const beamTexture = new THREE.CanvasTexture(createBeamCanvas());
  beamTexture.colorSpace = THREE.SRGBColorSpace;
  beamTexture.needsUpdate = true;

  const beamMaterial = new THREE.MeshBasicMaterial({
    map: beamTexture,
    transparent: true,
    opacity: PROJECTION.beamOpacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
  });

  /*
    No es un cono de proyector: dos planos suaves, ligeramente inclinados,
    que sugieren un haz atravesando el volumen entre cámara y stills.
  */
  const beamGeometry = new THREE.PlaneGeometry(18, 11);
  const beamA = new THREE.Mesh(beamGeometry, beamMaterial);
  beamA.position.set(-0.6, 0.35, 2.4);
  beamA.rotation.set(-0.18, 0.42, -0.08);
  scene.add(beamA);

  const beamB = new THREE.Mesh(beamGeometry, beamMaterial.clone());
  beamB.material.opacity =
    PROJECTION.beamOpacity * PROJECTION.beamOpacitySecondaryRatio;
  beamB.position.set(0.4, -0.15, 1.2);
  beamB.rotation.set(0.12, -0.28, 0.05);
  scene.add(beamB);

  const dust = createDust(instance);
  scene.add(dust);

  instance.beamTexture = beamTexture;
  instance.beamGeometry = beamGeometry;
  instance.beamMaterials = [beamA.material, beamB.material];
  instance.beams = [beamA, beamB];
  instance.dust = dust;
}

function createBeamCanvas() {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

  const radial = ctx.createRadialGradient(
    size * 0.5,
    size * 0.42,
    size * 0.02,
    size * 0.5,
    size * 0.5,
    size * 0.52
  );
  radial.addColorStop(0, "rgba(255, 248, 236, 0.55)");
  radial.addColorStop(0.35, "rgba(255, 240, 220, 0.16)");
  radial.addColorStop(1, "rgba(255, 240, 220, 0)");
  ctx.fillStyle = radial;
  ctx.fillRect(0, 0, size, size);

  const falloff = ctx.createLinearGradient(0, 0, 0, size);
  falloff.addColorStop(0, "rgba(0, 0, 0, 0.55)");
  falloff.addColorStop(0.45, "rgba(0, 0, 0, 0)");
  falloff.addColorStop(1, "rgba(0, 0, 0, 0.4)");
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = falloff;
  ctx.fillRect(0, 0, size, size);

  return canvas;
}

function createDust(instance) {
  const { THREE } = instance;
  const count = PROJECTION.dustCount;
  const positions = new Float32Array(count * 3);
  const velocities = new Float32Array(count * 3);
  const phases = new Float32Array(count);

  for (let i = 0; i < count; i += 1) {
    seedDustParticle(positions, velocities, phases, i);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

  const material = new THREE.PointsMaterial({
    map: createDustSprite(THREE),
    size: 0.085,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
    toneMapped: false,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.userData.velocities = velocities;
  points.userData.phases = phases;
  instance.dustGeometry = geometry;
  instance.dustMaterial = material;
  return points;
}

function seedDustParticle(positions, velocities, phases, index) {
  const i = index * 3;
  /* Volumen alargado del haz: diagonal suave por el centro del encuadre. */
  const t = Math.random();
  positions[i] = (Math.random() - 0.5) * 7.5 + t * 1.4;
  positions[i + 1] = (Math.random() - 0.5) * 4.2 + 0.3 - t * 0.6;
  positions[i + 2] = 0.4 + Math.random() * 4.6;

  velocities[i] = (Math.random() - 0.5) * 0.08;
  velocities[i + 1] = 0.015 + Math.random() * 0.05;
  velocities[i + 2] = (Math.random() - 0.5) * 0.04;
  phases[index] = Math.random() * Math.PI * 2;
}

function createDustSprite(THREE) {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(255, 250, 240, 1)");
  gradient.addColorStop(0.35, "rgba(255, 245, 230, 0.45)");
  gradient.addColorStop(1, "rgba(255, 245, 230, 0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function updateDust(instance, dt, now) {
  const dust = instance.dust;
  if (!dust) return;

  const positions = dust.geometry.attributes.position.array;
  const velocities = dust.userData.velocities;
  const phases = dust.userData.phases;
  const count = phases.length;
  const time = now * 0.001;

  for (let i = 0; i < count; i += 1) {
    const p = i * 3;
    const sway = Math.sin(time * 0.7 + phases[i]) * 0.03;
    positions[p] += (velocities[p] + sway) * dt;
    positions[p + 1] += velocities[p + 1] * dt;
    positions[p + 2] += velocities[p + 2] * dt;

    if (
      positions[p + 1] > 3.2 ||
      positions[p] < -5 ||
      positions[p] > 5 ||
      positions[p + 2] < 0.2 ||
      positions[p + 2] > 5.4
    ) {
      seedDustParticle(positions, velocities, phases, i);
      positions[p + 1] = -2.4 + Math.random() * 0.6;
    }
  }

  dust.geometry.attributes.position.needsUpdate = true;
}

function applyBeamOpacity(instance) {
  if (!instance.beamMaterials) return;
  const primary = PROJECTION.beamOpacity;
  const secondary = primary * PROJECTION.beamOpacitySecondaryRatio;
  instance.beamMaterials[0].opacity = primary;
  if (instance.beamMaterials[1]) instance.beamMaterials[1].opacity = secondary;
}

function applyGrainOpacity(instance) {
  if (!instance.grain) return;
  instance.grain.style.opacity = String(PROJECTION.grainOpacity);
}

function applyWeaveAmount(amount) {
  const scale = amount / WEAVE_BASE.x;
  PROJECTION.weaveX = WEAVE_BASE.x * scale;
  PROJECTION.weaveY = WEAVE_BASE.y * scale;
  PROJECTION.weaveRot = WEAVE_BASE.rot * scale;
}

function rebuildDust(instance, count) {
  if (!instance.scene || !instance.THREE) return;

  const next = Math.max(0, Math.round(count));
  PROJECTION.dustCount = next;
  disposeDust(instance);
  if (next === 0) return;

  const dust = createDust(instance);
  instance.scene.add(dust);
  instance.dust = dust;
}

function disposeDust(instance) {
  if (!instance.dust) return;
  instance.scene?.remove(instance.dust);
  instance.dustMaterial?.map?.dispose();
  instance.dustMaterial?.dispose();
  instance.dustGeometry?.dispose();
  instance.dust = null;
  instance.dustMaterial = null;
  instance.dustGeometry = null;
}

// --- Debug GUI (TEMPORAL) ---------------------------------------------------

async function mountDebugGui(instance) {
  if (debugGui) return;

  let GUI;
  try {
    ({ GUI } = await import(LIL_GUI_URL));
  } catch (error) {
    console.warn("[tm-hero] No se pudo cargar lil-gui", error);
    return;
  }

  if (instance.disposed || debugGui) return;

  const params = {
    beamOpacity: PROJECTION.beamOpacity,
    flickerRange: PROJECTION.flickerMin,
    weaveAmount: PROJECTION.weaveX,
    grainOpacity: PROJECTION.grainOpacity,
    particleCount: PROJECTION.dustCount,
  };

  const gui = new GUI({ title: "Proyección (debug)" });
  gui.domElement.style.zIndex = "9999";
  debugGui = gui;

  gui
    .add(params, "beamOpacity", 0, 0.6, 0.005)
    .name("beamOpacity")
    .onChange((value) => {
      PROJECTION.beamOpacity = value;
      instances.forEach((item) => applyBeamOpacity(item));
    });

  gui
    .add(params, "flickerRange", 0.85, 1, 0.001)
    .name("flickerRange")
    .onChange((value) => {
      PROJECTION.flickerMin = Math.min(value, PROJECTION.flickerMax);
    });

  gui
    .add(params, "weaveAmount", 0, 4, 0.01)
    .name("weaveAmount")
    .onChange((value) => {
      applyWeaveAmount(value);
    });

  gui
    .add(params, "grainOpacity", 0, 0.5, 0.005)
    .name("grainOpacity")
    .onChange((value) => {
      PROJECTION.grainOpacity = value;
      instances.forEach((item) => applyGrainOpacity(item));
    });

  gui
    .add(params, "particleCount", 0, 400, 1)
    .name("particleCount")
    .onChange((value) => {
      instances.forEach((item) => rebuildDust(item, value));
    });

  gui
    .add(
      {
        reset() {
          params.beamOpacity = 0.14;
          params.flickerRange = 0.904;
          params.weaveAmount = WEAVE_BASE.x;
          params.grainOpacity = 0.12;
          params.particleCount = 96;
          PROJECTION.beamOpacity = params.beamOpacity;
          PROJECTION.flickerMin = params.flickerRange;
          applyWeaveAmount(params.weaveAmount);
          PROJECTION.grainOpacity = params.grainOpacity;
          instances.forEach((item) => {
            applyBeamOpacity(item);
            applyGrainOpacity(item);
            rebuildDust(item, params.particleCount);
          });
          gui.controllers.forEach((controller) => controller.updateDisplay());
        },
      },
      "reset"
    )
    .name("reset defaults");
}

// --- Parallax de mouse ------------------------------------------------------

function bindParallax(instance) {
  const { stage } = instance;

  const onPointerMove = (event) => {
    if (instance.disposed || reducedMotion || event.pointerType !== "mouse") return;

    const rect = stage.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;

    const nx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = ((event.clientY - rect.top) / rect.height) * 2 - 1;
    const angles = pointerToAngles(
      Math.max(-1, Math.min(1, nx)),
      Math.max(-1, Math.min(1, ny))
    );
    instance.targetYaw = angles.yaw;
    instance.targetPitch = angles.pitch;
  };

  const release = () => {
    instance.targetYaw = 0;
    instance.targetPitch = 0;
  };

  stage.addEventListener("pointermove", onPointerMove, { passive: true });
  stage.addEventListener("pointerleave", release);
  stage.addEventListener("pointercancel", release);

  instance.unbindParallax = () => {
    stage.removeEventListener("pointermove", onPointerMove);
    stage.removeEventListener("pointerleave", release);
    stage.removeEventListener("pointercancel", release);
  };
}

/**
 * nx, ny en -1..1 dentro del escenario.
 * El vector resultante se recorta para que el ángulo total no pase de 1°.
 */
function pointerToAngles(nx, ny) {
  const max = (MAX_PARALLAX_DEG * Math.PI) / 180;
  let yaw = nx * max;
  let pitch = -ny * max;
  const magnitude = Math.hypot(yaw, pitch);

  if (magnitude > max) {
    const scale = max / magnitude;
    yaw *= scale;
    pitch *= scale;
  }

  return { yaw, pitch };
}

function updateParallax(instance, dt) {
  if (reducedMotion) {
    resetParallax(instance);
    return;
  }

  const blend = 1 - Math.exp(-PARALLAX_RESPONSE * dt);
  instance.yaw += (instance.targetYaw - instance.yaw) * blend;
  instance.pitch += (instance.targetPitch - instance.pitch) * blend;
  clampParallax(instance);
}

function resetParallax(instance) {
  instance.yaw = 0;
  instance.pitch = 0;
  instance.targetYaw = 0;
  instance.targetPitch = 0;
}

function clampParallax(instance) {
  const max = (MAX_PARALLAX_DEG * Math.PI) / 180;
  const magnitude = Math.hypot(instance.yaw, instance.pitch);
  if (magnitude <= max) return;
  const scale = max / magnitude;
  instance.yaw *= scale;
  instance.pitch *= scale;
}

/**
 * En reposo mira al origen. El parallax desplaza el punto de mira,
 * no la posición: el encuadre no se descentra, solo se inclina.
 */
function applyCamera(instance) {
  const { camera, cameraZ } = instance;
  if (!camera || cameraZ == null) return;

  const yaw = instance.yaw || 0;
  const pitch = instance.pitch || 0;
  camera.position.set(0, 0, cameraZ);
  camera.lookAt(Math.sin(yaw) * cameraZ, Math.sin(pitch) * cameraZ, 0);
}

// --- Grain / flicker / gate weave (DOM) -------------------------------------

function grainDataUrl() {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(size, size);
  const data = image.data;

  for (let i = 0; i < data.length; i += 4) {
    const value = 90 + Math.random() * 90;
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  }

  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}

function resetProjectionFx(instance) {
  instance.flicker = 1;
  instance.targetFlicker = 1;
  instance.weaveX = 0;
  instance.weaveY = 0;
  instance.weaveRot = 0;
  instance.targetWeaveX = 0;
  instance.targetWeaveY = 0;
  instance.targetWeaveRot = 0;
  instance.grainClock = 0;
  applyProjectionFx(instance);
}

function updateProjectionFx(instance, dt) {
  if (reducedMotion) {
    resetProjectionFx(instance);
    return;
  }

  instance.grainClock = (instance.grainClock || 0) + dt;
  const grainInterval = 1 / PROJECTION.grainHz;
  if (instance.grain && instance.grainClock >= grainInterval) {
    instance.grainClock %= grainInterval;
    const x = Math.floor(Math.random() * 160);
    const y = Math.floor(Math.random() * 160);
    instance.grain.style.backgroundPosition = `${x}px ${y}px`;
  }

  if (Math.random() < dt * 1.8) {
    instance.targetFlicker =
      PROJECTION.flickerMin +
      Math.random() * (PROJECTION.flickerMax - PROJECTION.flickerMin);
  }

  if (Math.random() < dt * 2.2) {
    instance.targetWeaveX = (Math.random() * 2 - 1) * PROJECTION.weaveX;
    instance.targetWeaveY = (Math.random() * 2 - 1) * PROJECTION.weaveY;
    instance.targetWeaveRot = (Math.random() * 2 - 1) * PROJECTION.weaveRot;
  }

  const flickerBlend = 1 - Math.exp(-PROJECTION.flickerResponse * dt);
  const weaveBlend = 1 - Math.exp(-PROJECTION.weaveResponse * dt);
  instance.flicker += (instance.targetFlicker - instance.flicker) * flickerBlend;
  instance.weaveX += (instance.targetWeaveX - instance.weaveX) * weaveBlend;
  instance.weaveY += (instance.targetWeaveY - instance.weaveY) * weaveBlend;
  instance.weaveRot += (instance.targetWeaveRot - instance.weaveRot) * weaveBlend;

  applyProjectionFx(instance);
}

function applyProjectionFx(instance) {
  const { frame } = instance;
  if (!frame) return;

  const opacity = instance.flicker == null ? 1 : instance.flicker;
  const x = instance.weaveX || 0;
  const y = instance.weaveY || 0;
  const rot = instance.weaveRot || 0;
  frame.style.opacity = String(opacity);
  frame.style.transform = `translate3d(${x.toFixed(3)}px, ${y.toFixed(3)}px, 0) rotate(${rot.toFixed(4)}deg)`;
}

// --- Bucle de animación -----------------------------------------------------

function syncLoop(instance) {
  if (instance.disposed || !instance.renderer || !instance.planes.length) return;

  const shouldRun =
    !reducedMotion && instance.visible && instance.pageVisible && instance.root.isConnected;

  if (shouldRun) {
    startLoop(instance);
    return;
  }

  stopLoop(instance);

  /* Fuera de vista no se dibuja: el rAF ya está cancelado. */
  if (reducedMotion && instance.visible && instance.root.isConnected) {
    renderFrame(instance);
    applyProjectionFx(instance);
  }
}

function startLoop(instance) {
  if (instance.running) return;
  instance.running = true;
  instance.lastTime = performance.now();
  instance.rafId = requestAnimationFrame((now) => tick(instance, now));
}

function stopLoop(instance) {
  instance.running = false;
  if (instance.rafId) {
    cancelAnimationFrame(instance.rafId);
    instance.rafId = 0;
  }
}

function tick(instance, now) {
  if (!instance.running) return;

  if (!instance.root.isConnected) {
    dispose(instance);
    return;
  }

  const dt = Math.min((now - instance.lastTime) / 1000, 0.05);
  instance.lastTime = now;
  instance.scroll += LAYOUT.speed * dt;
  layoutPlanes(instance);
  updateParallax(instance, dt);
  updateDust(instance, dt, now);
  updateProjectionFx(instance, dt);

  renderFrame(instance);
  instance.rafId = requestAnimationFrame((time) => tick(instance, time));
}

function renderFrame(instance) {
  if (!instance.renderer || !instance.scene || !instance.camera) return;
  applyCamera(instance);
  instance.renderer.render(instance.scene, instance.camera);
}

// --- Fallback y soporte WebGL -----------------------------------------------

function hasWebGL() {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch (error) {
    return false;
  }
}

function showFallback(instance) {
  if (instance.disposed) return;
  stopLoop(instance);

  if (!instance.fallback.childElementCount) {
    const sources = STILLS.slice(0, 2);
    sources.forEach((still) => {
      const image = document.createElement("img");
      image.alt = still.alt;
      image.decoding = "async";
      image.loading = "lazy";
      image.src = resolveSrc(still.src);
      instance.fallback.appendChild(image);
    });
  }

  instance.root.classList.add("is-fallback");
  instance.root.classList.remove("is-ready");
  dispose(instance);
}

function dispose(instance) {
  if (instance.disposed) return;
  instance.disposed = true;
  instances.delete(instance);
  stopLoop(instance);

  if (instance.near) instance.near.disconnect();
  if (instance.visibility) instance.visibility.disconnect();
  if (instance.resizeObserver) instance.resizeObserver.disconnect();
  if (instance.onVisibilityChange) {
    document.removeEventListener("visibilitychange", instance.onVisibilityChange);
  }
  if (instance.unbindParallax) instance.unbindParallax();

  if (instance.planes) {
    instance.planes.forEach((mesh) => {
      mesh.material.map?.dispose();
      mesh.material.dispose();
    });
  }
  instance.geometry?.dispose();

  if (instance.beams) {
    instance.beamMaterials?.forEach((material) => material.dispose());
    instance.beamGeometry?.dispose();
    if (instance.beamTexture && instance.beamTexture.dispose) {
      instance.beamTexture.dispose();
    }
  }

  if (instance.dust) {
    disposeDust(instance);
  }

  instance.renderer?.dispose();
  instance.renderer?.domElement.remove();

  if (debugGui && instances.size === 0) {
    debugGui.destroy();
    debugGui = null;
  }
}
