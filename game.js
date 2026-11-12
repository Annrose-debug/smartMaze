(() => {
'use strict';

/* ---------- Constants & helpers ---------- */
const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];           // up, right, down, left
const KEYMAP = { ArrowUp: 0, KeyW: 0, ArrowRight: 1, KeyD: 1, ArrowDown: 2, KeyS: 2, ArrowLeft: 3, KeyA: 3 };
const PLAYER_SPEED = 5.5;                                   // cells per second
const $ = id => document.getElementById(id);
const ui = Object.fromEntries(['level', 'score', 'grid', 'time', 'aiSpeed', 'aiPrec', 'pDist', 'aDist', 'pBar', 'aBar',
  'inputState', 'overlay', 'ovTitle', 'ovText', 'ovBtn'].map(id => [id, $(id)]));

/* ---------- Level scaling ---------- */
const gridSize = lvl => Math.min(41, 9 + 4 * (lvl - 1));                 // 9, 13, 17, ...
const aiSpeedFor = lvl => Math.min(4.2, 1.8 + 0.25 * (lvl - 1));         // cells/sec
const aiPrecisionFor = lvl => Math.min(0.98, 0.72 + 0.05 * (lvl - 1));   // chance of taking the optimal step
const aiDelayFor = lvl => Math.max(0.8, 2.5 - 0.15 * lvl);               // head-start for the player

/* ---------- Maze generation (randomized DFS / recursive backtracker) ---------- */
function generateMaze(n) {
  const g = Array.from({ length: n }, () => Array(n).fill(1));           // 1 = wall, 0 = floor
  const stack = [[1, 1]];
  g[1][1] = 0;
  while (stack.length) {
    const [x, y] = stack[stack.length - 1];
    const options = DIRS.map(([dx, dy]) => [x + dx * 2, y + dy * 2, dx, dy])
      .filter(([nx, ny]) => nx > 0 && ny > 0 && nx < n - 1 && ny < n - 1 && g[ny][nx] === 1);
    if (!options.length) { stack.pop(); continue; }                      // dead end: backtrack
    const [nx, ny, dx, dy] = options[Math.random() * options.length | 0];
    g[y + dy][x + dx] = 0;                                               // knock down wall between
    g[ny][nx] = 0;                                                       // carve the new cell
    stack.push([nx, ny]);
  }
  // Open a few extra passages so there are shortcuts and the AI has real routing choices.
  for (let i = 0, tries = n * 3; i < tries; i++) {
    const x = 1 + (Math.random() * (n - 2) | 0), y = 1 + (Math.random() * (n - 2) | 0);
    const horiz = g[y][x - 1] === 0 && g[y][x + 1] === 0 && g[y - 1][x] === 1 && g[y + 1][x] === 1;
    const vert = g[y - 1][x] === 0 && g[y + 1][x] === 0 && g[y][x - 1] === 1 && g[y][x + 1] === 1;
    if (g[y][x] === 1 && (horiz || vert) && Math.random() < 0.5) g[y][x] = 0;
  }
  return g;
}

function bfs(g, sx, sy) {                                                // distance map from a cell
  const n = g.length, d = Array.from({ length: n }, () => Array(n).fill(-1));
  const q = [[sx, sy]]; d[sy][sx] = 0;
  for (let i = 0; i < q.length; i++) {
    const [x, y] = q[i];
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (g[ny][nx] === 0 && d[ny][nx] < 0) { d[ny][nx] = d[y][x] + 1; q.push([nx, ny]); }
    }
  }
  return d;
}

/* ---------- Three.js scene ---------- */
const renderer = new THREE.WebGLRenderer({ canvas: $('scene'), antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0f19);
scene.fog = new THREE.Fog(0x0b0f19, 30, 90);
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
scene.add(new THREE.AmbientLight(0x6677aa, 0.7));
const sun = new THREE.DirectionalLight(0xffffff, 0.45); sun.position.set(10, 30, 10); scene.add(sun);

function makeActor(geo, color, lightColor) {
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.9, roughness: 0.3 }));
  const light = new THREE.PointLight(lightColor, 1.1, 7);
  mesh.add(light); scene.add(mesh);
  return { mesh, gx: 1, gy: 1, fx: 1, fy: 1, tx: 1, ty: 1, t: 1, moving: false, prev: null };
}
const player = makeActor(new THREE.SphereGeometry(0.32, 24, 24), 0x3aa0ff, 0x3aa0ff);
const ai = makeActor(new THREE.BoxGeometry(0.55, 0.55, 0.55), 0xb45cff, 0xb45cff);
const core = makeActor(new THREE.OctahedronGeometry(0.38), 0xffc83a, 0xffc83a);

/* ---------- Game state ---------- */
let state = 'menu';                       // menu | playing | won | lost
let level = 1, score = 0, n = 9;
let maze, distToCore, startDist, mazeGroup = null;
let coreCell = [1, 1], elapsed = 0, precision = 0.7, aiSpeed = 3, aiDelay = 1;
const held = [];

const worldX = gx => gx - n / 2 + 0.5;
const open = (x, y) => maze[y] && maze[y][x] === 0;

/* ---------- Build / cleanup of 3D maze ---------- */
function disposeMaze() {
  if (!mazeGroup) return;
  mazeGroup.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
  });
  scene.remove(mazeGroup);
  mazeGroup = null;
}

function buildMazeMesh() {
  disposeMaze();                                                         // remove old walls first
  mazeGroup = new THREE.Group();
  const wallGeo = new THREE.BoxGeometry(1, 1, 1);
  const edgeGeo = new THREE.EdgesGeometry(wallGeo);
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x13244a, emissive: 0x081633, roughness: 0.6 });
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x2ad4ff, transparent: true, opacity: 0.55 });

  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (maze[y][x] !== 1) continue;
    const wall = new THREE.Mesh(wallGeo, wallMat);
    wall.position.set(worldX(x), 0.5, worldX(y));
    wall.add(new THREE.LineSegments(edgeGeo, edgeMat));
    mazeGroup.add(wall);
  }
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(n, n), new THREE.MeshStandardMaterial({ color: 0x0d1424, roughness: 0.9 }));
  floor.rotation.x = -Math.PI / 2;
  const grid = new THREE.GridHelper(n, n, 0x1e3a5f, 0x14233a);
  grid.position.y = 0.01;
  mazeGroup.add(floor, grid);
  scene.add(mazeGroup);

  const d = n * 1.15;
  camera.position.set(0, d * 0.95, d * 0.75);
  camera.lookAt(0, 0, 0);
}

/* ---------- Level setup ---------- */
function startLevel() {
  n = gridSize(level);
  maze = generateMaze(n);
  buildMazeMesh();

  // Pick a core cell from the farthest 30% of reachable cells.
  const fromStart = bfs(maze, 1, 1);
  const cells = [];
  let max = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (fromStart[y][x] > 0) { cells.push([x, y]); max = Math.max(max, fromStart[y][x]); }
  const far = cells.filter(([x, y]) => fromStart[y][x] >= max * 0.7);
  coreCell = far[Math.random() * far.length | 0];
  distToCore = bfs(maze, coreCell[0], coreCell[1]);
  startDist = distToCore[1][1];

  for (const a of [player, ai]) Object.assign(a, { gx: 1, gy: 1, fx: 1, fy: 1, tx: 1, ty: 1, t: 1, moving: false, prev: null });
  held.length = 0;
  elapsed = 0;
  precision = aiPrecisionFor(level);
  aiSpeed = aiSpeedFor(level);
  aiDelay = aiDelayFor(level);
  state = 'playing';
  hideOverlay();
  updateHud();
}

/* ---------- Movement ---------- */
function startMove(e, x, y) { e.fx = e.gx; e.fy = e.gy; e.tx = x; e.ty = y; e.t = 0; e.moving = true; }

function advance(e, dt, speed) {                                          // returns true when a cell is reached
  if (!e.moving) return false;
  e.t += speed * dt;
  if (e.t < 1) return false;
  e.t = 1; e.moving = false; e.gx = e.tx; e.gy = e.ty;
  return true;
}

function aiChoose() {
  const nb = DIRS.map(([dx, dy]) => [ai.gx + dx, ai.gy + dy]).filter(([x, y]) => open(x, y));
  let pick;
  if (Math.random() < precision) {                                        // optimal step: lowest distance-to-core
    pick = nb.reduce((a, b) => distToCore[b[1]][b[0]] < distToCore[a[1]][a[0]] ? b : a);
  } else {                                                                // mistake: random non-backtracking step
    const alt = nb.filter(([x, y]) => !(ai.prev && x === ai.prev[0] && y === ai.prev[1]));
    const pool = alt.length ? alt : nb;
    pick = pool[Math.random() * pool.length | 0];
  }
  ai.prev = [ai.gx, ai.gy];
  startMove(ai, pick[0], pick[1]);
}

function place(e, bob = 0) {
  const x = e.fx + (e.tx - e.fx) * e.t, y = e.fy + (e.ty - e.fy) * e.t;
  e.mesh.position.set(worldX(x), 0.4 + bob, worldX(y));
}

/* ---------- Win / loss ---------- */
function atCore(e) { return e.gx === coreCell[0] && e.gy === coreCell[1]; }

function finish(playerWon) {
  if (playerWon) {
    const bonus = Math.max(0, Math.round(200 - elapsed * 5));
    const gained = 100 * level + bonus;
    score += gained;
    state = 'won';
    showOverlay('Core captured', `+${gained} points (${bonus} speed bonus). Next maze: ${gridSize(level + 1)}×${gridSize(level + 1)} with a faster AI.`, 'Next level');
  } else {
    state = 'lost';
    showOverlay('The AI got there first', `You reached level ${level} with ${score} points. Restarting returns to a 9×9 maze.`, 'Try again');
  }
  updateHud();
}

function showOverlay(title, text, btn) { ui.ovTitle.textContent = title; ui.ovText.textContent = text; ui.ovBtn.textContent = btn; ui.overlay.classList.remove('hidden'); }
function hideOverlay() { ui.overlay.classList.add('hidden'); }

function onButton() {
  if (state === 'menu') startLevel();
  else if (state === 'won') { level++; startLevel(); }
  else if (state === 'lost') { level = 1; score = 0; startLevel(); }
}

/* ---------- HUD ---------- */
function updateHud() {
  ui.level.textContent = level;
  ui.score.textContent = score;
  ui.grid.textContent = `${n}×${n}`;
  ui.time.textContent = elapsed.toFixed(1) + 's';
  ui.aiSpeed.textContent = aiSpeed.toFixed(1) + ' c/s';
  ui.aiPrec.textContent = Math.round(precision * 100) + '%';
  const pd = distToCore[player.gy][player.gx], ad = distToCore[ai.gy][ai.gx];
  ui.pDist.textContent = pd; ui.aDist.textContent = ad;
  ui.pBar.style.width = (100 * (1 - pd / startDist)) + '%';
  ui.aBar.style.width = (100 * (1 - ad / startDist)) + '%';
}

/* ---------- Input ---------- */
const KEY_FALLBACK = { ArrowUp: 0, w: 0, W: 0, ArrowRight: 1, d: 1, D: 1, ArrowDown: 2, s: 2, S: 2, ArrowLeft: 3, a: 3, A: 3 };
const dirOf = e => (e.code in KEYMAP) ? KEYMAP[e.code] : KEY_FALLBACK[e.key];   // works on any keyboard layout

function onKeyDown(e) {
  const d = dirOf(e);
  if (d !== undefined) {
    e.preventDefault();
    ui.inputState.textContent = 'received ' + e.key;
    if (!held.includes(d)) held.push(d);
  } else if ((e.code === 'Enter' || e.key === 'Enter') && state !== 'playing') {
    e.preventDefault();
    onButton();
  }
}
function onKeyUp(e) {
  const d = dirOf(e);
  if (d !== undefined) { const i = held.indexOf(d); if (i >= 0) held.splice(i, 1); }
}
const seen = new WeakSet();                                  // listen everywhere (capture phase), handle each event once
const once = fn => e => { if (seen.has(e)) return; seen.add(e); fn(e); };
for (const target of [window, document, document.body]) {
  target.addEventListener('keydown', once(onKeyDown), true);
  target.addEventListener('keyup', once(onKeyUp), true);
}
document.addEventListener('pointerdown', () => { window.focus(); document.body.focus(); ui.inputState.textContent = 'keys ready'; }, true);
window.addEventListener('focus', () => { ui.inputState.textContent = 'keys ready'; });
window.addEventListener('blur', () => { held.length = 0; ui.inputState.textContent = 'click the game to enable keys'; });   // avoid stuck keys when the tab loses focus
document.querySelectorAll('.dpad button').forEach(b => {              // on-screen D-pad (mouse or touch)
  const d = +b.dataset.dir;
  const press = e => { e.preventDefault(); ui.inputState.textContent = 'received D-pad'; if (!held.includes(d)) held.push(d); };
  const release = () => { const i = held.indexOf(d); if (i >= 0) held.splice(i, 1); };
  b.addEventListener('pointerdown', press);
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(t => b.addEventListener(t, release));
});
ui.ovBtn.addEventListener('click', () => { window.focus(); document.body.focus(); ui.ovBtn.blur(); onButton(); });
document.body.tabIndex = 0;
window.focus();

/* ---------- Main loop ---------- */
const clock = new THREE.Clock();
function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05), time = clock.elapsedTime;

  if (state === 'playing') {
    elapsed += dt;

    if (!player.moving && held.length) {                                  // player: start a move toward the latest held key
      const [dx, dy] = DIRS[held[held.length - 1]];
      if (open(player.gx + dx, player.gy + dy)) startMove(player, player.gx + dx, player.gy + dy);
      else ui.inputState.textContent = 'wall that way, try another direction';
    }
    if (!ai.moving && elapsed >= aiDelay) aiChoose();

    const pArrived = advance(player, dt, PLAYER_SPEED);
    const aArrived = advance(ai, dt, aiSpeed);
    if (pArrived && atCore(player)) finish(true);                         // player wins ties
    else if (aArrived && atCore(ai)) finish(false);
    updateHud();
  }

  place(player); place(ai);
  ai.mesh.rotation.y += dt * 2; ai.mesh.rotation.x += dt;
  core.mesh.position.set(worldX(coreCell[0]), 0.55 + Math.sin(time * 2.5) * 0.12, worldX(coreCell[1]));
  core.mesh.rotation.y += dt * 1.5;
  camera.position.x = Math.sin(time * 0.2) * n * 0.06;
  camera.lookAt(0, 0, 0);
  renderer.render(scene, camera);
}

/* ---------- Boot: generate a backdrop maze behind the start overlay ---------- */
resize();
n = gridSize(1); maze = generateMaze(n); buildMazeMesh();
const d0 = bfs(maze, 1, 1); coreCell = [n - 2, n - 2];
distToCore = bfs(maze, coreCell[0], coreCell[1]); startDist = Math.max(1, d0[n - 2][n - 2]);
updateHud();
loop();
})();0