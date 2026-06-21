'use strict';

/* ===================== Stick Flight =====================
   UI glue + persistence + sound + economy + the customizable
   stick-figure factory. Sibling to pwa-maths — same chunky,
   bright, kid-friendly idioms (tone(), showScreen(), confetti).

   This file owns:
     - window.StickFigure  (the figure mesh factory the engine drives)
     - all localStorage  (stickflight-save)
     - all .screen switching (showScreen)
     - WebAudio SFX, the token economy, the shop, results, confetti
   It NEVER references THREE directly except by passing the global
   through into StickFigure.build (which builds geometry). The 3D
   engine lives in flight.js (window.Flight). */

/* ============================================================
   SECTION 0 — constants: catalog, colours, economy, defaults
   ============================================================ */

// §D — the item catalog. Only ids ever persist; everything else
// (label/emoji/price) is static here.
const CATALOG = {
  hat: [
    { id: 'none',   label: 'No Hat',   emoji: '🚫',  price: 0 },
    { id: 'cap',    label: 'Cap',      emoji: '🧢',  price: 40 },
    { id: 'party',  label: 'Party Hat', emoji: '🥳', price: 60 },
    { id: 'helmet', label: 'Helmet',   emoji: '⛑️',  price: 80 },
    { id: 'crown',  label: 'Crown',    emoji: '👑',  price: 120 },
  ],
  colour: [
    { id: 'blue',    label: 'Blue',     emoji: '🟦', price: 0 },
    { id: 'red',     label: 'Red',      emoji: '🟥', price: 30 },
    { id: 'green',   label: 'Green',    emoji: '🟩', price: 30 },
    { id: 'hotpink', label: 'Hot Pink', emoji: '🩷', price: 50 },
    { id: 'gold',    label: 'Gold',     emoji: '🟨', price: 150 },
  ],
  cape: [
    { id: 'none',    label: 'No Cape',      emoji: '🚫', price: 0 },
    { id: 'red',     label: 'Red Cape',     emoji: '🦸', price: 70 },
    { id: 'rainbow', label: 'Rainbow Cape', emoji: '🌈', price: 200 },
  ],
  trail: [
    { id: 'white',   label: 'White',   emoji: '☁️', price: 0 },
    { id: 'fire',    label: 'Fire',    emoji: '🔥', price: 60 },
    { id: 'rainbow', label: 'Rainbow', emoji: '🌈', price: 180 },
  ],
};

const SLOT_ORDER = ['hat', 'colour', 'cape', 'trail'];
const SLOT_TITLES = { hat: 'Hats 🎩', colour: 'Colours 🎨', cape: 'Capes 🦸', trail: 'Trails ✨' };

// §D — limb/torso colour hex map (static, no per-frame hue cycling).
const COLOUR_HEX = {
  blue:    0x2b7fff,
  red:     0xff4d4d,
  green:   0x35c759,
  hotpink: 0xff5fb0,
  gold:    0xffcf33,
};

// §D — trail (plane exhaust) colour map. rainbow is a fixed magenta tint in v1.
const TRAIL_HEX = {
  white:   0xffffff,
  fire:    0xff7a1a,
  rainbow: 0xff00aa,
};

// §D — cape colour map.
const CAPE_HEX = {
  red:     0xff4d4d,
  rainbow: 0xff00aa,
};

// §H — economy constants (app.js mirrors the engine's CONFIG numbers).
const TOKENS_PER_100 = 1;   // floor(distance / 100)
const NEARMISS_TOKEN = 1;
const NEARMISS_CAP   = 15;
const FINISH_BONUS   = 25;

// §C — the four free defaults (one per slot). Seeded owned + equipped.
const FREE_DEFAULTS = { hat: 'none', colour: 'blue', cape: 'none', trail: 'white' };
const FREE_OWNED = SLOT_ORDER.map((s) => s + ':' + FREE_DEFAULTS[s]); // ["hat:none",...]

// §E — the persisted save blob (single key). loadSave deep-merges over this.
const SAVE_KEY = 'stickflight-save';
const DEFAULT_SAVE = {
  v: 1,
  tokens: 0,
  best: 0,
  runs: 0,
  soundOn: true,
  owned: FREE_OWNED.slice(),
  equipped: Object.assign({}, FREE_DEFAULTS),
};

/* ============================================================
   SECTION 1 — window.StickFigure (the figure factory)
   ------------------------------------------------------------
   build(config, THREE) -> rig that the engine drives by moving
   the 9 points. We provide ONLY geometry + materials + skinning.
   The engine repositions points (seated / Verlet / idle) and we
   never animate. THREE is received as an argument so app.js never
   touches the global directly — but inside build we read it to
   construct geometry, which the contract explicitly allows.
   ============================================================ */

// §F — point order. A proper little humanoid: head/neck/chest/hip spine, two
// arms (shoulder→elbow→hand) and two legs (hip→knee→foot) so the limbs BEND at
// elbows and knees when it ragdolls. head=0, chest=2, hip=3 are kept at their
// old indices; 'hat' stays last. The engine derives all topology from REST so
// this list + CONSTRAINTS are the single source of truth.
const POINT_NAMES = [
  'head', 'neck', 'chest', 'hip',
  'Lshoulder', 'Lelbow', 'Lhand',
  'Rshoulder', 'Relbow', 'Rhand',
  'Lknee', 'Lfoot', 'Rknee', 'Rfoot',
  'hat',
];
const NI = {}; POINT_NAMES.forEach((n, i) => { NI[n] = i; });

// Bones as [a, b] index pairs. limbMeshes is built one-per-constraint in THIS
// order so the engine iterates constraints and limbMeshes in lockstep. The
// head-hat link (last) is severable so the hat flies off on a crash.
const CONSTRAINTS = [
  [NI.head, NI.neck],          // 0  neck
  [NI.neck, NI.chest],         // 1  upper torso
  [NI.chest, NI.hip],          // 2  torso
  [NI.chest, NI.Lshoulder],    // 3  L clavicle
  [NI.Lshoulder, NI.Lelbow],   // 4  L upper arm
  [NI.Lelbow, NI.Lhand],       // 5  L forearm
  [NI.chest, NI.Rshoulder],    // 6  R clavicle
  [NI.Rshoulder, NI.Relbow],   // 7  R upper arm
  [NI.Relbow, NI.Rhand],       // 8  R forearm
  [NI.hip, NI.Lknee],          // 9  L thigh
  [NI.Lknee, NI.Lfoot],        // 10 L shin
  [NI.hip, NI.Rknee],          // 11 R thigh
  [NI.Rknee, NI.Rfoot],        // 12 R shin
  [NI.head, NI.hat],           // 13 head-hat (severable, invisible)
];

// Per-constraint cylinder radius (CONSTRAINTS order) — tapered for a human-ish
// silhouette: chunky torso, slimmer arms/legs, thinner forearms.
const LIMB_RADII = [
  0.075, // neck
  0.155, // upper torso
  0.165, // torso
  0.095, // L clavicle
  0.085, // L upper arm
  0.068, // L forearm
  0.095, // R clavicle
  0.085, // R upper arm
  0.068, // R forearm
  0.11,  // L thigh
  0.088, // L shin
  0.11,  // R thigh
  0.088, // R shin
  0.05,  // head-hat (invisible)
];

// Per-constraint material: 's' = skin (bare forearms), 'h' = invisible hat
// link, else the clothing colour. Lets the figure read as a person in a
// coloured outfit with bare lower arms.
const LIMB_MATS = ['s', 'c', 'c', 'c', 'c', 's', 'c', 'c', 's', 'c', 'c', 'c', 'c', 'h'];

// Rounded joint spheres so joints look like joints, not cut tubes.
// [pointName, radius, materialKey('c'|'s'|'shoe')]. The engine repositions each
// at its point every frame (so they follow seated/idle/ragdoll). Head and hat
// are their own meshes and not listed here.
const JOINTS = [
  ['neck',      0.075, 's'],
  ['chest',     0.17,  'c'],
  ['hip',       0.145, 'c'],
  ['Lshoulder', 0.10,  'c'],
  ['Rshoulder', 0.10,  'c'],
  ['Lelbow',    0.072, 's'],
  ['Relbow',    0.072, 's'],
  ['Lhand',     0.085, 's'],
  ['Rhand',     0.085, 's'],
  ['Lknee',     0.092, 'c'],
  ['Rknee',     0.092, 'c'],
  ['Lfoot',     0.10,  'shoe'],
  ['Rfoot',     0.10,  'shoe'],
];

// Canonical standing pose (local space, feet ~y=0, ~1.95 tall). Used for rest
// lengths and as the idle hero pose. Hat sits just above the head.
const STAND = {
  head:      { x: 0.00,  y: 1.78, z: 0.00 },
  neck:      { x: 0.00,  y: 1.58, z: 0.00 },
  chest:     { x: 0.00,  y: 1.40, z: 0.00 },
  hip:       { x: 0.00,  y: 0.95, z: 0.00 },
  Lshoulder: { x: -0.24, y: 1.50, z: 0.00 },
  Lelbow:    { x: -0.30, y: 1.18, z: 0.02 },
  Lhand:     { x: -0.33, y: 0.90, z: 0.04 },
  Rshoulder: { x: 0.24,  y: 1.50, z: 0.00 },
  Relbow:    { x: 0.30,  y: 1.18, z: 0.02 },
  Rhand:     { x: 0.33,  y: 0.90, z: 0.04 },
  Lknee:     { x: -0.15, y: 0.48, z: 0.03 },
  Lfoot:     { x: -0.16, y: 0.02, z: 0.10 },
  Rknee:     { x: 0.15,  y: 0.48, z: 0.03 },
  Rfoot:     { x: 0.16,  y: 0.02, z: 0.10 },
  hat:       { x: 0.00,  y: 1.99, z: 0.00 },
};

// Seated cockpit pose: knees up forward, hands out gripping, slight lean.
const SEATED = {
  head:      { x: 0.00,  y: 1.30, z: 0.06 },
  neck:      { x: 0.00,  y: 1.12, z: 0.04 },
  chest:     { x: 0.00,  y: 0.94, z: 0.00 },
  hip:       { x: 0.00,  y: 0.62, z: -0.05 },
  Lshoulder: { x: -0.22, y: 1.04, z: 0.02 },
  Lelbow:    { x: -0.27, y: 0.92, z: 0.28 },
  Lhand:     { x: -0.20, y: 0.86, z: 0.52 },
  Rshoulder: { x: 0.22,  y: 1.04, z: 0.02 },
  Relbow:    { x: 0.27,  y: 0.92, z: 0.28 },
  Rhand:     { x: 0.20,  y: 0.86, z: 0.52 },
  Lknee:     { x: -0.18, y: 0.62, z: 0.42 },
  Lfoot:     { x: -0.20, y: 0.34, z: 0.30 },
  Rknee:     { x: 0.18,  y: 0.62, z: 0.42 },
  Rfoot:     { x: 0.20,  y: 0.34, z: 0.30 },
  hat:       { x: 0.00,  y: 1.50, z: 0.07 },
};

// Idle hero pose (relaxed standing for the rotating shop/win preview).
const IDLE = STAND;

function _dist(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// §F — REST: rest-length distances per constraint + the seated/idle pose
// tables the engine reads (REST.seated[name] / REST.idle[name]).
const REST = {
  // restLen[i] is the rest length for CONSTRAINTS[i].
  restLen: CONSTRAINTS.map(([a, b]) => _dist(STAND[POINT_NAMES[a]], STAND[POINT_NAMES[b]])),
  // also expose by "a-b" key for convenience / engine flexibility.
  lengths: (function () {
    const o = {};
    CONSTRAINTS.forEach(([a, b], i) => {
      o[POINT_NAMES[a] + '-' + POINT_NAMES[b]] = _dist(STAND[POINT_NAMES[a]], STAND[POINT_NAMES[b]]);
    });
    return o;
  })(),
  constraints: CONSTRAINTS.map(([a, b], i) => ({
    a, b,
    aName: POINT_NAMES[a], bName: POINT_NAMES[b],
    len: _dist(STAND[POINT_NAMES[a]], STAND[POINT_NAMES[b]]),
    severable: POINT_NAMES[a] === 'head' && POINT_NAMES[b] === 'hat',
  })),
  stand: STAND,
  seated: SEATED,
  idle: IDLE,
  HEAD_RADIUS: 0.23,
  LIMB_RADIUS: 0.09,
  HEIGHT: 1.95,
};

// Normalise an equip config: exactly one valid value per slot, fall back
// to the free default for anything missing/invalid. (Mirrors §C.)
function normaliseEquip(config) {
  const c = config || {};
  const out = {};
  for (const slot of SLOT_ORDER) {
    const want = c[slot];
    const ok = CATALOG[slot].some((it) => it.id === want);
    out[slot] = ok ? want : FREE_DEFAULTS[slot];
  }
  return out;
}

// Skin tone (head, bare forearms, hands) + shoe colour — kept constant; only
// the clothing limbs/torso recolour with the chosen colour.
const SKIN_HEX = 0xffd8a8;
const SHOE_HEX = 0x3a3a44;

// Build the hat mesh for a given hat id (or null for 'none'). Each hat is a
// small group of chunky low-poly primitives, centred so its base sits at the
// hat anchor point; the engine positions the whole mesh at the hat point.
function _buildHat(hatId, THREE) {
  if (!hatId || hatId === 'none') return null;
  const g = new THREE.Group();
  const lam = (hex) => new THREE.MeshLambertMaterial({ color: hex });

  if (hatId === 'cap') {
    // dome + flat brim poking forward (+z)
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.34, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), lam(0xff4d4d));
    dome.position.y = 0.02;
    const brim = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 0.34), lam(0xd83b3b));
    brim.position.set(0, 0.02, 0.30);
    g.add(dome, brim);
  } else if (hatId === 'party') {
    // tall cone + pom-pom
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.62, 14), lam(0xff5fb0));
    cone.position.y = 0.31;
    const pom = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), lam(0xffd23f));
    pom.position.y = 0.64;
    g.add(cone, pom);
  } else if (hatId === 'helmet') {
    // smooth dome shell with a chin strap hint
    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.38, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.62), lam(0xffcf33));
    shell.position.y = -0.04;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.385, 0.385, 0.08, 16, 1, true), lam(0xc99a18));
    band.position.y = 0.0;
    g.add(shell, band);
  } else if (hatId === 'crown') {
    // gold band with chunky points + jewels
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.34, 0.22, 14, 1, true), lam(0xffcf33));
    band.position.y = 0.10;
    g.add(band);
    const points = 5;
    for (let i = 0; i < points; i++) {
      const a = (i / points) * Math.PI * 2;
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.22, 6), lam(0xffe27a));
      spike.position.set(Math.cos(a) * 0.30, 0.30, Math.sin(a) * 0.30);
      g.add(spike);
      const jewel = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 5), lam(0xff4d4d));
      jewel.position.set(Math.cos(a) * 0.30, 0.12, Math.sin(a) * 0.30);
      g.add(jewel);
    }
  }
  g.userData.hatId = hatId;
  return g;
}

// Build the cape: a flat trailing ribbon made of 2 quads (3-point chain off
// the chest). We hand back the mesh plus the 3 cape points the engine flails
// with the ragdoll solver. The geometry is a non-indexed BufferGeometry with
// 12 verts (2 segments * 2 tris * 3) the engine rewrites each frame from the
// cape points; we seed it in a sensible draped pose.
const CAPE_WIDTH = 0.62;

function _buildCape(capeId, THREE) {
  if (!capeId || capeId === 'none') return { mesh: null, points: [] };
  const hex = CAPE_HEX[capeId] != null ? CAPE_HEX[capeId] : CAPE_HEX.red;
  const mat = new THREE.MeshLambertMaterial({
    color: hex, side: THREE.DoubleSide, emissive: capeId === 'rainbow' ? 0x330022 : 0x000000,
  });
  // 3 anchor points trailing down-and-back from the chest (local figure space).
  // chest is at ~(0,1.05,0); cape hangs behind (-z) and down.
  const points = [
    { pos: { x: 0, y: 1.05, z: -0.16 }, prev: { x: 0, y: 1.05, z: -0.16 }, pinned: true },
    { pos: { x: 0, y: 0.62, z: -0.30 }, prev: { x: 0, y: 0.62, z: -0.30 }, pinned: false },
    { pos: { x: 0, y: 0.18, z: -0.42 }, prev: { x: 0, y: 0.18, z: -0.42 }, pinned: false },
  ];
  // 2 segments, each a quad (2 triangles). 12 verts total.
  const geo = new THREE.BufferGeometry();
  const verts = new Float32Array(12 * 3);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.userData.capeId = capeId;
  mesh.userData.halfWidth = CAPE_WIDTH / 2;
  // Seed the verts once so it looks right before the engine drives it.
  _writeCapeGeometry(mesh, points, THREE);
  return { mesh, points };
}

// Rewrite the cape ribbon geometry from its 3 points. Exposed on the mesh's
// userData so the engine can call it each frame; also used to seed the pose.
function _writeCapeGeometry(mesh, points, THREE) {
  if (!mesh) return;
  const hw = mesh.userData.halfWidth || CAPE_WIDTH / 2;
  const pos = mesh.geometry.getAttribute('position');
  const arr = pos.array;
  let o = 0;
  // For each of the 2 segments build a quad spanning x = [-hw, +hw] at the
  // two consecutive points' y/z. Ribbon faces the local x axis as width.
  for (let s = 0; s < 2; s++) {
    const a = points[s].pos, b = points[s + 1].pos;
    // 4 corners: a-left, a-right, b-left, b-right
    const aL = [a.x - hw, a.y, a.z];
    const aR = [a.x + hw, a.y, a.z];
    const bL = [b.x - hw, b.y, b.z];
    const bR = [b.x + hw, b.y, b.z];
    // tri 1: aL, aR, bR
    arr[o++] = aL[0]; arr[o++] = aL[1]; arr[o++] = aL[2];
    arr[o++] = aR[0]; arr[o++] = aR[1]; arr[o++] = aR[2];
    arr[o++] = bR[0]; arr[o++] = bR[1]; arr[o++] = bR[2];
    // tri 2: aL, bR, bL
    arr[o++] = aL[0]; arr[o++] = aL[1]; arr[o++] = aL[2];
    arr[o++] = bR[0]; arr[o++] = bR[1]; arr[o++] = bR[2];
    arr[o++] = bL[0]; arr[o++] = bL[1]; arr[o++] = bL[2];
  }
  pos.needsUpdate = true;
  mesh.geometry.computeVertexNormals();
  mesh.geometry.computeBoundingSphere();
}

// build(config, THREE): the canonical figure rig. Returns data-only geometry.
function buildStickFigure(config, THREE) {
  const equip = normaliseEquip(config);
  const limbHex = COLOUR_HEX[equip.colour] != null ? COLOUR_HEX[equip.colour] : COLOUR_HEX.blue;

  const group = new THREE.Group();
  group.userData.equip = equip;

  // Materials: ONE shared clothing material (colour swap = a single .color.set),
  // a skin material (head/forearms/hands), and a shoe material. Only the
  // clothing material recolours.
  const limbMat = new THREE.MeshLambertMaterial({ color: limbHex });
  const skinMat = new THREE.MeshLambertMaterial({ color: SKIN_HEX });
  const shoeMat = new THREE.MeshLambertMaterial({ color: SHOE_HEX });
  const matFor = (key) => key === 's' ? skinMat : key === 'shoe' ? shoeMat : limbMat;
  group.userData.limbMat = limbMat;
  group.userData.headMat = skinMat;

  // Build the points from the standing pose. {pos,prev,pinned} — the engine
  // mutates pos/prev; pinned defaults false (engine pins as needed).
  const points = POINT_NAMES.map((name) => {
    const p = STAND[name];
    return { name, pos: { x: p.x, y: p.y, z: p.z }, prev: { x: p.x, y: p.y, z: p.z }, pinned: false };
  });

  // Head sphere (skin) + a simple face: two eyes on the +z front. The engine
  // positions the head by its point (no rotation), so the face stays forward —
  // toward the viewer in the rotating shop preview.
  const headMesh = new THREE.Mesh(new THREE.SphereGeometry(REST.HEAD_RADIUS, 18, 14), skinMat);
  headMesh.position.set(STAND.head.x, STAND.head.y, STAND.head.z);
  const eyeMat = new THREE.MeshLambertMaterial({ color: 0x20232b });
  const eyeGeo = new THREE.SphereGeometry(REST.HEAD_RADIUS * 0.19, 8, 6);
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(eyeGeo, eyeMat);
    eye.position.set(sx * REST.HEAD_RADIUS * 0.42, REST.HEAD_RADIUS * 0.18, REST.HEAD_RADIUS * 0.88);
    headMesh.add(eye);
  }
  group.add(headMesh);

  // One reusable cylinder per bone (unit-height along +Y, origin-centred — the
  // engine sets position=midpoint, scale.y=length, quaternion). Per-bone radius
  // + material; the invisible head-hat link is hidden.
  const limbMeshes = CONSTRAINTS.map(([a, b], i) => {
    const hidden = LIMB_MATS[i] === 'h';
    const r = LIMB_RADII[i] != null ? LIMB_RADII[i] : 0.09;
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1, 10, 1), matFor(LIMB_MATS[i]));
    if (hidden) m.visible = false;
    _orientLimb(m, points[a].pos, points[b].pos, THREE);
    group.add(m);
    return m;
  });

  // Rounded joint spheres (shoulders/elbows/knees/hands/feet/hip/neck) so the
  // joints look like joints. The engine repositions each at its point every
  // frame, so they follow seated/idle/ragdoll poses.
  const jointMeshes = JOINTS.map(([name, r, matKey]) => {
    const i = NI[name];
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 9), matFor(matKey));
    const p = points[i].pos;
    m.position.set(p.x, p.y, p.z);
    group.add(m);
    return { mesh: m, i };
  });

  // Hat mesh (parented under the group; engine positions it at the hat point).
  let hatMesh = _buildHat(equip.hat, THREE);
  if (hatMesh) {
    hatMesh.position.set(STAND.hat.x, STAND.hat.y, STAND.hat.z);
    group.add(hatMesh);
  }

  // Cape (3-point chain + ribbon mesh).
  const cape = _buildCape(equip.cape, THREE);
  let capeMesh = cape.mesh;
  let capePoints = cape.points;
  if (capeMesh) {
    capeMesh.userData.rewrite = (pts) => _writeCapeGeometry(capeMesh, pts || capePoints, THREE);
    group.add(capeMesh);
  }

  const rig = { group, points, limbMeshes, jointMeshes, headMesh, hatMesh, capeMesh, capePoints };
  // stash the THREE ref + equip so applyEquip can rebuild hat/cape in place.
  rig._THREE = THREE;
  rig._equip = equip;
  return rig;
}

// Helper: orient a unit-cylinder limb mesh between two world-ish positions.
// Self-contained (uses a private scratch vector/quaternion) so it can run at
// build time; the engine has its own per-frame version but this keeps the
// seeded pose correct without the engine's involvement.
let _scratchA = null, _scratchB = null, _scratchQ = null, _scratchUp = null;
function _orientLimb(mesh, a, b, THREE) {
  if (!_scratchA) {
    _scratchA = new THREE.Vector3();
    _scratchB = new THREE.Vector3();
    _scratchQ = new THREE.Quaternion();
    _scratchUp = new THREE.Vector3(0, 1, 0);
  }
  _scratchA.set(a.x, a.y, a.z);
  _scratchB.set(b.x, b.y, b.z);
  const len = _scratchA.distanceTo(_scratchB);
  mesh.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  if (len > 1e-5) {
    _scratchB.sub(_scratchA).normalize();
    _scratchQ.setFromUnitVectors(_scratchUp, _scratchB);
    mesh.quaternion.copy(_scratchQ);
    mesh.scale.set(1, len, 1);
  }
}

// applyEquip(rig, config): mutate the existing rig in place. Colour swaps the
// shared limb material; hat/cape are rebuilt only if their id changed.
function applyStickEquip(rig, config) {
  if (!rig) return;
  const THREE = rig._THREE;
  const equip = normaliseEquip(config);
  const prev = rig._equip || {};

  // 1) limb/torso colour — single material colour set (no rebuild).
  if (equip.colour !== prev.colour) {
    const hex = COLOUR_HEX[equip.colour] != null ? COLOUR_HEX[equip.colour] : COLOUR_HEX.blue;
    if (rig.group && rig.group.userData.limbMat) rig.group.userData.limbMat.color.setHex(hex);
  }

  // 2) hat — swap the mesh if the id changed.
  if (equip.hat !== prev.hat) {
    if (rig.hatMesh) {
      rig.group.remove(rig.hatMesh);
      _disposeMesh(rig.hatMesh);
      rig.hatMesh = null;
    }
    const newHat = _buildHat(equip.hat, THREE);
    if (newHat) {
      const hatPt = rig.points[NI.hat] ? rig.points[NI.hat].pos : STAND.hat;
      newHat.position.set(hatPt.x, hatPt.y, hatPt.z);
      rig.group.add(newHat);
    }
    rig.hatMesh = newHat;
  }

  // 3) cape — rebuild if id changed.
  if (equip.cape !== prev.cape) {
    if (rig.capeMesh) {
      rig.group.remove(rig.capeMesh);
      _disposeMesh(rig.capeMesh);
      rig.capeMesh = null;
      rig.capePoints = [];
    }
    const cape = _buildCape(equip.cape, THREE);
    if (cape.mesh) {
      cape.mesh.userData.rewrite = (pts) => _writeCapeGeometry(cape.mesh, pts || rig.capePoints, THREE);
      rig.group.add(cape.mesh);
    }
    rig.capeMesh = cape.mesh;
    rig.capePoints = cape.points;
  }

  rig._equip = equip;
  rig.group.userData.equip = equip;
}

// applyTrail(config): tell the engine how to colour/style the exhaust Points.
function applyTrail(config) {
  const equip = normaliseEquip(config);
  const style = equip.trail;
  const color = TRAIL_HEX[style] != null ? TRAIL_HEX[style] : TRAIL_HEX.white;
  return { color, style };
}

function _disposeMesh(obj) {
  if (!obj) return;
  obj.traverse && obj.traverse((c) => {
    if (c.geometry && c.geometry.dispose) c.geometry.dispose();
    // materials are mostly per-hat throwaways; safe to dispose non-shared ones.
    if (c.material && c.material.dispose && c.material !== (window.__SF_SHARED_LIMB || null)) {
      c.material.dispose();
    }
  });
  if (obj.geometry && obj.geometry.dispose) obj.geometry.dispose();
}

// Expose the figure factory exactly as the contract specifies.
window.StickFigure = {
  build: buildStickFigure,
  applyEquip: applyStickEquip,
  applyTrail: applyTrail,
  POINT_NAMES: POINT_NAMES,
  REST: REST,
};

/* ============================================================
   SECTION 2 — persistence (localStorage, §E)
   ============================================================ */

let save = null; // the live save blob, populated by loadSave()

// Deep-merge a parsed blob over DEFAULT_SAVE, validate everything, repair.
function loadSave() {
  let parsed = null;
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) parsed = JSON.parse(raw);
  } catch (e) {
    parsed = null; // malformed JSON → fall back to defaults
  }

  const s = {
    v: 1,
    tokens: 0,
    best: 0,
    runs: 0,
    soundOn: true,
    owned: FREE_OWNED.slice(),
    equipped: Object.assign({}, FREE_DEFAULTS),
  };

  if (parsed && typeof parsed === 'object') {
    if (Number.isFinite(parsed.tokens)) s.tokens = Math.max(0, Math.floor(parsed.tokens));
    if (Number.isFinite(parsed.best)) s.best = Math.max(0, Math.floor(parsed.best));
    if (Number.isFinite(parsed.runs)) s.runs = Math.max(0, Math.floor(parsed.runs));
    if (typeof parsed.soundOn === 'boolean') s.soundOn = parsed.soundOn;

    // owned: keep only valid "slot:itemId" ids that exist in CATALOG.
    if (Array.isArray(parsed.owned)) {
      const valid = new Set();
      for (const id of parsed.owned) {
        if (typeof id !== 'string') continue;
        const [slot, itemId] = id.split(':');
        if (CATALOG[slot] && CATALOG[slot].some((it) => it.id === itemId)) valid.add(id);
      }
      // always re-seed the four freebies.
      for (const f of FREE_OWNED) valid.add(f);
      s.owned = Array.from(valid);
    }

    // equipped: each slot must be a real item AND owned, else free default.
    if (parsed.equipped && typeof parsed.equipped === 'object') {
      for (const slot of SLOT_ORDER) {
        const want = parsed.equipped[slot];
        const isItem = CATALOG[slot].some((it) => it.id === want);
        const ownedId = slot + ':' + want;
        if (isItem && s.owned.indexOf(ownedId) !== -1) {
          s.equipped[slot] = want;
        } else {
          s.equipped[slot] = FREE_DEFAULTS[slot]; // free default is always owned
        }
      }
    }
  }

  save = s;
  soundOn = s.soundOn;
  // First run (no valid prior save): persist the seeded freebies immediately so
  // they're durable even if the player quits without buying/equipping/flying.
  if (!parsed || typeof parsed !== 'object') saveSave();
  return s;
}

function saveSave() {
  if (!save) return;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(save));
  } catch (e) { /* storage full / unavailable — non-fatal */ }
}

function currentEquip() {
  return Object.assign({}, save ? save.equipped : FREE_DEFAULTS);
}

function isOwned(slot, itemId) {
  return save && save.owned.indexOf(slot + ':' + itemId) !== -1;
}

function itemDef(slot, itemId) {
  return CATALOG[slot] ? CATALOG[slot].find((it) => it.id === itemId) : null;
}

/* ============================================================
   SECTION 3 — sound (WebAudio, copied from maths tone())
   ============================================================ */

let soundOn = true; // mirrors save.soundOn; loadSave updates it
let audioCtx = null;

function tone(freq, startAt, dur, type = 'sine', gain = 0.18) {
  if (!soundOn) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t0 = audioCtx.currentTime + startAt;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(g).connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  } catch (e) { /* no sound available — fine */ }
}

// A pitch sweep on a single oscillator (for the boom).
function toneSweep(fromFreq, toFreq, startAt, dur, type = 'square', gain = 0.2) {
  if (!soundOn) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t0 = audioCtx.currentTime + startAt;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(fromFreq, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, toFreq), t0 + dur);
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(g).connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  } catch (e) { /* fine */ }
}

// A short filtered noise burst (for the boom's crunch).
function noiseBurst(startAt, dur, gain = 0.22) {
  if (!soundOn) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t0 = audioCtx.currentTime + startAt;
    const frames = Math.floor(audioCtx.sampleRate * dur);
    const buf = audioCtx.createBuffer(1, frames, audioCtx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    const lp = audioCtx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1200;
    src.connect(lp).connect(g).connect(audioCtx.destination);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  } catch (e) { /* fine */ }
}

// Unlock/resume the audio context on a user gesture (iOS requirement).
function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) { /* fine */ }
}

// §I — the named SFX, all gated by soundOn inside tone()/etc.
function playStart() {           // 3 ascending triangle blips (3-2-1)
  tone(523, 0, 0.14, 'triangle', 0.14);
  tone(659, 0.18, 0.14, 'triangle', 0.14);
  tone(784, 0.36, 0.16, 'triangle', 0.15);
}
function playGo()    { tone(784, 0, 0.28, 'triangle', 0.18); tone(1047, 0.12, 0.22, 'triangle', 0.14); }
function playBoom()  { toneSweep(200, 40, 0, 0.55, 'square', 0.22); noiseBurst(0, 0.45, 0.24); }
function playNearMiss() { tone(1047, 0, 0.1, 'triangle', 0.12); }
function playWin()   { [523, 659, 784, 1047, 784, 1047, 1319, 1568].forEach((f, i) => tone(f, i * 0.13, 0.24, 'triangle', 0.16)); }
function playBuy()   { tone(660, 0, 0.1, 'triangle', 0.16); tone(880, 0.1, 0.16, 'triangle', 0.16); }
function playEquip() { tone(523, 0, 0.12, 'triangle', 0.15); }

function updateSoundButtons() {
  document.querySelectorAll('[data-action="toggle-sound"]').forEach((b) => {
    b.textContent = soundOn ? '🔊' : '🔇';
    b.setAttribute('aria-pressed', soundOn ? 'true' : 'false');
  });
}

/* ============================================================
   SECTION 4 — screens
   ============================================================ */

const SCREENS = {
  title: 'title-screen',
  game: 'game-screen',
  shop: 'shop-screen',
  win: 'win-screen',
  gameover: 'gameover-screen',
};

let currentScreen = 'title';

function showScreen(name) {
  currentScreen = name;
  for (const key of Object.keys(SCREENS)) {
    const el = document.getElementById(SCREENS[key]);
    if (el) el.hidden = key !== name;
  }
  // the touch-origin ring only belongs on the live game screen
  if (name !== 'game') {
    const ghost = document.getElementById('drag-ghost');
    if (ghost) ghost.hidden = true;
  }
  // Leaving the shop stops the hero rAF; entering it (re)starts it.
  if (name === 'shop') {
    if (window.Flight && Flight.renderHero) Flight.renderHero(currentEquip());
  } else {
    if (name !== 'win' && window.Flight && Flight.stopHero) Flight.stopHero();
  }
}

/* ============================================================
   SECTION 5 — title screen render
   ============================================================ */

function fmtDist(d) { return Math.round(d) + ' m'; }

function renderTitle() {
  const best = document.getElementById('title-best');
  const tok = document.getElementById('title-tokens');
  if (best) best.textContent = save.best > 0 ? `🏁 Best: ${fmtDist(save.best)}` : 'No flights yet';
  if (tok) tok.textContent = `🪙 ${save.tokens}`;
  updateSoundButtons();
}

/* ============================================================
   SECTION 6 — the flight run + token award
   ============================================================ */

let runState = null; // live per-run accumulator while FLYING

function startRun() {
  unlockAudio();
  runState = { distance: 0, nearMisses: 0, progress: 0, ended: false };
  // reset the live HUD pill + progress
  const pill = document.getElementById('token-pill');
  if (pill) pill.textContent = '🪙 0';
  setProgress(0);
  showScreen('game');
  playStart();
  if (window.Flight && Flight.start) Flight.start(currentEquip());
}

// Mirror the engine's live progress into the HUD; show encouragement toasts on
// milestones; tally near-misses for the running token estimate.
function onProgress(p) {
  if (!runState || runState.ended) return;
  // engine reports each 3-2-1-GO step here (countdown:null clears it on GO)
  if (p.countdown !== undefined) setCountdown(p.countdown);
  updateDragGhost();
  runState.distance = p.distance;
  runState.progress = p.progress;
  if (p.nearMiss) {
    runState.nearMisses += 1;
    playNearMiss();
    if (runState.nearMisses <= NEARMISS_CAP) bumpTokenPill();
    showToast(pickFrom(NEARMISS_TOASTS), 900);
  }
  setProgress(p.progress);
  // live running token estimate in the pill
  const est = estimateTokens(runState.distance, runState.nearMisses, false);
  const pill = document.getElementById('token-pill');
  if (pill) pill.textContent = `🪙 ${est}`;

  if (p.milestone) {
    if (p.milestone === 'go') showToast(pickFrom(GO_TOASTS), 1100);
    else if (p.milestone === 'halfway') showToast('Halfway there! 🛫', 1100);
    else if (p.milestone === 'almost') showToast('Nearly at the finish! 🏁', 1100);
  }
}

function estimateTokens(distance, nearMisses, won) {
  return Math.floor(distance / 100) * TOKENS_PER_100
    + Math.min(nearMisses, NEARMISS_CAP) * NEARMISS_TOKEN
    + (won ? FINISH_BONUS : 0);
}

// Compute + award tokens from a RunResult, update best, persist, return a
// breakdown the results card renders.
function awardRun(result) {
  const distance = Math.max(0, Math.round(result.distance || 0));
  const nearMisses = Math.max(0, result.nearMisses || 0);
  const won = !!result.won;

  const distTokens = Math.floor(distance / 100) * TOKENS_PER_100;
  const nmTokens = Math.min(nearMisses, NEARMISS_CAP) * NEARMISS_TOKEN;
  const bonusTokens = won ? FINISH_BONUS : 0;
  const total = distTokens + nmTokens + bonusTokens;

  save.tokens += total;
  save.runs += 1;
  const isBest = distance > save.best;
  if (isBest) save.best = distance;
  saveSave();

  return { distance, nearMisses, won, distTokens, nmTokens, bonusTokens, total, isBest, cappedNm: Math.min(nearMisses, NEARMISS_CAP) };
}

function onWin(result) {
  if (!runState || runState.ended) return;
  runState.ended = true;
  const b = awardRun(Object.assign({}, result, { won: true }));
  renderResults('win', b);
  showScreen('win');
  playWin();
  launchConfetti();
}

function onCrash(result) {
  if (!runState || runState.ended) return;
  runState.ended = true;
  const b = awardRun(Object.assign({}, result, { won: false }));
  renderResults('gameover', b);
  showScreen('gameover');
  // the boom SFX already fired at impact (see crash hook below); here just
  // a gentle "still earned tokens" cue via a soft blip.
  tone(330, 0, 0.16, 'triangle', 0.1);
}

// Render the earned-tokens breakdown into the win/gameover card.
function renderResults(which, b) {
  const tokensEl = document.getElementById(which === 'win' ? 'win-tokens' : 'crash-tokens');
  const bestEl = document.getElementById(which === 'win' ? 'win-best' : 'crash-best');

  if (tokensEl) {
    let html = '';
    html += `<div class="result-total">🪙 ${b.total}</div>`;
    html += `<div class="result-total-label">Stick Tokens earned</div>`;
    html += `<ul class="result-breakdown">`;
    html += `<li><span>Distance (${fmtDist(b.distance)})</span><span>+${b.distTokens} 🪙</span></li>`;
    html += `<li><span>Near misses ×${b.cappedNm}</span><span>+${b.nmTokens} 🪙</span></li>`;
    if (which === 'win') {
      html += `<li class="bonus"><span>Finish bonus 🏁</span><span>+${b.bonusTokens} 🪙</span></li>`;
    }
    html += `</ul>`;
    html += `<div class="result-balance">Balance: 🪙 ${save.tokens}</div>`;
    tokensEl.innerHTML = html;
  }

  if (bestEl) {
    if (b.isBest) {
      bestEl.innerHTML = `<span class="new-best">🏆 NEW BEST! ${fmtDist(b.distance)}</span>`;
    } else {
      bestEl.innerHTML = `<span class="best-line">🏁 Best: ${fmtDist(save.best)}</span>`;
    }
  }
}

/* ============================================================
   SECTION 7 — progress bar + toasts
   ============================================================ */

function setProgress(progress) {
  const fill = document.getElementById('progress-fill');
  const plane = document.getElementById('progress-plane');
  const pct = Math.max(0, Math.min(1, progress)) * 100;
  if (fill) fill.style.width = pct + '%';
  if (plane) plane.style.left = pct + '%';
}

// Touch-origin ring: the engine exposes Flight.dragOrigin ({x,y}|null); we
// position the ghost there and show/hide it. Helps kids see where they anchored
// their drag on the iPad. Called every flight frame from onProgress.
function updateDragGhost() {
  const ghost = document.getElementById('drag-ghost');
  if (!ghost) return;
  const o = (window.Flight && window.Flight.dragOrigin) || null;
  if (o) {
    ghost.style.setProperty('--gx', o.x + 'px');
    ghost.style.setProperty('--gy', o.y + 'px');
    ghost.hidden = false;
  } else if (!ghost.hidden) {
    ghost.hidden = true;
  }
}

// The big 3-2-1-GO punch-in. Driven by the engine over onProgress: a string
// per step ('3'|'2'|'1'|'GO'), then null to clear it as flying begins. Per the
// engine contract this overlay is app.js's DOM (the engine only renders #scene).
function setCountdown(value) {
  const overlay = document.getElementById('countdown-overlay');
  const text = document.getElementById('countdown-text');
  if (!overlay || !text) return;
  if (value == null) {
    overlay.hidden = true;
    text.classList.remove('go');
    return;
  }
  text.textContent = value;
  text.classList.toggle('go', value === 'GO'); // gold tint on GO
  overlay.hidden = false;
  // re-trigger the countPop animation each step (CSS plays it only once)
  text.style.animation = 'none';
  void text.offsetWidth;
  text.style.animation = '';
}

let toastTimer = null;
function showToast(text, ms = 1100) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), ms);
}

function bumpTokenPill() {
  const pill = document.getElementById('token-pill');
  if (!pill) return;
  pill.classList.remove('bump');
  void pill.offsetWidth;
  pill.classList.add('bump');
}

const GO_TOASTS = ['GO GO GO! 🚀', 'Take off! ✈️', 'Weave and dodge! 💨'];
const NEARMISS_TOASTS = ['WHOOSH! 😮', 'So close! 😅', 'Nice dodge! 👏', 'Phew! 💨', 'Slick! ✨'];

function pickFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

/* ============================================================
   SECTION 8 — shop
   ============================================================ */

function openShop() {
  unlockAudio();
  renderShop();
  showScreen('shop'); // showScreen kicks off Flight.renderHero
}

function renderShop() {
  const grid = document.getElementById('shop-grid');
  const bal = document.getElementById('shop-balance');
  if (bal) bal.textContent = `🪙 ${save.tokens}`;
  if (!grid) return;

  let html = '';
  for (const slot of SLOT_ORDER) {
    html += `<div class="shop-group">`;
    html += `<h2 class="shop-slot-title">${SLOT_TITLES[slot]}</h2>`;
    html += `<div class="shop-row">`;
    for (const item of CATALOG[slot]) {
      const owned = isOwned(slot, item.id);
      const equipped = save.equipped[slot] === item.id;
      const affordable = save.tokens >= item.price;
      const classes = ['shop-card'];
      if (equipped) classes.push('equipped');
      else if (owned) classes.push('owned');
      else if (!affordable) classes.push('locked');

      let badge;
      if (equipped) badge = `<span class="card-badge badge-equipped">Equipped</span>`;
      else if (owned) badge = `<span class="card-badge badge-owned">✓ Owned</span>`;
      else badge = `<span class="card-badge badge-price">🪙 ${item.price}</span>`;

      html += `<button type="button" class="${classes.join(' ')}" ` +
        `data-action="shop-card" data-item="${slot}:${item.id}" ` +
        `aria-label="${item.label}">` +
        `<span class="card-emoji">${item.emoji}</span>` +
        `<span class="card-label">${item.label}</span>` +
        badge +
        `</button>`;
    }
    html += `</div></div>`;
  }
  grid.innerHTML = html;
}

// A single card was tapped. Branch buy-vs-equip from owned state.
function onShopCard(dataItem, cardEl) {
  unlockAudio();
  const [slot, itemId] = (dataItem || '').split(':');
  const item = itemDef(slot, itemId);
  if (!item) return;

  if (isOwned(slot, itemId)) {
    // already owned → equip it (no-op if already equipped).
    if (save.equipped[slot] !== itemId) {
      save.equipped[slot] = itemId;
      saveSave();
      playEquip();
      liveUpdateEquip();
      renderShop();
    }
    return;
  }

  // not owned → buy if affordable, else nudge + "need X more".
  if (save.tokens >= item.price) {
    save.tokens -= item.price;
    save.owned.push(slot + ':' + itemId);
    save.equipped[slot] = itemId; // auto-equip on buy
    saveSave();
    playBuy();
    liveUpdateEquip();
    renderShop();
    countUpBalance();
  } else {
    const need = item.price - save.tokens;
    if (cardEl) {
      cardEl.classList.remove('nudge');
      void cardEl.offsetWidth;
      cardEl.classList.add('nudge');
    }
    showToast(`Need ${need} more 🪙`, 1300);
    tone(180, 0, 0.18, 'square', 0.07);
  }
}

// Push the freshly-equipped config to the in-world figure/trail + the hero.
function liveUpdateEquip() {
  const eq = currentEquip();
  if (window.Flight) {
    if (Flight.setEquip) Flight.setEquip(eq);
    if (Flight.renderHero) Flight.renderHero(eq); // instant re-render on the preview
  }
  renderTitle();
}

// Animate the shop balance counting to the current value (count-up juice).
let balanceAnim = null;
function countUpBalance() {
  const bal = document.getElementById('shop-balance');
  if (!bal) return;
  cancelAnimationFrame(balanceAnim);
  // parse the current displayed number
  const target = save.tokens;
  let shown = parseInt((bal.textContent || '').replace(/[^0-9]/g, ''), 10);
  if (!Number.isFinite(shown)) shown = target;
  const start = performance.now();
  const from = shown;
  const dur = 450;
  function step(now) {
    const t = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - t, 3);
    const v = Math.round(from + (target - from) * eased);
    bal.textContent = `🪙 ${v}`;
    if (t < 1) balanceAnim = requestAnimationFrame(step);
  }
  balanceAnim = requestAnimationFrame(step);
}

/* ============================================================
   SECTION 9 — confetti (reuse maths pattern on #confetti)
   ============================================================ */

function launchConfetti(count = 200, duration = 4200) {
  const canvas = document.getElementById('confetti');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const colors = ['#fbbf24', '#34d399', '#60a5fa', '#f472b6', '#a78bfa', '#ff8a1a', '#fff'];
  const pieces = [];
  for (let i = 0; i < count; i++) {
    pieces.push({
      x: Math.random() * canvas.width,
      y: -20 - Math.random() * canvas.height * 0.5,
      w: 6 + Math.random() * 8,
      h: 8 + Math.random() * 10,
      vx: (Math.random() - 0.5) * 2.4,
      vy: 2.2 + Math.random() * 3.4,
      rot: Math.random() * Math.PI,
      vrot: (Math.random() - 0.5) * 0.25,
      color: colors[Math.floor(Math.random() * colors.length)],
    });
  }
  const start = performance.now();
  function frame(now) {
    const t = now - start;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of pieces) {
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vrot;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (t < duration) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  requestAnimationFrame(frame);
}

/* ============================================================
   SECTION 10 — input wiring (delegated clicks + menu keyboard)
   ============================================================ */

function quitToTitle() {
  if (runState) runState.ended = true;
  runState = null;
  if (window.Flight && Flight.stop) Flight.stop();
  renderTitle();
  showScreen('title');
}

function playAgain() {
  startRun();
}

document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;

  switch (action) {
    case 'play':
      unlockAudio();
      startRun();
      break;
    case 'open-shop':
      openShop();
      break;
    case 'shop-back':
      if (window.Flight && Flight.stopHero) Flight.stopHero();
      renderTitle();
      showScreen('title');
      break;
    case 'play-again':
      playAgain();
      break;
    case 'quit':
      quitToTitle();
      break;
    case 'toggle-sound':
      soundOn = !soundOn;
      save.soundOn = soundOn;
      saveSave();
      updateSoundButtons();
      if (soundOn) { unlockAudio(); playEquip(); }
      break;
    case 'shop-card':
      onShopCard(target.dataset.item, target);
      break;
    default:
      break;
  }
});

// MENU-only keyboard handler. In-flight steering keys (arrows/WASD) belong to
// flight.js — we deliberately do NOT touch them, and skip entirely while the
// game screen is up so we never swallow steering input.
document.addEventListener('keydown', (e) => {
  if (currentScreen === 'game') return; // steering is flight.js's job

  const key = e.key;
  if (key === 'Escape') {
    // Esc backs out of shop/results to the title.
    if (currentScreen === 'shop') {
      if (window.Flight && Flight.stopHero) Flight.stopHero();
      renderTitle();
      showScreen('title');
      e.preventDefault();
    } else if (currentScreen === 'win' || currentScreen === 'gameover') {
      quitToTitle();
      e.preventDefault();
    }
    return;
  }

  if (key === ' ' || key === 'Enter' || key === 'Spacebar') {
    // Space/Enter = the primary action of the current screen.
    if (currentScreen === 'title') { unlockAudio(); startRun(); e.preventDefault(); }
    else if (currentScreen === 'win' || currentScreen === 'gameover') { playAgain(); e.preventDefault(); }
    // (shop has no single primary action — ignore.)
  }
});

// Resize the confetti canvas with the window so it always covers the screen.
window.addEventListener('resize', () => {
  const c = document.getElementById('confetti');
  if (c) { c.width = window.innerWidth; c.height = window.innerHeight; }
});

/* ============================================================
   SECTION 11 — boot
   ============================================================ */

function boot() {
  // 1) figure factory + save are already defined (StickFigure above; save now).
  loadSave();

  // 2) init the engine with the two canvases (contract: app.js calls this once).
  const sceneCanvas = document.getElementById('scene');
  const heroCanvas = document.getElementById('hero-canvas');
  if (window.Flight && Flight.init) {
    Flight.init({ sceneCanvas, heroCanvas });
  }

  // 3) wire engine callbacks → economy/persistence/UI.
  if (window.Flight) {
    if (Flight.onProgress) Flight.onProgress(onProgress);
    if (Flight.onWin) Flight.onWin(onWin);
    if (Flight.onCrash) Flight.onCrash(onCrash);
  }

  // 4) the boom SFX belongs to the moment of impact, but onCrash only fires
  // after the ragdoll settles (~2.5s later). The engine owns the impact frame;
  // it has no SFX. We hook a one-shot boom by listening for the crash callback's
  // sibling: the engine fires onProgress with progress frozen, so instead we
  // expose a tiny impact hook the engine may call if present.
  window.__sfPlayBoom = playBoom;        // engine may call on impact frame
  window.__sfPlayNearMiss = playNearMiss; // (near-miss already handled via onProgress)

  // 5) first paint.
  renderTitle();
  showScreen('title');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

// Service worker registration (mirrors maths; index.html may also do this —
// registering twice is harmless and keeps offline working if the inline tag is
// ever dropped).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  });
}
