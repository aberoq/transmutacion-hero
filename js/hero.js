/* =============================================================================
   Transmutación Hero — versión mínima
   -----------------------------------------------------------------------------
   Escena, cámara en perspectiva, loop infinito de 6 stills y parallax de mouse.
   Sin partículas, grain, viñeta, flicker ni gate weave.

   Sistema de coordenadas (unidades de mundo):
   - El alto visible en el plano z = 0 es VISIBLE_HEIGHT.
   - X crece a la derecha. Las imágenes viajan hacia −X.
   - Z positivo se acerca a la cámara. Cada still usa un valor entre
     -1.2 (lejos) y +0.3 (cerca).
   - La cámara es PerspectiveCamera con FOV estrecho: hay perspectiva,
     no gran angular. En reposo mira al origen.
   - El mouse inclina esa mirada como máximo 1°. En táctil no hay parallax.

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
    src: "../assets/stills/01-umbral.svg",
    alt: "Umbral: fachada nocturna y una sola ventana encendida",
    depth: -0.42,
  },
  {
    src: "../assets/stills/02-deriva.svg",
    alt: "Deriva: horizonte de duna y sol bajo",
    depth: 0.3,
  },
  {
    src: "../assets/stills/03-interior.svg",
    alt: "Interior: vano de luz sobre un muro oscuro",
    depth: -0.16,
  },
  {
    src: "../assets/stills/04-orilla.svg",
    alt: "Orilla: dos campos de agua y cielo",
    depth: 0.48,
  },
  {
    src: "../assets/stills/05-volumen.svg",
    alt: "Volumen: plano de hormigón y un filo de luz",
    depth: -0.34,
  },
  {
    src: "../assets/stills/06-claridad.svg",
    alt: "Claridad: verticales disueltas en niebla",
    depth: 0.14,
  },
];

const LAYOUT = {
  /** Alto del still respecto al alto visible. Deja margen negro arriba y abajo. */
  planeHeightRatio: 0.74,
  /** 3:2. Coincide con el viewBox de los placeholders. */
  planeAspect: 3 / 2,
  /** Separación entre stills, como fracción del ancho de cada plano. */
  gapRatio: 0.12,
  /**
   * Unidades de mundo por segundo.
   * Con el encuadre actual, un still tarda unos 20 s en ceder su lugar al siguiente.
   */
  speed: 0.62,
};

// --- Estado compartido del arranque -----------------------------------------

const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
let reducedMotion = motionQuery.matches;
const instances = new Set();

function onMotionPreferenceChange(event) {
  reducedMotion = event.matches;
  instances.forEach((instance) => syncLoop(instance));
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
  const fallback = root.querySelector(".tm-hero__fallback");
  if (!stage || !fallback) return;

  const instance = {
    root,
    stage,
    fallback,
    disposed: false,
    started: false,
    visible: false,
    pageVisible: !document.hidden,
  };

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
  const { stage } = instance;

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
  stage.appendChild(renderer.domElement);

  const planeHeight = VISIBLE_HEIGHT * LAYOUT.planeHeightRatio;
  const planeWidth = planeHeight * LAYOUT.planeAspect;
  const gap = planeWidth * LAYOUT.gapRatio;
  const slot = planeWidth + gap;

  instance.THREE = THREE;
  instance.scene = scene;
  instance.camera = camera;
  instance.renderer = renderer;
  instance.planes = [];
  instance.slot = slot;
  instance.scroll = 0;
  instance.running = false;
  instance.rafId = 0;
  instance.lastTime = 0;

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
    renderFrame(instance);
    instance.root.classList.add("is-ready");
    syncLoop(instance);
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

  /*
    Punto de extensión. En iteraciones siguientes, antes del render:
    parallax de mouse, polvo, grain, viñeta, flicker y gate weave.
  */

  renderFrame(instance);
  instance.rafId = requestAnimationFrame((time) => tick(instance, time));
}

function renderFrame(instance) {
  if (!instance.renderer || !instance.scene || !instance.camera) return;
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

  if (instance.planes) {
    instance.planes.forEach((mesh) => {
      mesh.material.map?.dispose();
      mesh.material.dispose();
    });
  }
  instance.geometry?.dispose();
  instance.renderer?.dispose();
  instance.renderer?.domElement.remove();
}
