'use strict';

/* =====================================================================
   Stick Flight — core engine (flight.js)
   Owns the Three.js scene/camera/renderer/sim and the window.Flight API.
   Three.js r128 UMD is already loaded (global THREE). Never touches
   localStorage or screen .hidden. Only renders to #scene + #hero-canvas
   and toggles the `is-flashing` class on #hit-flash.

   Calls window.StickFigure.build / applyEquip / applyTrail (defined by
   app.js) — but ONLY inside methods invoked at/after Flight.init, never
   at script-eval time.
   ===================================================================== */

(function () {

  /* ===================== Tunable constants (contract §H) ===================== */
  const TARGET_DIST   = 2600;
  const RUN_GRACE_S   = 6;
  const SPEED_MIN     = 38;
  const SPEED_MAX     = 78;
  const LATERAL_RANGE = 18;
  const VERTICAL_MIN  = 4;
  const VERTICAL_MAX  = 40;
  const STEER_LERP    = 0.18;
  const DRAG_RADIUS   = 110;
  const KEY_RAMP_S    = 0.12;
  const LEVEL_EASE_S  = 0.25;
  const SAFE_GAP      = 6;
  const MAX_ENEMIES   = 14;
  const ENEMY_TELEGRAPH_S = 1.2;
  const SPAWN_Z       = -500;
  const PLANE_RADIUS  = 2.2;
  const JET_RADIUS    = 1.8;
  const BOMBER_RADIUS = 2.6;
  const NEARMISS_BAND = 5.0;
  const HITSTOP_MS    = 120;
  const PARTICLE_COUNT= 180;
  const DEBRIS_COUNT  = 24;
  const GRAVITY       = -22;
  const RAGDOLL_DAMP  = 0.985;
  const RAGDOLL_ITERS = 6;
  const RAGDOLL_SETTLE_S = 2.5;

  /* ===================== Palette (contract §G) ===================== */
  const SKY_BLUE = 0x2b7fff;
  const CITY_COLORS = [0x9aa3ad, 0x6d7b8a, 0x3fb6a8, 0xd9b38c, 0x6fa8dc, 0xc98a5e];
  const GROUND_COLOR = 0xcdb38a;
  const PLANE_BODY = 0xee5544;
  const PLANE_ACCENT = 0xf4f4f4;
  const JET_BODY = 0x44505a;
  const JET_NOSE = 0xff3b30;
  const BOMBER_BODY = 0x4a5a2a;
  const BOMBER_ACCENT = 0x37414a;
  const PART_ORANGE = 0xff8a1a;
  const DEBRIS_COLOR = 0x808890;

  /* ===================== World/play bounds ===================== */
  const PLAY_X_MIN = -18, PLAY_X_MAX = 18;
  const PLAY_Y_MIN = 4,   PLAY_Y_MAX = 40;
  const CRUISE_Y   = 18;            // neutral vertical altitude (plane start + menu hover)
  const MAX_LAT_SPEED  = 26;        // §5 feel cap (u/s) on lateral plane move
  const MAX_VERT_SPEED = 16;        // §5 feel cap (u/s) on vertical plane move
  const RECYCLE_Z  = 24;            // recycle enemies / city past camera
  const ARCH_FADE_PROGRESS = 0.80;  // arch fades in
  const ARCH_WIDTH = 44;

  /* ===================== State machine ===================== */
  const ST = {
    MENU: 'MENU', COUNTDOWN: 'COUNTDOWN', GRACE: 'GRACE',
    FLYING: 'FLYING', EXPLODING: 'EXPLODING', RAGDOLL: 'RAGDOLL', ENDED: 'ENDED'
  };

  /* ===================== Scratch objects (no per-frame new) ===================== */
  const UP = new THREE.Vector3(0, 1, 0);
  const _v1 = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _v3 = new THREE.Vector3();
  const _q1 = new THREE.Quaternion();
  const _camTarget = new THREE.Vector3();
  const _camLook = new THREE.Vector3();
  const _scratchOff = new THREE.Vector3();

  /* ===================== Module-level engine refs ===================== */
  let sceneCanvas = null, heroCanvas = null;
  let renderer = null, scene = null, camera = null, camRig = null;
  let isCoarse = false;
  let raf = 0, lastNow = 0;
  let inited = false;

  // game-world refs
  let planeRig = null;      // group holding plane mesh; world scrolls toward +Z
  let planeMesh = null;     // visual plane (for banking + hide-on-explode)
  let blobShadow = null;
  let ground = null;
  let arch = null, archMat = null, archBanner = null;
  let cockpitAnchor = null; // where the figure rig sits during flight

  // figure rig (shared across cockpit / ragdoll). Built from StickFigure.
  let rig = null;
  let currentEquip = null;

  // pools
  let cityPool = [];        // {mesh, baseZ}
  let enemyPool = [];       // {group, type, radius, alive, x0, vy, wobAmp, wobFreq, wobPhase, minDist, nearReported, vz}
  let particleCloud = null, particlePos = null, particleVel = null, particleLife = null, particleMat = null, particleActive = 0;
  let debrisPool = [];      // {mesh, vx,vy,vz, rx,ry,rz, bounced, active}

  // shared geometries / materials (≤6 city materials, reused everywhere)
  let cityMats = [];
  let limbGeo = null;       // shared thin cylinder for ragdoll limbs (engine-owned reorient)

  // input
  const heldKeys = new Set();
  const input = { x: 0, y: 0 };           // unified -1..1
  let dragOrigin = null;                  // {x,y} | null  (exposed as Flight.dragOrigin)
  let pointerId = null;                   // first pointer only
  const targetOffset = { x: 0, y: 0 };    // eased plane offset target

  // sim/time
  let state = ST.MENU;
  let timeScale = 1;
  let pausedExternally = false;
  let elapsed = 0;          // seconds since GO (sim time, scaled)
  let distance = 0;
  let worldSpeed = SPEED_MIN;
  let progress = 0;
  let nearMisses = 0;
  let runResultFired = false;

  // countdown
  let countdownSteps = [];
  let countdownIdx = 0;
  let countdownTimer = 0;

  // explosion / camera shake
  let hitstopTimer = 0;     // ms remaining of full freeze
  let bulletEase = 1;       // eases timeScale back toward 1
  let bulletTimer = 0;
  let shakeAmp = 0;
  let explodeTimer = 0;     // schedules the boom one frame after hitstop
  let pendingExplode = false;
  let camPullBack = 0;      // 0..1 lerp factor for wide framing
  let flashEl = null;

  // ragdoll
  let ragPoints = [];       // [{pos:Vec3, prev:Vec3, pinned:bool}] order = POINT_NAMES
  let ragConstraints = [];  // [{a,b,len,active}]
  let capePoints = [];      // 3-pt chain off chest (if equipped)
  let capeConstraints = [];
  let ragSettleTimer = 0;
  let hatSevered = false;
  let useRigidFallback = false;
  let rigidFall = null;     // {pos, vel, spin}

  // spawn scheduling
  let nextSpawnAt = 0;      // sim-time of next pattern
  let archSpawned = false;

  // callbacks
  let cbProgress = null, cbWin = null, cbCrash = null;

  // hero scene (separate tiny renderer)
  let heroRenderer = null, heroScene = null, heroCam = null, heroRig = null;
  let heroRaf = 0, heroLast = 0, heroSpin = 0;
  let heroBob = 0;

  /* =====================================================================
     INIT
     ===================================================================== */
  function init(opts) {
    if (inited) return;
    sceneCanvas = opts.sceneCanvas;
    heroCanvas = opts.heroCanvas;
    flashEl = document.getElementById('hit-flash');
    isCoarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);

    renderer = new THREE.WebGLRenderer({
      canvas: sceneCanvas,
      antialias: !isCoarse,
      powerPreference: 'high-performance'
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(SKY_BLUE, 1);

    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(SKY_BLUE, 120, 540);

    // camera in a chase rig
    camera = new THREE.PerspectiveCamera(70, 1, 0.5, 600);
    camRig = new THREE.Object3D();
    scene.add(camRig);
    camera.position.set(0, 3.2, 11);
    camRig.add(camera);

    // lights — exactly two, no shadows
    const hemi = new THREE.HemisphereLight(0xaee2ff, 0xd9b38c, 0.9);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.7);
    dir.position.set(-6, 20, 8);
    scene.add(dir);

    buildSharedMaterials();
    buildGround();
    buildCity();
    buildPlane();
    buildBlobShadow();
    buildArch();
    buildParticles();
    buildDebris();

    sizeRenderer();
    window.addEventListener('resize', sizeRenderer);
    document.addEventListener('visibilitychange', onVisibility);

    attachInputListeners();

    inited = true;
    state = ST.MENU;
    parkCameraMenu();
    startLoop();
  }

  function sizeRenderer() {
    if (!renderer) return;
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function onVisibility() {
    if (document.hidden) pause();
    else resume();
  }

  /* =====================================================================
     SHARED MATERIALS / GEOMETRY
     ===================================================================== */
  function buildSharedMaterials() {
    cityMats = CITY_COLORS.map(c => new THREE.MeshLambertMaterial({ color: c }));
    limbGeo = new THREE.CylinderGeometry(0.09, 0.09, 1, 6);
    limbGeo.translate(0, 0.5, 0); // pivot at base so scale.y = length grows from a->b origin
  }

  /* =====================================================================
     GROUND
     ===================================================================== */
  function buildGround() {
    const g = new THREE.PlaneGeometry(600, 1400);
    const m = new THREE.MeshLambertMaterial({ color: GROUND_COLOR });
    ground = new THREE.Mesh(g, m);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, 0, -200);
    scene.add(ground);
  }

  /* =====================================================================
     POOLED LOW-POLY CITY (recycling)
     Two rows of buildings flanking the canyon; recycled toward +Z.
     ===================================================================== */
  const CITY_SPACING = 26;     // z spacing per building (per side)
  const CITY_COUNT_SIDE = 26;  // buildings per side
  const CITY_FAR_Z = SPAWN_Z;  // farthest building z
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);

  function buildCity() {
    const total = CITY_COUNT_SIDE * 2;
    for (let i = 0; i < total; i++) {
      const mat = cityMats[i % cityMats.length];
      const mesh = new THREE.Mesh(boxGeo, mat);
      scene.add(mesh);
      cityPool.push({ mesh });
    }
    layoutCity();
  }

  function layoutCity() {
    // spread evenly across the z range, alternating sides
    let idx = 0;
    for (let i = 0; i < CITY_COUNT_SIDE; i++) {
      const z = CITY_FAR_Z + i * CITY_SPACING;
      placeBuilding(cityPool[idx++], -1, z);
      placeBuilding(cityPool[idx++], 1, z);
    }
  }

  function placeBuilding(b, side, z) {
    const h = 8 + Math.random() * 46;
    const w = 6 + Math.random() * 10;
    const d = 6 + Math.random() * 10;
    const lane = 24 + Math.random() * 30; // distance from canyon center
    b.mesh.scale.set(w, h, d);
    b.mesh.position.set(side * lane, h / 2, z);
    b.h = h;
  }

  function recycleCity() {
    // farthest existing z, so recycled buildings tile behind the pack
    for (const b of cityPool) {
      if (b.mesh.position.z > RECYCLE_Z + 40) {
        // find farthest (most negative) z to place behind
        let minZ = Infinity;
        for (const o of cityPool) if (o.mesh.position.z < minZ) minZ = o.mesh.position.z;
        placeBuilding(b, b.mesh.position.x < 0 ? -1 : 1, minZ - CITY_SPACING);
      }
    }
  }

  /* =====================================================================
     PLANE (chunky low-poly) + visual banking
     ===================================================================== */
  function buildPlane() {
    planeRig = new THREE.Object3D();
    planeRig.position.set(0, 18, 0);
    scene.add(planeRig);

    planeMesh = new THREE.Object3D(); // bankable visual subgroup
    planeRig.add(planeMesh);

    const bodyMat = new THREE.MeshLambertMaterial({ color: PLANE_BODY });
    const accentMat = new THREE.MeshLambertMaterial({ color: PLANE_ACCENT });

    // fuselage
    const fus = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.2, 4.4), bodyMat);
    planeMesh.add(fus);
    // nose
    const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.7, 1.6, 8), bodyMat);
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, 0, -2.7);
    planeMesh.add(nose);
    // wings
    const wing = new THREE.Mesh(new THREE.BoxGeometry(7.2, 0.25, 1.5), accentMat);
    wing.position.set(0, -0.1, 0.2);
    planeMesh.add(wing);
    // tail fin
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.25, 1.4, 1.2), accentMat);
    fin.position.set(0, 0.8, 1.9);
    planeMesh.add(fin);
    // tail wings
    const tw = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.2, 0.9), accentMat);
    tw.position.set(0, 0.2, 2.0);
    planeMesh.add(tw);
    // cockpit canopy (clear-ish)
    const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.7, 10, 8), accentMat);
    canopy.scale.set(1, 0.8, 1.3);
    canopy.position.set(0, 0.7, -0.4);
    planeMesh.add(canopy);

    // cockpit anchor — the seated figure sits just above/behind canopy
    cockpitAnchor = new THREE.Object3D();
    cockpitAnchor.position.set(0, 0.9, 0.2);
    planeMesh.add(cockpitAnchor);

    // exhaust trail — a separate small Points cloud behind the plane
    buildTrail();
  }

  /* ----- exhaust trail (its own small Points cloud) ----- */
  let trailCloud = null, trailPos = null, trailLife = null, trailMat = null;
  const TRAIL_COUNT = 60;
  let trailEmitAcc = 0;

  function buildTrail() {
    const geo = new THREE.BufferGeometry();
    trailPos = new Float32Array(TRAIL_COUNT * 3);
    trailLife = new Float32Array(TRAIL_COUNT); // 0 = dead
    geo.setAttribute('position', new THREE.Float32BufferAttribute(trailPos, 3));
    trailMat = new THREE.PointsMaterial({
      color: 0xffffff, size: 1.6, transparent: true, opacity: 0.85,
      depthWrite: false, sizeAttenuation: true
    });
    trailCloud = new THREE.Points(geo, trailMat);
    trailCloud.frustumCulled = false;
    scene.add(trailCloud);
    for (let i = 0; i < TRAIL_COUNT; i++) {
      trailPos[i * 3 + 1] = -9999;
      trailLife[i] = 0;
    }
    geo.attributes.position.needsUpdate = true;
  }

  function applyTrailConfig(equip) {
    if (!window.StickFigure || !window.StickFigure.applyTrail) return;
    const t = window.StickFigure.applyTrail(equip);
    if (t && typeof t.color === 'number') trailMat.color.setHex(t.color);
  }

  function updateTrail(dt) {
    // emit from behind the plane while flying
    const emitting = (state === ST.GRACE || state === ST.FLYING);
    trailEmitAcc += dt;
    const emitInterval = 0.02;
    let toEmit = 0;
    if (emitting) {
      while (trailEmitAcc >= emitInterval) { trailEmitAcc -= emitInterval; toEmit++; }
    } else {
      trailEmitAcc = 0;
    }
    const px = planeRig.position.x, py = planeRig.position.y, pz = planeRig.position.z + 2.4;
    for (let i = 0; i < TRAIL_COUNT; i++) {
      if (trailLife[i] > 0) {
        trailLife[i] -= dt;
        // drift backward (toward +Z) and settle
        trailPos[i * 3 + 2] += worldSpeed * dt * 0.35;
        if (trailLife[i] <= 0) trailPos[i * 3 + 1] = -9999;
      } else if (toEmit > 0) {
        toEmit--;
        trailPos[i * 3]     = px + (Math.random() - 0.5) * 0.6;
        trailPos[i * 3 + 1] = py - 0.3 + (Math.random() - 0.5) * 0.4;
        trailPos[i * 3 + 2] = pz + (Math.random() - 0.5) * 0.4;
        trailLife[i] = 0.5 + Math.random() * 0.3;
      }
    }
    trailCloud.geometry.attributes.position.needsUpdate = true;
    trailCloud.visible = emitting || hasLiveTrail();
  }

  function hasLiveTrail() {
    for (let i = 0; i < TRAIL_COUNT; i++) if (trailLife[i] > 0) return true;
    return false;
  }

  function hideTrail() {
    for (let i = 0; i < TRAIL_COUNT; i++) { trailLife[i] = 0; trailPos[i * 3 + 1] = -9999; }
    trailCloud.geometry.attributes.position.needsUpdate = true;
    trailCloud.visible = false;
  }

  /* =====================================================================
     BLOB SHADOW (flat dark ring) follows plane x/z at y≈0.02
     ===================================================================== */
  function buildBlobShadow() {
    const g = new THREE.CircleGeometry(2.6, 18);
    const m = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25 });
    blobShadow = new THREE.Mesh(g, m);
    blobShadow.rotation.x = -Math.PI / 2;
    blobShadow.position.set(0, 0.02, 0);
    scene.add(blobShadow);
  }

  /* =====================================================================
     FINISH ARCH (two pillars + chequered banner) — fades in via fog
     ===================================================================== */
  function buildArch() {
    arch = new THREE.Object3D();
    arch.visible = false;
    scene.add(arch);

    const pillarMat = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 1 });
    archMat = pillarMat;
    const half = ARCH_WIDTH / 2;
    const pillarGeo = new THREE.BoxGeometry(3, 46, 3);
    const lp = new THREE.Mesh(pillarGeo, pillarMat);
    lp.position.set(-half, 23, 0);
    arch.add(lp);
    const rp = new THREE.Mesh(pillarGeo, pillarMat);
    rp.position.set(half, 23, 0);
    arch.add(rp);

    // chequered banner across the top — a canvas texture
    const tex = makeCheckerTexture();
    const bannerMat = new THREE.MeshLambertMaterial({ map: tex, transparent: true, opacity: 1 });
    archBanner = bannerMat;
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(ARCH_WIDTH + 6, 8), bannerMat);
    banner.position.set(0, 42, 0);
    arch.add(banner);

    // top crossbar
    const bar = new THREE.Mesh(new THREE.BoxGeometry(ARCH_WIDTH + 6, 1.6, 2), pillarMat);
    bar.position.set(0, 46, 0);
    arch.add(bar);
  }

  function makeCheckerTexture() {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const ctx = c.getContext('2d');
    const cols = 16, rows = 4;
    const cw = c.width / cols, ch = c.height / rows;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        ctx.fillStyle = (x + y) % 2 === 0 ? '#111' : '#fff';
        ctx.fillRect(x * cw, y * ch, cw, ch);
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.NearestFilter;
    return tex;
  }

  /* =====================================================================
     SHARED PARTICLE CLOUD (explosion + near-miss sparks)
     ===================================================================== */
  function buildParticles() {
    const geo = new THREE.BufferGeometry();
    particlePos = new Float32Array(PARTICLE_COUNT * 3);
    particleVel = new Float32Array(PARTICLE_COUNT * 3);
    particleLife = new Float32Array(PARTICLE_COUNT); // seconds remaining; 0 = dead
    geo.setAttribute('position', new THREE.Float32BufferAttribute(particlePos, 3));
    particleMat = new THREE.PointsMaterial({
      color: PART_ORANGE, size: 2.4, transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
    });
    particleCloud = new THREE.Points(geo, particleMat);
    particleCloud.frustumCulled = false;
    particleCloud.visible = false;
    scene.add(particleCloud);
    for (let i = 0; i < PARTICLE_COUNT; i++) particlePos[i * 3 + 1] = -9999;
    geo.attributes.position.needsUpdate = true;
  }

  // emit n particles from (x,y,z); speedMin/Max outward
  function emitParticles(n, x, y, z, speedMin, speedMax, color) {
    if (color != null) particleMat.color.setHex(color);
    particleCloud.visible = true;
    let emitted = 0;
    for (let i = 0; i < PARTICLE_COUNT && emitted < n; i++) {
      if (particleLife[i] > 0) continue;
      const sp = speedMin + Math.random() * (speedMax - speedMin);
      // random outward direction
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const dx = Math.sin(phi) * Math.cos(theta);
      const dy = Math.cos(phi);
      const dz = Math.sin(phi) * Math.sin(theta);
      particleVel[i * 3]     = dx * sp;
      particleVel[i * 3 + 1] = dy * sp + 4;
      particleVel[i * 3 + 2] = dz * sp;
      particlePos[i * 3]     = x;
      particlePos[i * 3 + 1] = y;
      particlePos[i * 3 + 2] = z;
      particleLife[i] = 0.9;
      emitted++;
      particleActive++;
    }
    particleCloud.geometry.attributes.position.needsUpdate = true;
  }

  function updateParticles(dt) {
    if (!particleCloud.visible) return;
    let live = 0;
    let maxLife = 0;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      if (particleLife[i] <= 0) continue;
      particleLife[i] -= dt;
      if (particleLife[i] <= 0) {
        particlePos[i * 3 + 1] = -9999;
        continue;
      }
      live++;
      if (particleLife[i] > maxLife) maxLife = particleLife[i];
      particleVel[i * 3 + 1] += GRAVITY * 0.35 * dt;
      particlePos[i * 3]     += particleVel[i * 3] * dt;
      particlePos[i * 3 + 1] += particleVel[i * 3 + 1] * dt;
      particlePos[i * 3 + 2] += particleVel[i * 3 + 2] * dt;
    }
    particleMat.opacity = Math.max(0, Math.min(1, maxLife / 0.9));
    particleCloud.geometry.attributes.position.needsUpdate = true;
    if (live === 0) { particleCloud.visible = false; particleActive = 0; }
  }

  /* =====================================================================
     DEBRIS POOL (24 tiny grey boxes, 3 shared materials)
     ===================================================================== */
  let debrisMats = [];
  function buildDebris() {
    debrisMats = [
      new THREE.MeshLambertMaterial({ color: DEBRIS_COLOR }),
      new THREE.MeshLambertMaterial({ color: 0x6a727a }),
      new THREE.MeshLambertMaterial({ color: 0x9aa3ad }),
    ];
    const g = new THREE.BoxGeometry(0.5, 0.5, 0.5);
    for (let i = 0; i < DEBRIS_COUNT; i++) {
      const mesh = new THREE.Mesh(g, debrisMats[i % debrisMats.length]);
      mesh.visible = false;
      scene.add(mesh);
      debrisPool.push({ mesh, vx: 0, vy: 0, vz: 0, rx: 0, ry: 0, rz: 0, bounced: false, active: false });
    }
  }

  function spawnDebris(x, y, z) {
    for (const d of debrisPool) {
      d.active = true;
      d.bounced = false;
      d.mesh.visible = true;
      const s = 0.4 + Math.random() * 0.8;
      d.mesh.scale.set(s, s, s);
      d.mesh.position.set(x, y, z);
      d.vx = (Math.random() - 0.5) * 18;
      d.vy = 6 + Math.random() * 14;
      d.vz = (Math.random() - 0.5) * 16;
      d.rx = (Math.random() - 0.5) * 12;
      d.ry = (Math.random() - 0.5) * 12;
      d.rz = (Math.random() - 0.5) * 12;
    }
  }

  function updateDebris(dt) {
    for (const d of debrisPool) {
      if (!d.active) continue;
      d.vy += GRAVITY * dt;
      d.mesh.position.x += d.vx * dt;
      d.mesh.position.y += d.vy * dt;
      d.mesh.position.z += (d.vz + worldSpeed) * dt; // ride the world scroll
      d.mesh.rotation.x += d.rx * dt;
      d.mesh.rotation.y += d.ry * dt;
      d.mesh.rotation.z += d.rz * dt;
      if (d.mesh.position.y < 0.25) {
        d.mesh.position.y = 0.25;
        if (!d.bounced) {
          d.vy *= -0.4; d.vx *= 0.7; d.vz *= 0.7;
          d.bounced = true;
        } else {
          d.vy = 0; d.vx *= 0.9; d.vz *= 0.9;
          if (Math.abs(d.vx) < 0.3 && Math.abs(d.vz) < 0.3) {
            // settle (stay visible but stop)
            d.vx = 0; d.vz = 0;
          }
        }
      }
      if (d.mesh.position.z > RECYCLE_Z + 30) { d.active = false; d.mesh.visible = false; }
    }
  }

  function hideDebris() {
    for (const d of debrisPool) { d.active = false; d.mesh.visible = false; }
  }

  /* =====================================================================
     ENEMY POOL + meshes
     ===================================================================== */
  function makeJet() {
    const g = new THREE.Object3D();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, 4.2),
      new THREE.MeshLambertMaterial({ color: JET_BODY }));
    g.add(body);
    const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.45, 1.4, 8),
      new THREE.MeshLambertMaterial({ color: JET_NOSE }));
    nose.rotation.x = -Math.PI / 2;        // nose points toward camera (+Z)
    nose.position.set(0, 0, 2.6);
    g.add(nose);
    const wingMat = new THREE.MeshLambertMaterial({ color: 0x556b2f });
    const wings = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.18, 1.0), wingMat);
    wings.position.set(0, 0, -0.4);
    g.add(wings);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.0, 0.9), wingMat);
    fin.position.set(0, 0.6, -1.6);
    g.add(fin);
    return g;
  }

  function makeBomber() {
    const g = new THREE.Object3D();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.4, 5.0),
      new THREE.MeshLambertMaterial({ color: BOMBER_BODY }));
    g.add(body);
    const accentMat = new THREE.MeshLambertMaterial({ color: BOMBER_ACCENT });
    const wings = new THREE.Mesh(new THREE.BoxGeometry(9.0, 0.4, 1.8), accentMat);
    g.add(wings);
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.9, 8, 6),
      new THREE.MeshLambertMaterial({ color: BOMBER_BODY }));
    nose.scale.set(1, 1, 1.4);
    nose.position.set(0, 0, 3.0);
    g.add(nose);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.6, 1.4), accentMat);
    fin.position.set(0, 0.9, -2.0);
    g.add(fin);
    // engine pods
    for (const sx of [-2.6, 2.6]) {
      const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 1.6, 6), accentMat);
      pod.rotation.x = Math.PI / 2;
      pod.position.set(sx, -0.3, 0);
      g.add(pod);
    }
    return g;
  }

  function buildEnemyPool() {
    // pool holds both kinds; we attach a fresh mesh on spawn matching type.
    for (let i = 0; i < MAX_ENEMIES; i++) {
      enemyPool.push({
        group: null, type: null, radius: 0, alive: false,
        x0: 0, vy: 0, wobAmp: 0, wobFreq: 0, wobPhase: 0,
        minDist: Infinity, nearReported: false
      });
    }
  }

  let jetTemplate = null, bomberTemplate = null;
  function getEnemyMesh(type) {
    // we clone shared geometry-bearing templates so materials are reused per template
    if (type === 'jet') {
      if (!jetTemplate) jetTemplate = makeJet();
      return jetTemplate.clone();
    } else {
      if (!bomberTemplate) bomberTemplate = makeBomber();
      return bomberTemplate.clone();
    }
  }

  function freeEnemySlot() {
    for (const e of enemyPool) if (!e.alive) return e;
    return null;
  }

  function spawnEnemy(type, x, y) {
    const e = freeEnemySlot();
    if (!e) return null;
    // (re)build mesh of correct type if needed
    if (e.type !== type || !e.group) {
      if (e.group) { scene.remove(e.group); }
      e.group = getEnemyMesh(type);
      scene.add(e.group);
      e.type = type;
    }
    e.radius = type === 'jet' ? JET_RADIUS : BOMBER_RADIUS;
    e.alive = true;
    e.group.visible = true;
    e.x0 = x;
    e.group.position.set(x, y, SPAWN_Z);
    e.vy = 0;
    e.wobAmp = Math.random() < 0.5 ? 0 : (1 + Math.random() * 3); // ≤4
    e.wobFreq = 0.3 + Math.random() * 0.5;                         // ≤0.8Hz
    e.wobPhase = Math.random() * Math.PI * 2;
    e.minDist = Infinity;
    e.nearReported = false;
    e.scaleBase = type === 'jet' ? 1.0 : 1.0;
    return e;
  }

  function recycleEnemy(e) {
    e.alive = false;
    if (e.group) e.group.visible = false;
  }

  function hideAllEnemies() {
    for (const e of enemyPool) recycleEnemy(e);
  }

  /* ----- gap validation: ensure a continuous SAFE_GAP hole remains ----- */
  // Validate the union of enemy x-spans in the playfield leaves a contiguous
  // horizontal hole >= SAFE_GAP. If not, nudge the supplied (newest) enemy.
  function validateGap(newE) {
    // Gather live enemies near the spawn plane (treat all pending as same slice).
    const spans = [];
    for (const e of enemyPool) {
      if (!e.alive) continue;
      const r = e.radius + PLANE_RADIUS;
      spans.push([e.x0 - r, e.x0 + r]);
    }
    if (!hasGap(spans)) {
      // nudge newE laterally to open a gap; try a few candidate x positions
      const candidates = [-14, 14, -10, 10, -6, 6, 0];
      for (const cx of candidates) {
        const trial = spans.slice();
        const r = newE.radius + PLANE_RADIUS;
        // replace newE's span
        trial[trial.length - 1] = [cx - r, cx + r];
        if (hasGap(trial)) {
          newE.x0 = cx;
          newE.group.position.x = cx;
          return;
        }
      }
      // last resort: push it to the far edge
      newE.x0 = PLAY_X_MAX - 1;
      newE.group.position.x = newE.x0;
    }
  }

  // does the union of blocked x-spans leave a contiguous hole >= SAFE_GAP
  // within [PLAY_X_MIN, PLAY_X_MAX]?
  function hasGap(spans) {
    if (spans.length === 0) return true;
    const sorted = spans.slice().sort((a, b) => a[0] - b[0]);
    let cursor = PLAY_X_MIN;
    for (const [s, e] of sorted) {
      if (s > cursor) {
        if (s - cursor >= SAFE_GAP) return true;
        cursor = Math.max(cursor, e);
      } else {
        cursor = Math.max(cursor, e);
      }
      if (cursor >= PLAY_X_MAX) break;
    }
    if (PLAY_X_MAX - cursor >= SAFE_GAP) return true;
    return false;
  }

  /* =====================================================================
     AUTHORED SPAWN PATTERNS (phase-keyed)
     A pattern is a set of {type,x,y,delay}. The engine spawns each after
     its delay (telegraph handled by fog distance). Gap validated as it goes.
     ===================================================================== */
  function pickPattern(t) {
    const rx = () => -12 + Math.random() * 24; // lane-ish x
    if (t < 25) {
      // single enemies, generous gaps
      const type = Math.random() < 0.6 ? 'jet' : 'bomber';
      return { spawns: [{ type, x: rx(), y: midY(), delay: 0 }], gap: 3.0 };
    } else if (t < 55) {
      // pairs forcing a lane / weave
      if (Math.random() < 0.5) {
        // high + low forcing a vertical lane: place at left and right but
        // staggered to force a weave
        const lx = -10 - Math.random() * 6;
        const rxr = 10 + Math.random() * 6;
        return {
          spawns: [
            { type: Math.random() < 0.5 ? 'jet' : 'bomber', x: lx, y: lowY(), delay: 0 },
            { type: Math.random() < 0.5 ? 'jet' : 'bomber', x: rxr, y: highY(), delay: 0.4 }
          ], gap: 2.4
        };
      } else {
        // left + right forcing center gap
        const off = 9 + Math.random() * 4;
        return {
          spawns: [
            { type: 'jet', x: -off, y: midY(), delay: 0 },
            { type: 'jet', x: off, y: midY(), delay: 0 }
          ], gap: 2.2
        };
      }
    } else if (t < 72) {
      // 3-enemy diagonal staircase with a clear ride-through lane
      const dir = Math.random() < 0.5 ? 1 : -1;
      const baseY = 10;
      return {
        spawns: [
          { type: 'jet', x: dir * -10, y: baseY, delay: 0 },
          { type: 'jet', x: 0, y: baseY + 10, delay: 0.45 },
          { type: 'bomber', x: dir * 10, y: baseY + 20, delay: 0.9 }
        ], gap: 2.6
      };
    }
    return null; // 72s+ : stop spawning
  }

  function midY() { return 14 + Math.random() * 12; }
  function lowY() { return 7 + Math.random() * 6; }
  function highY() { return 26 + Math.random() * 10; }

  // a small queue of staggered spawns (pattern delays)
  let spawnQueue = []; // {type,x,y,at}

  function scheduleNextPattern(t) {
    const p = pickPattern(t);
    if (!p) { nextSpawnAt = Infinity; return; }
    for (const s of p.spawns) {
      spawnQueue.push({ type: s.type, x: s.x, y: s.y, at: t + (s.delay || 0) });
    }
    // gap before the next pattern, tightens with phase
    nextSpawnAt = t + p.gap;
  }

  function processSpawnQueue(t) {
    for (let i = spawnQueue.length - 1; i >= 0; i--) {
      if (t >= spawnQueue[i].at) {
        const s = spawnQueue[i];
        const e = spawnEnemy(s.type, s.x, s.y);
        if (e) validateGap(e);
        spawnQueue.splice(i, 1);
      }
    }
  }

  /* =====================================================================
     RAGDOLL RIG (built from StickFigure rig anchors)
     ===================================================================== */
  function ensureRig() {
    if (rig) return;
    if (!window.StickFigure || !window.StickFigure.build) return;
    rig = window.StickFigure.build(currentEquip || defaultEquip(), THREE);
    scene.add(rig.group);
    rig.group.visible = false; // hidden until a run seats it in the cockpit
    buildRagFromRig();
  }

  function defaultEquip() {
    return { hat: 'none', colour: 'blue', cape: 'none', trail: 'white' };
  }

  // Build the 9 verlet points + 8 constraints from StickFigure.REST rest lengths.
  function buildRagFromRig() {
    const SF = window.StickFigure;
    const names = SF.POINT_NAMES;
    const REST = SF.REST || {};
    ragPoints = [];
    for (let i = 0; i < names.length; i++) {
      ragPoints.push({ pos: new THREE.Vector3(), prev: new THREE.Vector3(), pinned: false });
    }
    // constraint pairs (by index) per contract §A
    const pairs = [
      [0, 1], [1, 2], [2, 3], [2, 4], [2, 5], [3, 6], [3, 7], [0, 8]
    ];
    ragConstraints = pairs.map(([a, b]) => ({ a, b, len: restLen(REST, names, a, b), active: true }));

    // cape chain (3-pt) off chest, if rig provides capePoints
    capePoints = [];
    capeConstraints = [];
    if (rig.capePoints && rig.capePoints.length) {
      for (let i = 0; i < rig.capePoints.length; i++) {
        capePoints.push({ pos: new THREE.Vector3(), prev: new THREE.Vector3(), pinned: i === 0 });
      }
      for (let i = 0; i < capePoints.length - 1; i++) {
        capeConstraints.push({ a: i, b: i + 1, len: 0.5, active: true });
      }
    }
  }

  function restLen(REST, names, ai, bi) {
    // prefer explicit rest length list if provided, else compute from seated pose
    const seated = REST.seated || REST.idle || {};
    const pa = seated[names[ai]] || { x: 0, y: 0, z: 0 };
    const pb = seated[names[bi]] || { x: 0, y: 0, z: 0 };
    const dx = pa.x - pb.x, dy = pa.y - pb.y, dz = pa.z - pb.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return d > 1e-4 ? d : 0.4;
  }

  // place rag points into a pose (seated / idle) in local space then transform to world
  function poseFromRest(poseKey, originX, originY, originZ) {
    const SF = window.StickFigure;
    const names = SF.POINT_NAMES;
    const pose = (SF.REST && SF.REST[poseKey]) || {};
    for (let i = 0; i < names.length; i++) {
      const p = pose[names[i]] || { x: 0, y: 0, z: 0 };
      ragPoints[i].pos.set(originX + p.x, originY + p.y, originZ + p.z);
      ragPoints[i].prev.copy(ragPoints[i].pos);
    }
  }

  // drive the figure meshes (cylinders + head + hat) from current rag point world positions
  function applyRigFromPoints() {
    if (!rig) return;
    const limbs = rig.limbMeshes || [];
    // constraint i drives limbMeshes[i]
    for (let i = 0; i < ragConstraints.length && i < limbs.length; i++) {
      const c = ragConstraints[i];
      const m = limbs[i];
      if (!m) continue;
      if (!c.active) { m.visible = false; continue; }
      m.visible = true;
      const a = ragPoints[c.a].pos, b = ragPoints[c.b].pos;
      _v1.copy(a);
      _v2.subVectors(b, a);
      const len = _v2.length();
      m.position.copy(_v1);
      if (len > 1e-5) {
        _v3.copy(_v2).normalize();
        m.quaternion.setFromUnitVectors(UP, _v3);
        m.scale.set(1, len, 1);
      }
    }
    // head sphere at point[0]
    if (rig.headMesh) rig.headMesh.position.copy(ragPoints[0].pos);
    // hat parented to head point (point[8]) unless severed
    if (rig.hatMesh) {
      rig.hatMesh.visible = true;
      rig.hatMesh.position.copy(ragPoints[8].pos);
      // orient hat along head->hat
      _v2.subVectors(ragPoints[8].pos, ragPoints[0].pos);
      if (_v2.length() > 1e-4) {
        _v3.copy(_v2).normalize();
        rig.hatMesh.quaternion.setFromUnitVectors(UP, _v3);
      }
    }
    // rounded joint spheres (neck/chest/hip/hands/feet) follow their points
    if (rig.jointMeshes) {
      for (const j of rig.jointMeshes) {
        if (j.mesh && ragPoints[j.i]) j.mesh.position.copy(ragPoints[j.i].pos);
      }
    }
    // cape ribbon
    if (rig.capeMesh && capePoints.length) {
      applyCapeMesh();
    }
  }

  // Scratch points for the static (non-ragdoll) cape drape. The cape mesh's
  // geometry is authored in the SAME coordinate space the limb points use, and
  // the mesh itself stays at the group origin (identity) — so we must NOT also
  // translate/rotate the mesh (that double-transforms it). Instead we rewrite
  // the ribbon geometry each frame from a 3-point chain that hangs off the
  // figure's actual chest and trails down-and-back past the hip.
  const _capeS0 = { pos: { x: 0, y: 0, z: 0 } };
  const _capeS1 = { pos: { x: 0, y: 0, z: 0 } };
  const _capeS2 = { pos: { x: 0, y: 0, z: 0 } };
  const _capeStaticPts = [_capeS0, _capeS1, _capeS2];

  function applyCapeMesh() {
    if (!rig.capeMesh) return;
    // keep the mesh at the group origin — its geometry carries absolute coords
    rig.capeMesh.position.set(0, 0, 0);
    rig.capeMesh.quaternion.set(0, 0, 0, 1);
    const rewrite = rig.capeMesh.userData && rig.capeMesh.userData.rewrite;
    if (!rewrite) return;
    if (state === ST.RAGDOLL && capePoints.length >= 3) {
      // dynamic: flail from the solved Verlet chain
      rewrite(capePoints);
    } else {
      // static drape from chest down-and-back toward (and below) the hip
      const chest = ragPoints[2].pos, hip = ragPoints[3].pos;
      _capeS0.pos.x = chest.x;                    _capeS0.pos.y = chest.y;                    _capeS0.pos.z = chest.z - 0.10;
      _capeS1.pos.x = (chest.x + hip.x) * 0.5;    _capeS1.pos.y = (chest.y + hip.y) * 0.5;    _capeS1.pos.z = (chest.z + hip.z) * 0.5 - 0.28;
      _capeS2.pos.x = hip.x;                      _capeS2.pos.y = hip.y - 0.34;               _capeS2.pos.z = hip.z - 0.46;
      rewrite(_capeStaticPts);
    }
  }

  /* ----- Verlet step for ragdoll ----- */
  function ragdollStep(dt) {
    const dt2 = dt * dt;
    const MAXV = 2.5; // clamp per-step displacement magnitude
    for (const p of ragPoints) {
      if (p.pinned) { p.prev.copy(p.pos); continue; }
      _v1.subVectors(p.pos, p.prev); // velocity*dt
      if (_v1.length() > MAXV) _v1.setLength(MAXV);
      p.prev.copy(p.pos);
      p.pos.x += _v1.x * RAGDOLL_DAMP;
      p.pos.y += _v1.y * RAGDOLL_DAMP + GRAVITY * dt2;
      p.pos.z += _v1.z * RAGDOLL_DAMP;
    }
    for (let iter = 0; iter < RAGDOLL_ITERS; iter++) {
      for (const c of ragConstraints) {
        if (!c.active) continue;
        solveConstraint(ragPoints, c);
      }
    }
    // ground bounce
    for (const p of ragPoints) {
      if (p.pinned) continue;
      if (p.pos.y < 0) {
        const vy = p.pos.y - p.prev.y; // implied vertical vel
        p.pos.y = 0;
        p.prev.y = p.pos.y + vy * 0.4;       // reflect ×0.4 (bounce)
        // horizontal friction ×0.7
        p.prev.x = p.pos.x - (p.pos.x - p.prev.x) * 0.7;
        p.prev.z = p.pos.z - (p.pos.z - p.prev.z) * 0.7;
      }
    }
    // cape chain solve
    if (capePoints.length) {
      capePoints[0].pos.copy(ragPoints[2].pos); // pin to chest
      capePoints[0].prev.copy(capePoints[0].pos);
      for (let i = 1; i < capePoints.length; i++) {
        const p = capePoints[i];
        _v1.subVectors(p.pos, p.prev);
        if (_v1.length() > MAXV) _v1.setLength(MAXV);
        p.prev.copy(p.pos);
        p.pos.x += _v1.x * RAGDOLL_DAMP;
        p.pos.y += _v1.y * RAGDOLL_DAMP + GRAVITY * dt2 * 0.5;
        p.pos.z += _v1.z * RAGDOLL_DAMP;
      }
      for (let iter = 0; iter < RAGDOLL_ITERS; iter++) {
        for (const c of capeConstraints) solveConstraint(capePoints, c);
      }
      for (let i = 1; i < capePoints.length; i++) {
        if (capePoints[i].pos.y < 0) capePoints[i].pos.y = 0;
      }
    }
  }

  function solveConstraint(pts, c) {
    const a = pts[c.a], b = pts[c.b];
    _v1.subVectors(b.pos, a.pos);
    const dist = _v1.length();
    if (dist < 1e-5) return; // skip degenerate
    const diff = (dist - c.len) / dist;
    const ax = _v1.x * 0.5 * diff;
    const ay = _v1.y * 0.5 * diff;
    const az = _v1.z * 0.5 * diff;
    if (!a.pinned) { a.pos.x += ax; a.pos.y += ay; a.pos.z += az; }
    if (!b.pinned) { b.pos.x -= ax; b.pos.y -= ay; b.pos.z -= az; }
  }

  function startRagdoll(impactPos, planeVel) {
    // detach rig from cockpit into world space at the plane position
    if (!rig) return;
    if (rig.group.parent !== scene) {
      scene.add(rig.group); // ensure world-space
    }
    rig.group.position.set(0, 0, 0);
    rig.group.quaternion.identity();
    rig.group.scale.set(1, 1, 1);

    // seed pose around impact point (use seated pose as starting shape)
    poseFromRest('seated', impactPos.x, impactPos.y, impactPos.z);

    // launch impulse: planeVel + outward blast through hip + up-kick + per-point tumble
    const blastUp = 9;
    const outX = (Math.random() - 0.5) * 12; // rand±6
    const outZ = (Math.random() - 0.5) * 4;  // rand±2
    for (let i = 0; i < ragPoints.length; i++) {
      const p = ragPoints[i];
      _scratchOff.set(
        planeVel.x + outX + (Math.random() - 0.5) * 6,
        planeVel.y + blastUp + (Math.random() - 0.5) * 4,
        planeVel.z + outZ + (Math.random() - 0.5) * 6
      );
      // prev = pos - launchVel*dt (use a nominal dt of 1/60)
      const ndt = 1 / 60;
      p.prev.set(
        p.pos.x - _scratchOff.x * ndt,
        p.pos.y - _scratchOff.y * ndt,
        p.pos.z - _scratchOff.z * ndt
      );
      p.pinned = false;
    }

    // cape chain seed (hang off chest)
    if (capePoints.length) {
      const chest = ragPoints[2].pos;
      for (let i = 0; i < capePoints.length; i++) {
        capePoints[i].pos.set(chest.x, chest.y - i * 0.5, chest.z + 0.2 + i * 0.2);
        capePoints[i].prev.copy(capePoints[i].pos);
      }
      capePoints[0].pinned = true;
    }

    // hat severing on a hard crash — delete head-hat constraint
    hatSevered = true;
    for (const c of ragConstraints) {
      if (c.a === 0 && c.b === 8) c.active = false;
    }
    // give the hat its own little launch (point 8)
    if (rig.hatMesh) {
      const hp = ragPoints[8];
      const hndt = 1 / 60;
      hp.prev.set(
        hp.pos.x - (planeVel.x + (Math.random() - 0.5) * 10) * hndt,
        hp.pos.y - (planeVel.y + 14) * hndt,
        hp.pos.z - (planeVel.z + (Math.random() - 0.5) * 10) * hndt
      );
    }

    useRigidFallback = false;
    rigidFall = null;
    applyRigFromPoints();
  }

  /* =====================================================================
     FIGURE POSING — cockpit (seated) during flight
     ===================================================================== */
  function seatFigureInCockpit() {
    if (!rig) return;
    // parent the rig group to cockpit anchor and drive points to seated pose
    if (rig.group.parent !== cockpitAnchor) {
      cockpitAnchor.add(rig.group);
    }
    rig.group.position.set(0, 0, 0);
    rig.group.quaternion.identity();
    // seated pose is local to the rig group (which is parented to cockpit)
    const SF = window.StickFigure;
    const names = SF.POINT_NAMES;
    const pose = (SF.REST && SF.REST.seated) || {};
    for (let i = 0; i < names.length; i++) {
      const p = pose[names[i]] || { x: 0, y: 0, z: 0 };
      ragPoints[i].pos.set(p.x, p.y, p.z);
      ragPoints[i].prev.copy(ragPoints[i].pos);
      ragPoints[i].pinned = false;
    }
    // restore severed hat constraint
    for (const c of ragConstraints) c.active = true;
    hatSevered = false;
    applyRigFromPoints();
  }

  function hideFigure() {
    if (rig) rig.group.visible = false;
  }
  function showFigure() {
    if (rig) rig.group.visible = true;
  }

  /* =====================================================================
     INPUT — unified vector from pointer + keyboard + mouse
     ===================================================================== */
  function attachInputListeners() {
    const c = sceneCanvas;
    c.style.touchAction = 'none';

    c.addEventListener('pointerdown', (e) => {
      if (pointerId !== null) return; // first pointer only
      pointerId = e.pointerId;
      dragOrigin = { x: e.clientX, y: e.clientY };
      Flight.dragOrigin = dragOrigin;
      e.preventDefault();
    }, { passive: false });

    c.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pointerId || !dragOrigin) return;
      input.x = clamp((e.clientX - dragOrigin.x) / DRAG_RADIUS, -1, 1);
      input.y = clamp((dragOrigin.y - e.clientY) / DRAG_RADIUS, -1, 1); // drag up = nose up
      e.preventDefault();
    }, { passive: false });

    const release = (e) => {
      if (e.pointerId !== pointerId) return;
      pointerId = null;
      dragOrigin = null;
      Flight.dragOrigin = null;
      // input eases back to 0 in the loop via key/level ease
    };
    c.addEventListener('pointerup', release);
    c.addEventListener('pointercancel', release);
    c.addEventListener('pointerleave', (e) => { if (e.pointerId === pointerId) release(e); });

    // keyboard (held set) — only steering keys here; menus owned by app.js
    window.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd'].includes(k)) {
        heldKeys.add(k);
        if (state === ST.GRACE || state === ST.FLYING) e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => {
      heldKeys.delete(e.key.toLowerCase());
    });
    window.addEventListener('blur', () => heldKeys.clear());
  }

  function updateInput(dt) {
    // keyboard contribution toward a target, ramping over KEY_RAMP_S
    let kx = 0, ky = 0;
    if (heldKeys.has('arrowleft') || heldKeys.has('a')) kx -= 1;
    if (heldKeys.has('arrowright') || heldKeys.has('d')) kx += 1;
    if (heldKeys.has('arrowup') || heldKeys.has('w')) ky += 1;
    if (heldKeys.has('arrowdown') || heldKeys.has('s')) ky -= 1;

    // When the pointer is active, pointermove already wrote input.x/y directly.
    // Keyboard otherwise ramps held axes toward ±1 over KEY_RAMP_S; released
    // axes self-level back to 0 over LEVEL_EASE_S (§5).
    if (dragOrigin === null) {
      const kRate = dt / KEY_RAMP_S;
      const lRate = dt / LEVEL_EASE_S;
      input.x = approach(input.x, kx, kx !== 0 ? kRate : lRate);
      input.y = approach(input.y, ky, ky !== 0 ? kRate : lRate);
    }
  }

  function approach(cur, target, rate) {
    rate = clamp(rate, 0, 1);
    return cur + (target - cur) * rate;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /* =====================================================================
     CAMERA
     ===================================================================== */
  function parkCameraMenu() {
    camRig.position.set(0, 18, 0);
    camera.position.set(0, 3.2, 11);
    camera.lookAt(0, 18, -14);
  }

  function updateCamera(dt, framePull) {
    // chase rig follows plane rig x/y, z stays ~0
    _camTarget.set(planeRig.position.x * 0.6, planeRig.position.y, 0);
    camRig.position.lerp(_camTarget, 0.12);

    // pull back on explosion
    const baseZ = 11, baseY = 3.2;
    const pz = baseZ + framePull * 9;
    const py = baseY + framePull * 5;
    camera.position.x += (0 - camera.position.x) * 0.1;
    camera.position.y += (py - camera.position.y) * 0.1;
    camera.position.z += (pz - camera.position.z) * 0.1;

    // look ~14 ahead of plane
    _camLook.set(planeRig.position.x * 0.4, planeRig.position.y, -14);
    if (framePull > 0.01) {
      // during fall, frame the ragdoll/ground
      _camLook.set(planeRig.position.x * 0.3, 6, -6);
    }
    camera.lookAt(_camLook.x + camRig.position.x, _camLook.y, _camLook.z);

    // screen shake — decaying random offset
    if (shakeAmp > 0.001) {
      camera.position.x += (Math.random() - 0.5) * shakeAmp;
      camera.position.y += (Math.random() - 0.5) * shakeAmp;
      shakeAmp *= 0.9;
      shakeAmp -= dt * 0; // decay handled by mult; floor below
      if (shakeAmp < 0.02) shakeAmp = 0;
    }
  }

  /* =====================================================================
     EXPLOSION / HIT-FLASH
     ===================================================================== */
  function triggerExplosion() {
    if (state === ST.EXPLODING || state === ST.RAGDOLL || state === ST.ENDED) return;
    state = ST.EXPLODING;
    hitstopTimer = HITSTOP_MS;
    timeScale = 0;
    bulletEase = 0;
    bulletTimer = 0;
    pendingExplode = true;  // start the ragdoll one frame after hit-stop ends
    explodeTimer = 0;
    // a light impact buzz (not an explosion)
    if (navigator.vibrate) { try { navigator.vibrate(35); } catch (e) {} }
  }

  // The plane does NOT explode — on impact the stick figure is thrown clear and
  // ragdolls to the ground. No fireball, no debris, no orange flash: just a
  // small camera bump and the tumble.
  function doBoom() {
    pendingExplode = false;
    // hide the plane + its trail (the figure carries on as a ragdoll)
    if (planeMesh) planeMesh.visible = false;
    hideTrail();
    // clear the enemies so the frozen plane we hit doesn't block the view —
    // the falling ragdoll should be the only thing on screen
    hideAllEnemies();
    // a gentle impact bump — enough to feel the hit, not an explosion
    shakeAmp = 0.35;
    // camera pulls back to frame the fall
    camPullBack = 1;

    // launch the ragdoll from the plane's position. A gentle toss INTO the
    // scene (-z, toward the camera's look-at point) + the up-kick in
    // startRagdoll keeps the figure in frame so you actually watch it tumble
    // to the ground (the full plane speed in +z would rocket it past the
    // camera and out of view).
    const p = planeRig.position;
    _v1.set(0, 0, -6);
    showFigure();
    startRagdoll(p, _v1);
    state = ST.RAGDOLL;
    ragSettleTimer = 0;
  }

  /* =====================================================================
     WIN
     ===================================================================== */
  function triggerWin() {
    if (runResultFired) return;
    state = ST.ENDED;
    // brief slow-mo + victory wiggle handled by timeScale & plane bank
    timeScale = 0.45;
    bulletEase = 1; // will ease back via winEase
    fireWin();
  }

  /* =====================================================================
     RUN RESULT + CALLBACKS
     ===================================================================== */
  function buildRunResult(won) {
    return { won: !!won, distance: Math.floor(distance), nearMisses: nearMisses };
  }

  function fireWin() {
    if (runResultFired) return;
    runResultFired = true;
    if (cbWin) cbWin(buildRunResult(true));
  }

  function fireCrash() {
    if (runResultFired) return;
    runResultFired = true;
    if (cbCrash) cbCrash(buildRunResult(false));
  }

  /* =====================================================================
     MAIN LOOP
     ===================================================================== */
  function startLoop() {
    if (raf) return;
    lastNow = performance.now();
    const tick = (now) => {
      raf = requestAnimationFrame(tick);
      if (pausedExternally) { lastNow = now; return; }
      let dt = (now - lastNow) / 1000;
      lastNow = now;
      // clamp to [0, 1/30]: never advance on a backwards clock (guards against
      // distance/elapsed ever going negative), and cap big catch-up steps.
      dt = Math.max(0, Math.min(dt, 1 / 30));
      stepFrame(dt);
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(tick);
  }

  function stepFrame(realDt) {
    // ---- timeScale management (hit-stop + bullet-time) ----
    if (state === ST.EXPLODING || state === ST.RAGDOLL) {
      if (hitstopTimer > 0) {
        hitstopTimer -= realDt * 1000;
        timeScale = 0;
        if (hitstopTimer <= 0) {
          timeScale = 0.35;
          bulletEase = 0;
          if (pendingExplode) doBoom();
        }
      } else {
        // ease 0.35 -> 1.0 over ~400ms
        bulletEase = Math.min(1, bulletEase + realDt / 0.4);
        timeScale = 0.35 + (1.0 - 0.35) * bulletEase;
      }
    } else if (state === ST.ENDED && timeScale < 1) {
      timeScale = Math.min(1, timeScale + realDt / 0.6);
    } else if (state !== ST.EXPLODING && state !== ST.RAGDOLL) {
      timeScale = 1;
    }

    const dt = realDt * timeScale;

    switch (state) {
      case ST.MENU:        stepMenu(realDt); break;
      case ST.COUNTDOWN:   stepCountdown(realDt); break;
      case ST.GRACE:
      case ST.FLYING:      stepFlying(dt, realDt); break;
      case ST.EXPLODING:   stepExploding(dt, realDt); break;
      case ST.RAGDOLL:     stepRagdoll(dt, realDt); break;
      case ST.ENDED:       stepEnded(dt, realDt); break;
    }

    // always-on visuals. Particles use the scaled dt so the fireball reads in
    // slow-mo during bullet-time; camera shake decays on real time.
    updateParticles(dt);
    updateCamera(realDt, camPullBack);
  }

  /* ----- MENU: gentle idle, slow drift of world for life ----- */
  function stepMenu(realDt) {
    // keep plane bobbing gently at menu
    planeRig.position.y = 18 + Math.sin(performance.now() * 0.0012) * 0.6;
    planeMesh.rotation.z = Math.sin(performance.now() * 0.0009) * 0.06;
    blobShadow.position.set(planeRig.position.x, 0.02, 0);
    updateTrail(realDt);
  }

  /* ----- COUNTDOWN: hold plane, run 3-2-1-GO steps ----- */
  function stepCountdown(realDt) {
    countdownTimer -= realDt;
    if (countdownTimer <= 0) {
      countdownIdx++;
      if (countdownIdx >= countdownSteps.length) {
        // GO! — clear the overlay as flying begins (app.js owns that DOM)
        if (cbProgress) cbProgress({ progress: 0, distance: 0, nearMiss: false, milestone: null, countdown: null });
        beginFlying();
        return;
      }
      countdownTimer = 0.65;
      emitCountdownStep();
    }
    // gentle hover
    planeRig.position.y += (18 - planeRig.position.y) * 0.1;
    planeRig.position.x += (0 - planeRig.position.x) * 0.1;
    blobShadow.position.set(planeRig.position.x, 0.02, 0);
    updateTrail(realDt);
  }

  function emitCountdownStep() {
    // app.js owns #countdown-overlay; the engine only reports the current
    // step text. The 'go' milestone fires in lock-step with the GO frame
    // (last step), keeping it aligned with app.js's GO toast/SFX timing.
    if (!cbProgress) return;
    const milestone = countdownIdx === countdownSteps.length - 1 ? 'go' : null;
    cbProgress({ progress: 0, distance: 0, nearMiss: false, milestone, countdown: countdownSteps[countdownIdx] });
  }

  function beginFlying() {
    state = ST.GRACE;
    elapsed = 0;
    distance = 0;
    nearMisses = 0;
    progress = 0;
    worldSpeed = SPEED_MIN;
    spawnQueue = [];
    nextSpawnAt = RUN_GRACE_S; // first pattern after grace
    archSpawned = false;
    arch.visible = false;
    camPullBack = 0;
    hideAllEnemies();
    hideDebris();
    seatFigureInCockpit();
    showFigure();
    if (planeMesh) planeMesh.visible = true;
  }

  /* ----- FLYING / GRACE ----- */
  let lastMilestone = null;
  function stepFlying(dt, realDt) {
    elapsed += dt;
    // grace -> flying transition
    if (state === ST.GRACE && elapsed >= RUN_GRACE_S) {
      state = ST.FLYING;
    }

    // difficulty & distance
    progress = clamp(distance / TARGET_DIST, 0, 1);
    worldSpeed = SPEED_MIN + (SPEED_MAX - SPEED_MIN) * progress;
    distance += worldSpeed * dt;
    progress = clamp(distance / TARGET_DIST, 0, 1);

    // steering — input -1..1 maps to a target world position, eased per frame.
    // Vertical neutral is the cruise altitude (where the plane begins); on
    // release input self-levels to 0 so the plane forgivingly returns to cruise.
    updateInput(realDt);
    targetOffset.x = input.x * LATERAL_RANGE;
    targetOffset.y = input.y >= 0
      ? CRUISE_Y + input.y * (VERTICAL_MAX - CRUISE_Y)
      : CRUISE_Y + input.y * (CRUISE_Y - VERTICAL_MIN);
    targetOffset.y = clamp(targetOffset.y, VERTICAL_MIN, VERTICAL_MAX);
    // plane eases toward target offset, with the move capped to the §5 max
    // velocities (~26 u/s lateral, ~16 u/s vertical) so big swings stay tuned.
    let mvx = (targetOffset.x - planeRig.position.x) * STEER_LERP;
    let mvy = (targetOffset.y - planeRig.position.y) * STEER_LERP;
    const maxX = MAX_LAT_SPEED * realDt, maxY = MAX_VERT_SPEED * realDt;
    mvx = clamp(mvx, -maxX, maxX);
    mvy = clamp(mvy, -maxY, maxY);
    planeRig.position.x += mvx;
    planeRig.position.y += mvy;
    planeRig.position.x = clamp(planeRig.position.x, PLAY_X_MIN, PLAY_X_MAX);
    planeRig.position.y = clamp(planeRig.position.y, VERTICAL_MIN, VERTICAL_MAX);

    // banking (visual juice)
    planeMesh.rotation.z += ((-input.x * 0.6) - planeMesh.rotation.z) * 0.18;
    planeMesh.rotation.x += ((-input.y * 0.4) - planeMesh.rotation.x) * 0.18;

    // blob shadow follows
    blobShadow.position.set(planeRig.position.x, 0.02, 0);
    const h = planeRig.position.y;
    const sc = clamp(1.4 - h / 60, 0.4, 1.4);
    blobShadow.scale.set(sc, sc, sc);
    blobShadow.material.opacity = clamp(0.28 - h / 220, 0.05, 0.28);

    // world scroll: city + ground + enemies move toward +Z by worldSpeed*dt
    scrollWorld(dt);

    // spawning (only after grace, before 72s)
    const enemiesAllowed = (state === ST.FLYING) && elapsed > RUN_GRACE_S + 0.6 && elapsed < 72 && progress < ARCH_FADE_PROGRESS + 0.18;
    if (enemiesAllowed) {
      if (elapsed >= nextSpawnAt && spawnQueue.length === 0) scheduleNextPattern(elapsed);
      processSpawnQueue(elapsed);
    }
    updateEnemies(dt);

    // arch fade-in + finish
    updateArch(dt);

    // trail
    updateTrail(dt);

    // milestones + progress callback (every frame)
    let milestone = null;
    if (progress >= 0.5 && lastMilestone !== 'halfway' && lastMilestone !== 'almost') { milestone = 'halfway'; lastMilestone = 'halfway'; }
    if (progress >= 0.8 && lastMilestone !== 'almost') { milestone = 'almost'; lastMilestone = 'almost'; }
    if (cbProgress) {
      cbProgress({ progress, distance: Math.floor(distance), nearMiss: frameNearMiss, milestone });
    }
    frameNearMiss = false;

    // WIN
    if (distance >= TARGET_DIST && !runResultFired) {
      triggerWin();
    }
  }

  let frameNearMiss = false;

  function scrollWorld(dt) {
    const dz = worldSpeed * dt;
    // city
    for (const b of cityPool) b.mesh.position.z += dz;
    recycleCity();
    // ground stays (large plane); subtle scroll of texture not needed
  }

  /* ----- ENEMIES update + collision + near-miss ----- */
  function updateEnemies(dt) {
    const px = planeRig.position.x, py = planeRig.position.y, pz = planeRig.position.z;
    for (const e of enemyPool) {
      if (!e.alive) continue;
      // move toward +Z at worldSpeed + closing bonus
      const closing = worldSpeed * 0.55 + 8;
      e.group.position.z += (worldSpeed + closing) * dt;
      // gentle X-only sine wobble
      if (e.wobAmp > 0) {
        e.group.position.x = e.x0 + Math.sin((elapsed * e.wobFreq * Math.PI * 2) + e.wobPhase) * e.wobAmp;
      }
      // fog-dim via scale-up as it nears (visual telegraph) — grow from small
      const zt = clamp((e.group.position.z - SPAWN_Z) / (RECYCLE_Z - SPAWN_Z), 0, 1);
      const sc = 0.5 + zt * 0.5;
      e.group.scale.set(sc, sc, sc);
      e.group.rotation.z = Math.sin(elapsed * 1.5 + e.wobPhase) * 0.08;

      // distance to plane (3D)
      _v1.set(e.group.position.x - px, e.group.position.y - py, e.group.position.z - pz);
      const d = _v1.length();
      if (d < e.minDist) e.minDist = d;

      const hitR = e.radius + PLANE_RADIUS;
      if (d < hitR && state === ST.FLYING) {
        // collision!
        triggerExplosion();
        return;
      }

      // near-miss: closest approach < band & > hit, detected once when passing
      if (!e.nearReported && e.group.position.z > pz + 1 && d > hitR) {
        if (e.minDist < (hitR + NEARMISS_BAND) && e.minDist > hitR) {
          nearMisses++;
          e.nearReported = true;
          frameNearMiss = true;
          // near-miss sparks: reuse particle cloud, small burst at plane
          emitParticles(14, px + (e.group.position.x - px) * 0.5, py, pz, 4, 10, 0xffd23f);
        } else {
          e.nearReported = true;
        }
      }

      // recycle past camera
      if (e.group.position.z > RECYCLE_Z) recycleEnemy(e);
    }
  }

  /* ----- ARCH ----- */
  function updateArch(dt) {
    if (progress >= ARCH_FADE_PROGRESS) {
      if (!archSpawned) {
        archSpawned = true;
        arch.visible = true;
        // place it at the remaining distance to finish, mapped to z
        const remaining = TARGET_DIST - distance;
        // approximate world distance: arch sits far out and rushes in
        arch.position.z = -Math.min(remaining * 0.9, 480);
      } else {
        arch.position.z += worldSpeed * dt;
      }
      // fade in from fog: opacity ramps with progress
      const op = clamp((progress - ARCH_FADE_PROGRESS) / 0.1, 0, 1);
      archMat.opacity = op;
      if (archBanner) archBanner.opacity = op;
    }
  }

  /* ----- EXPLODING ----- */
  function stepExploding(dt, realDt) {
    // during hit-stop nothing moves; debris/particles wait for doBoom
    // world keeps a tiny scroll for momentum once bullet-time begins
    if (hitstopTimer <= 0) {
      updateDebris(dt);
    }
    updateTrail(0);
  }

  /* ----- RAGDOLL ----- */
  function stepRagdoll(dt, realDt) {
    ragSettleTimer += realDt;
    if (!useRigidFallback) {
      // run substeps for stability
      const steps = 2;
      const sdt = dt / steps;
      for (let i = 0; i < steps; i++) ragdollStep(sdt);
      applyRigFromPoints();
    } else {
      // rigid fallback: spin and fall as one figure
      rigidFall.vel.y += GRAVITY * dt;
      rigidFall.pos.addScaledVector(rigidFall.vel, dt);
      if (rigidFall.pos.y < 0.5) { rigidFall.pos.y = 0.5; rigidFall.vel.set(0, 0, 0); }
      rig.group.position.copy(rigidFall.pos);
      rig.group.rotation.x += rigidFall.spin.x * dt;
      rig.group.rotation.y += rigidFall.spin.y * dt;
      rig.group.rotation.z += rigidFall.spin.z * dt;
    }
    updateDebris(dt);

    if (ragSettleTimer >= RAGDOLL_SETTLE_S) {
      // 0.6s camera push-in then results
      state = ST.ENDED;
      camPullBack = 0.4; // settle into a push-in framing
      fireCrash();
    }
  }

  /* ----- ENDED (win flourish or post-crash) ----- */
  let endedTimer = 0;
  function stepEnded(dt, realDt) {
    // gentle continuation; ragdoll keeps settling if crash
    if (!runResultFired) return;
    // win wiggle / continued scroll for a beat
    if (camPullBack > 0) camPullBack += (0 - camPullBack) * 0.04;
    // keep figure resting / plane wiggling on win
    if (planeMesh && planeMesh.visible) {
      planeMesh.rotation.z = Math.sin(performance.now() * 0.006) * 0.25;
      updateTrail(dt);
    } else {
      // post-crash: let debris and ragdoll keep settling visually
      if (!useRigidFallback && ragPoints.length) {
        const sdt = dt / 2;
        ragdollStep(sdt); ragdollStep(sdt);
        applyRigFromPoints();
      }
      updateDebris(dt);
    }
  }

  /* =====================================================================
     HERO SCENE (separate tiny renderer on #hero-canvas)
     ===================================================================== */
  function ensureHero() {
    if (heroRenderer) return;
    heroRenderer = new THREE.WebGLRenderer({ canvas: heroCanvas, antialias: !isCoarse, alpha: true });
    heroRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    heroRenderer.setClearColor(0x000000, 0);
    heroScene = new THREE.Scene();
    heroCam = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    heroCam.position.set(0, 1.0, 5.2);
    heroCam.lookAt(0, 0.6, 0);
    const hemi = new THREE.HemisphereLight(0xaee2ff, 0xd9b38c, 1.0);
    heroScene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(2, 4, 3);
    heroScene.add(dir);
  }

  function sizeHero() {
    if (!heroRenderer || !heroCanvas) return;
    const w = heroCanvas.clientWidth || heroCanvas.width || 240;
    const h = heroCanvas.clientHeight || heroCanvas.height || 240;
    heroRenderer.setSize(w, h, false);
    heroCam.aspect = w / h;
    heroCam.updateProjectionMatrix();
  }

  function buildHeroRig(equip) {
    if (!window.StickFigure || !window.StickFigure.build) return;
    if (heroRig) {
      heroScene.remove(heroRig.group);
      heroRig = null;
    }
    heroRig = window.StickFigure.build(equip || defaultEquip(), THREE);
    heroScene.add(heroRig.group);
    poseHeroIdle();
  }

  function poseHeroIdle() {
    if (!heroRig) return;
    const SF = window.StickFigure;
    const names = SF.POINT_NAMES;
    const pose = (SF.REST && SF.REST.idle) || (SF.REST && SF.REST.seated) || {};
    // drive hero rig meshes directly from idle pose (local space)
    const pts = [];
    for (let i = 0; i < names.length; i++) {
      const p = pose[names[i]] || { x: 0, y: 0, z: 0 };
      pts.push(new THREE.Vector3(p.x, p.y, p.z));
    }
    const pairs = [[0, 1], [1, 2], [2, 3], [2, 4], [2, 5], [3, 6], [3, 7], [0, 8]];
    const limbs = heroRig.limbMeshes || [];
    for (let i = 0; i < pairs.length && i < limbs.length; i++) {
      const m = limbs[i];
      if (!m) continue;
      const a = pts[pairs[i][0]], b = pts[pairs[i][1]];
      const dirv = new THREE.Vector3().subVectors(b, a);
      const len = dirv.length();
      m.visible = true;
      m.position.copy(a);
      if (len > 1e-5) {
        m.quaternion.setFromUnitVectors(UP, dirv.normalize());
        m.scale.set(1, len, 1);
      }
    }
    if (heroRig.headMesh) heroRig.headMesh.position.copy(pts[0]);
    if (heroRig.jointMeshes) {
      for (const j of heroRig.jointMeshes) {
        if (j.mesh && pts[j.i]) j.mesh.position.copy(pts[j.i]);
      }
    }
    if (heroRig.hatMesh) {
      heroRig.hatMesh.visible = true;
      heroRig.hatMesh.position.copy(pts[8]);
      const dv = new THREE.Vector3().subVectors(pts[8], pts[0]);
      if (dv.length() > 1e-4) heroRig.hatMesh.quaternion.setFromUnitVectors(UP, dv.normalize());
    }
    if (heroRig.capeMesh) {
      // same rule as the in-world rig: mesh stays at origin, geometry rewritten
      // from a chest->hip drape (NOT moved, or it double-transforms)
      heroRig.capeMesh.position.set(0, 0, 0);
      heroRig.capeMesh.quaternion.set(0, 0, 0, 1);
      const rewrite = heroRig.capeMesh.userData && heroRig.capeMesh.userData.rewrite;
      if (rewrite) {
        const chest = pts[2], hip = pts[3];
        _capeS0.pos.x = chest.x;                 _capeS0.pos.y = chest.y;                 _capeS0.pos.z = chest.z - 0.10;
        _capeS1.pos.x = (chest.x + hip.x) * 0.5; _capeS1.pos.y = (chest.y + hip.y) * 0.5; _capeS1.pos.z = (chest.z + hip.z) * 0.5 - 0.28;
        _capeS2.pos.x = hip.x;                   _capeS2.pos.y = hip.y - 0.34;            _capeS2.pos.z = hip.z - 0.46;
        rewrite(_capeStaticPts);
      }
    }
  }

  function startHeroLoop() {
    if (heroRaf) return;
    heroLast = performance.now();
    const tick = (now) => {
      heroRaf = requestAnimationFrame(tick);
      const dt = Math.min((now - heroLast) / 1000, 1 / 30);
      heroLast = now;
      heroSpin += dt * 0.7;
      heroBob += dt;
      if (heroRig) {
        heroRig.group.rotation.y = heroSpin;
        heroRig.group.position.y = Math.sin(heroBob * 1.5) * 0.08;
      }
      heroRenderer.render(heroScene, heroCam);
    };
    heroRaf = requestAnimationFrame(tick);
  }

  /* =====================================================================
     PUBLIC API
     ===================================================================== */
  const Flight = {
    dragOrigin: null,

    init: function (opts) { init(opts); },

    start: function (equip) {
      currentEquip = sanitizeEquip(equip);
      ensureRig();
      if (rig) window.StickFigure.applyEquip(rig, currentEquip);
      applyTrailConfig(currentEquip);

      // reset run state
      runResultFired = false;
      lastMilestone = null;
      timeScale = 1;
      camPullBack = 0;
      shakeAmp = 0;
      pendingExplode = false;
      hitstopTimer = 0;
      bulletEase = 1;
      hideAllEnemies();
      hideDebris();
      spawnQueue = [];
      arch.visible = false;
      archSpawned = false;
      if (planeMesh) { planeMesh.visible = true; planeMesh.rotation.set(0, 0, 0); }
      planeRig.position.set(0, 18, 0);
      input.x = 0; input.y = 0;
      heldKeys.clear();
      dragOrigin = null; pointerId = null; Flight.dragOrigin = null;
      seatFigureInCockpit();
      showFigure();

      // countdown
      state = ST.COUNTDOWN;
      countdownSteps = ['3', '2', '1', 'GO'];
      countdownIdx = 0;
      countdownTimer = 0.65;
      emitCountdownStep(); // show the first step ('3') immediately
    },

    stop: function () {
      state = ST.MENU;
      timeScale = 1;
      hideAllEnemies();
      hideDebris();
      hideTrail();
      arch.visible = false;
      shakeAmp = 0;
      camPullBack = 0;
      if (planeMesh) { planeMesh.visible = true; planeMesh.rotation.set(0, 0, 0); }
      planeRig.position.set(0, 18, 0);
      if (particleCloud) {
        for (let i = 0; i < PARTICLE_COUNT; i++) particleLife[i] = 0;
        particleCloud.visible = false;
      }
      hideFigure();
      parkCameraMenu();
    },

    setEquip: function (equip) {
      currentEquip = sanitizeEquip(equip);
      ensureRig();
      if (rig && window.StickFigure.applyEquip) {
        window.StickFigure.applyEquip(rig, currentEquip);
        // rebuild rag constraints in case cape added/removed
        buildRagFromRig();
        if (state === ST.GRACE || state === ST.FLYING) seatFigureInCockpit();
      }
      applyTrailConfig(currentEquip);
    },

    renderHero: function (equip) {
      ensureHero();
      sizeHero();
      buildHeroRig(sanitizeEquip(equip));
      startHeroLoop();
    },

    stopHero: function () {
      if (heroRaf) { cancelAnimationFrame(heroRaf); heroRaf = 0; }
    },

    onProgress: function (cb) { cbProgress = cb; },
    onWin: function (cb) { cbWin = cb; },
    onCrash: function (cb) { cbCrash = cb; },

    pause: function () { pause(); },
    resume: function () { resume(); }
  };

  function pause() { pausedExternally = true; }
  function resume() { pausedExternally = false; lastNow = performance.now(); }

  function sanitizeEquip(equip) {
    const d = defaultEquip();
    if (!equip || typeof equip !== 'object') return d;
    const hats = ['none', 'cap', 'party', 'helmet', 'crown'];
    const cols = ['blue', 'red', 'green', 'hotpink', 'gold'];
    const capes = ['none', 'red', 'rainbow'];
    const trails = ['white', 'fire', 'rainbow'];
    return {
      hat: hats.includes(equip.hat) ? equip.hat : 'none',
      colour: cols.includes(equip.colour) ? equip.colour : 'blue',
      cape: capes.includes(equip.cape) ? equip.cape : 'none',
      trail: trails.includes(equip.trail) ? equip.trail : 'white'
    };
  }

  // build the enemy pool lazily at init time (after scene exists)
  buildEnemyPool();

  window.Flight = Flight;

})();
