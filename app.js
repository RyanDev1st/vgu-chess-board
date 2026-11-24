// Analysis board, lichess-style: legal moves only, move tree with variations, Stockfish eval bar + best line +
// blue engine arrow, right-drag arrows (knight jumps drawn as an L), edit-position mode, and "scan a camera"
// (ChessQ Lite, reader.worker.mjs).
// Sharing: both commentator laptops and the stream's copy (?view=stage inside stage.html, in OBS) join one private
// VDO.Ninja data room (sync.js) and show the same document: moves, current move, arrows, flip, stream layout.
import { Chessground } from './lib/chessground.min.js';
import { Chess, normalizeMove, parseFen, makeFen, INITIAL_FEN, makeSan, parseUci, chessgroundDests } from './lib/chessops.js';
import { roomConfig, joinRoom, loginWithPassword } from './sync.js';

const Q = new URLSearchParams(location.search), VIEW = Q.has('view'), STAGE = Q.get('view') === 'stage', DESK = Q.has('desk');   // desk: the tech desk's board tab
const LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1';   // the stream machine (OBS is here)
const CAMS = [['Cam 1 (Room 1)', 'Room 1 · H1-518'], ['Cam 2 (Room 2)', 'Room 2 · H1-519'],
              ['Cam 3 (Room 3)', 'Room 3 · H1-520'], ['Cam 4 (Top board)', 'Top board']];
const ROLES = ['king', 'queen', 'rook', 'bishop', 'knight', 'pawn'];
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
// the stream layout is shared as three small sections, so pressing different buttons at the same moment never clashes
const STAGE_PARTS = { sMain: ['main', 'onBreak', 'info'], sCam: ['cam'], sPip: ['pip'] };   // info: which big-screen view is on stream
const stageOf = doc => { const st = {}; let any = false;
  for (const [k, fields] of Object.entries(STAGE_PARTS)) if (doc[k]) { any = true; for (const f of fields) if (f in doc[k]) st[f] = doc[k][f]; }
  return any ? st : null; };
const posOf = fen => Chess.fromSetup(parseFen(fen).unwrap()).unwrap();
const plyOf = fen => { const p = fen.split(' '); return (Number(p[5] || 1) - 1) * 2 + (p[1] === 'b' ? 1 : 0); };

// ---------- shared: eval text / bar, move list ----------
const winPct = cp => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
function evalText(e) { if (!e) return ''; if (e.over) return e.over;
  if (e.mate != null) return e.mate > 0 ? `#${e.mate}` : `#-${-e.mate}`; const v = e.cp / 100; return (v > 0 ? '+' : '') + v.toFixed(1); }
function evalWhite(e) { if (!e) return 50; if (e.overWhite != null) return e.overWhite; if (e.mate != null) return e.mate > 0 ? 100 : 0; return winPct(e.cp); }
function setBar(bar, e, orientation, on) { bar.classList.toggle('off', !on); bar.classList.toggle('flip', orientation === 'black');
  bar.querySelector('.w').style.height = evalWhite(e) + '%'; }
const evalBar = () => { const b = h('div', 'evalbar'); b.append(h('div', 'w'), h('div', 'mid')); return b; };

// lichess-style mainline grid: "1. | e4 | e5", variations as indented blocks. rows: [{ply, san, id, vars:[[{ply,san,id}...]]}]
function renderMoveList(el, line, curId, onClick) {
  el.innerHTML = '';
  if (!line.length) { el.append(h('div', 'empty', 'No moves yet. Play a move on the board.')); return; }
  const grid = h('div', 'mainline'); el.append(grid);
  let open = false;                                   // a row has its white move but no black move yet
  const mv = (n, cls = 'm') => { const s = h('span', cls + (n.id === curId ? ' cur' : ''), n.san); if (onClick) s.onclick = () => onClick(n.id); return s; };
  const varText = (seq, box) => seq.forEach((n, i) => {
    if (n.ply % 2 === 1) box.append(h('span', 'vn', `${(n.ply + 1) / 2}.`));
    else if (i === 0) box.append(h('span', 'vn', `${n.ply / 2}...`));
    box.append(mv(n));
    for (const sub of n.vars || []) { box.append(document.createTextNode(' (')); varText(sub, box); box.append(document.createTextNode(') ')); }
  });
  for (const n of line) {
    const white = n.ply % 2 === 1;
    if (white) { grid.append(h('div', 'n', String((n.ply + 1) / 2)), mv(n)); open = true; }
    else { if (!open) grid.append(h('div', 'n', String(n.ply / 2)), h('span', 'm', '…')); grid.append(mv(n)); open = false; }
    if (n.vars && n.vars.length) {
      if (open) { grid.append(h('span', 'm', '')); open = false; }
      for (const v of n.vars) { const box = h('div', 'var'); varText(v, box); grid.append(box); }
    }
  }
  const c = el.querySelector('.cur');                  // scroll only the move list, never the page
  if (c) { const top = c.offsetTop - el.offsetTop; if (top < el.scrollTop || top > el.scrollTop + el.clientHeight - 30) el.scrollTop = top - el.clientHeight / 2; }
}
function lineFrom(n) { const out = []; let x = n;
  while (x) { const c = x.children; if (!c.length) break; const main = c[0];
    out.push({ ply: main.ply, san: main.san, id: main.id, vars: c.slice(1).map(v => [{ ply: v.ply, san: v.san, id: v.id, vars: [] }, ...lineFrom(v)]) }); x = main; }
  return out; }
function pathTo(cur) { const out = []; for (let x = cur; x && x.parent; x = x.parent) out.unshift({ ply: x.ply, san: x.san, id: x.id }); return out; }

// ---------- knight arrows drawn as an L (chess.com style) ----------
// Stored shapes are plain {orig, dest, brush}. On the board a knight jump becomes chessground's straight arrow in an
// invisible brush (so right-click erase still works) plus an L drawn with customSvg (a 100x100 box on the start square).
// Arrow / circle colours (2026-11-24, user: the green arrows vanished on the green board). chessground names its four drawing brushes
// green (plain right-drag), red (Shift or Ctrl), blue (Alt), yellow (Shift+Alt): we keep the names, but the colours are now
// orange, red, violet, yellow: none green, all solid. The engine's own arrow (paleBlue, laptop only) is translucent dark blue.
const BRUSH = { green: ['#ff6a00', 1, 10], red: ['#e0102a', 1, 10], blue: ['#9b30ff', 1, 10], yellow: ['#ffd800', 1, 10], paleBlue: ['#003088', .4, 15] };
const USER_BRUSHES = Object.fromEntries(Object.entries(BRUSH).map(([k, [color, opacity, lineWidth]]) => [k, { key: k, color, opacity, lineWidth }]));
const L_BRUSHES = Object.fromEntries(Object.keys(BRUSH).map(k => ['L' + k, { key: 'L' + k, color: BRUSH[k][0], opacity: .001, lineWidth: 10 }]));
const ALL_BRUSHES = { ...USER_BRUSHES, ...L_BRUSHES };
const fileOf = s => s.charCodeAt(0) - 97, rankOf = s => +s[1] - 1, sq = (f, r) => String.fromCharCode(97 + f) + (r + 1);
const knightJump = (o, d) => !!(o && d) && Math.abs(fileOf(o) - fileOf(d)) * Math.abs(rankOf(o) - rankOf(d)) === 2;
function lArrow(o, d, brush, orientation) {
  const [color, op, lw] = BRUSH[brush], s = orientation === 'black' ? -1 : 1;
  const dx = (fileOf(d) - fileOf(o)) * s * 100, dy = -(rankOf(d) - rankOf(o)) * s * 100, w = lw / 64 * 100;
  const start = [50, 50], end = [50 + dx, 50 + dy];
  const corner = Math.abs(dx) === 200 ? [50 + dx, 50] : [50, 50 + dy];          // the long leg first, then the turn
  const ux = Math.sign(end[0] - corner[0]), uy = Math.sign(end[1] - corner[1]);
  const tip = [end[0] - ux * 10, end[1] - uy * 10], base = [tip[0] - ux * w * 2.4, tip[1] - uy * w * 2.4], wing = [-uy * w * 1.9, ux * w * 1.9];
  const pts = a => a.map(p => p.map(v => v.toFixed(1)).join(',')).join(' ');
  return `<g opacity="${(.6 * op).toFixed(2)}"><polyline points="${pts([start, corner, base])}" fill="none" stroke="${color}" stroke-width="${w.toFixed(1)}" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<polygon points="${pts([tip, [base[0] + wing[0], base[1] + wing[1]], [base[0] - wing[0], base[1] - wing[1]]])}" fill="${color}"/></g>`;
}
const toCg = (shapes, orientation) => (shapes || []).map(s => knightJump(s.orig, s.dest) && BRUSH[s.brush]
  ? { orig: s.orig, dest: s.dest, brush: 'L' + s.brush, customSvg: { html: lArrow(s.orig, s.dest, s.brush, orientation) } } : s);
function fromCg(cgShapes, prev) {                    // back to plain shapes; drawing the same knight arrow again erases it
  const out = [];
  for (const s of cgShapes) {
    if (s.brush?.startsWith('L') && BRUSH[s.brush.slice(1)]) { out.push({ orig: s.orig, dest: s.dest, brush: s.brush.slice(1) }); continue; }
    if (knightJump(s.orig, s.dest) && prev.some(p => p.orig === s.orig && p.dest === s.dest && p.brush === s.brush)) continue;
    out.push(s.dest ? { orig: s.orig, dest: s.dest, brush: s.brush } : { orig: s.orig, brush: s.brush });
  }
  return out;
}

// ---------- the shared document: compact tree (parents first), rebuilt with chessops on every page ----------
function treeToDoc(root, cur, extra) {
  const nodes = [];
  (function walk(n) { for (const c of n.children) { nodes.push(c.shapes?.length ? [c.id, n.id, c.uci, c.shapes] : [c.id, n.id, c.uci]); walk(c); } })(root);
  return { rootFen: root.fen, rootId: root.id, rootShapes: root.shapes || [], nodes, cur: cur.id, ...extra };
}
function buildTree(doc) {
  const nodes = new Map();
  const root = { id: doc.rootId, fen: doc.rootFen, ply: plyOf(doc.rootFen), children: [], parent: null, shapes: doc.rootShapes || [] };
  nodes.set(root.id, root);
  for (const [id, pid, uci, shapes] of doc.nodes || []) {
    const parent = nodes.get(pid); if (!parent) continue;
    const pos = posOf(parent.fen), move = parseUci(uci); if (!move || !pos.isLegal(move)) continue;
    const norm = normalizeMove(pos, move), san = makeSan(pos, norm); pos.play(norm);
    const n = { id, fen: makeFen(pos.toSetup()), uci, san, ply: parent.ply + 1, parent, children: [], shapes: shapes || [] };
    parent.children.push(n); nodes.set(id, n);
  }
  return { root, nodes, cur: nodes.get(doc.cur) || root };
}

// ===================================================================== stream copy (read-only)
if (VIEW) view(); else laptop();

async function view() {
  // ?view=stage: just the eval bar + board, filling its frame (inside stage.html); ?view: the older full 1920x1080 page
  document.body.className = STAGE ? 'stagev' : 'view';
  const root = h('div'); root.id = 'view'; document.body.append(root);
  root.innerHTML = STAGE ? '<div class="board" id="vb"></div><div hidden><span id="where"></span><span id="dot"></span><span id="turn"></span><div id="veng"></div><div id="vev"></div><div id="vpv"></div><div id="vmoves"></div></div>'
    : `<div class="left"><div class="kicker">ANALYSIS</div><div class="where" id="where">Live board</div></div>
    <div class="board" id="vb"></div>
    <div class="right"><div class="turn"><span class="dot" id="dot"></span><span id="turn">White to move</span></div>
      <div class="veng" id="veng" hidden><div class="ev" id="vev"></div><div class="pv" id="vpv"></div></div>
      <div class="vmoves" id="vmoves"></div></div>`;
  const bar = evalBar(); root.prepend(bar);
  addEventListener('resize', () => document.body.dispatchEvent(new Event('chessground.resize')));
  const cg = Chessground(document.getElementById('vb'), { viewOnly: true, coordinates: true, animation: { duration: 220 },
    drawable: { enabled: false, visible: true, brushes: ALL_BRUSHES } });
  const $ = id => document.getElementById(id);
  let tree = null, doc = null, ev = null;
  function draw() {
    if (!tree) return;
    const cur = tree.cur, pos = posOf(cur.fen), turn = pos.turn, orientation = doc.orientation || 'white', engineOn = doc.engineOn !== false;
    cg.set({ fen: cur.fen, orientation, turnColor: turn, lastMove: cur.uci ? [cur.uci.slice(0, 2), cur.uci.slice(2, 4)] : undefined, check: pos.isCheck() ? turn : false });
    cg.setShapes(toCg(cur.shapes, orientation));      // the commentators' arrows; no engine arrow on stream
    const over = pos.isEnd() ? (pos.isCheckmate() ? 'Checkmate' : pos.isStalemate() ? 'Stalemate' : 'Draw') : null;
    const e = over ? { over, overWhite: pos.isCheckmate() ? (turn === 'white' ? 0 : 100) : 50 } : ev && ev.fen === cur.fen ? ev.e : null;
    setBar(bar, e, orientation, engineOn || !!over);
    $('where').textContent = doc.label || 'Live board';
    $('turn').textContent = over || (turn === 'black' ? 'Black to move' : 'White to move');
    $('dot').style.background = turn === 'black' ? '#111' : '#f4f4f4';
    $('veng').hidden = !engineOn; $('vev').textContent = evalText(e); $('vpv').textContent = ev && ev.fen === cur.fen ? ev.pv || '' : '';
    renderMoveList($('vmoves'), pathTo(cur).slice(-16), cur.id, null);
  }
  const { key } = await roomConfig();
  if (!key) { console.warn('board view: no room key (room.json)'); return; }
  const room = joinRoom(key, { role: 'obs',
    onDoc: d => { if (d.board && d.board !== doc) { try { doc = d.board; tree = buildTree(doc); draw(); } catch (err) { console.error(err); } }
      const st = stageOf(d); if (st && parent !== window) parent.postMessage({ stage: st }, location.origin); },   // stage.html: layout + Break
    onMsg: (m, from) => { if (m.t !== 'eval' || !tree || m.fen !== tree.cur.fen) return;   // two engines: keep the deeper line
      if (!ev || ev.fen !== m.fen || ev.from === from || (m.e?.depth || 0) >= (ev.e?.depth || 0)) { ev = { ...m, from }; draw(); } } });
  addEventListener('message', e => { if (e.origin === location.origin && e.data?.obsAck) room.send({ t: 'obs', ...e.data.obsAck }); });
  window.__view = { get doc() { return doc; }, room };
}

// ===================================================================== laptop page
async function laptop() {
  document.body.innerHTML = `<div id="app">
    <div class="evalbar" id="bar"><div class="w"></div><div class="mid"></div></div>
    <div id="boardBox"></div>
    <div id="panel">
      <div class="box stagebox">
        <h3 class="vs">WHAT VIEWERS SEE</h3>
        <div class="seg" id="mainSeg"><button data-main="board" title="S swaps board / camera">♟ Board</button><button data-main="feed">📷 Camera big</button><button data-main="grid">▦ All rooms</button><button data-main="info" title="Rooms, results and standings, full screen">🏆 Results</button><button data-main="break">☕ Break</button></div>
        <div class="seg" id="camSeg"><button data-cam="1">Room 1</button><button data-cam="2">Room 2</button><button data-cam="3">Room 3</button><button data-cam="4">Top</button></div>
        <div class="linkrow"><div class="link" id="link">Connecting to the stream…</div><button id="helpBtn" title="Quick guide">? Guide</button></div>
      </div>
      <div class="box">
        <div class="engine"><div class="switch on" id="engSw" title="Engine on/off (L)"></div><div class="ev" id="ev"></div><div class="info" id="engInfo">Stockfish 19</div></div>
        <div class="pv" id="pv"></div>
      </div>
      <div class="scanbar" id="scanbar" hidden></div>
      <div class="box moves" id="moves"></div>
      <div class="box nav"><button id="first" title="Start (↑)">⏮</button><button id="prev" title="Back (←)">◀</button>
        <button id="next" title="Forward (→)">▶</button><button id="last" title="End (↓)">⏭</button><button id="flip" title="Flip board (F)">⇅ Flip</button></div>
      <div class="box scan" id="scanBox">
        <h3>PUT A ROOM'S GAME ON THIS BOARD</h3>
        <div class="cams" id="cams"></div>
        <div class="hint">Or paste a photo here (<kbd>Ctrl</kbd>+<kbd>V</kbd>).</div>
        <canvas id="photo" width="390" height="0"></canvas>
        <div id="status">Loading the board reader…</div>
        <div class="row"><button id="editBtn" title="E">✏ Fix / set up position</button><button id="startBtn">↺ Start position</button></div>
      </div>
      <div class="box edit" id="editBox" hidden>
        <h3>EDIT POSITION</h3>
        <div class="spare cg-wrap" id="spare"></div>
        <div class="row fix"><span>Scan off by a square? Move everything:</span><button data-shift="-1,0" title="← key">◀</button><button data-shift="1,0" title="→ key">▶</button>
          <button data-shift="0,1" title="↑ key">▲</button><button data-shift="0,-1" title="↓ key">▼</button><button id="rotBtn" title="Turn the whole position around (R)">↻ 180°</button></div>
        <div class="hint">Add pieces: drag one onto the board, or click one here and then click squares (click it again to stop). Drag a piece off the board to remove it. Red = the scan wasn&rsquo;t sure.</div>
        <div class="row"><button id="turnBtn">White to move</button><button id="clearBtn">Clear board</button><button id="startEdit">Start position</button></div>
        <div class="row"><button class="primary" id="doneBtn">✓ Done</button><button id="cancelBtn">Cancel</button></div>
        <div id="editMsg" class="hint"></div>
      </div>
    </div></div>
    <div class="guide" id="access" hidden><div class="gcard">
      <h2>Join the commentary board</h2>
      <p>Type the commentator password. You only do this once on this laptop.</p>
      <div class="arow"><input id="accPw" type="password" autocomplete="off" placeholder="Commentator password"><button class="primary" id="accBtn">Join</button></div>
      <div id="accMsg" class="hint"></div>
      <button id="accSkip" class="small">Just practise (not shown on the stream)</button>
    </div></div>
    <div class="guide" id="guide" hidden><div class="gcard">
      <h2>How it works (30 seconds)</h2>
      <ol>
        <li><b>The top buttons choose what viewers see</b>: the board, a camera, all rooms, the results, or the break screen.</li>
        <li><b>To show a game</b>: press its room under <b>PUT A ROOM'S GAME ON THIS BOARD</b>. Wrong square? Press <b>✏ Fix / set up position</b>.</li>
        <li><b>To explain</b>: drag pieces to play moves. <b>Right-drag</b> draws an arrow. <kbd>←</kbd> <kbd>→</kbd> go back and forward.</li>
        <li>Everything you do is shown on the stream and on your co-commentator's laptop straight away.</li>
      </ol>
      <button class="primary" id="guideOk">Got it</button>
    </div></div>`;
  const $ = id => document.getElementById(id);
  // quick guide: opens by itself on a laptop's first visit, then with the "? Guide" button
  const guide = on => { $('guide').hidden = !on; if (!on) try { localStorage.setItem('guideSeen', '1'); } catch {} };
  $('helpBtn').onclick = () => guide(true); $('guideOk').onclick = () => guide(false);
  $('guide').onclick = e => { if (e.target.id === 'guide') guide(false); };
  addEventListener('keydown', e => { if (e.key === 'Escape' && !$('guide').hidden) guide(false); });
  // (the guide opens by itself once this laptop is in the room, see below)
  if (DESK) $('engSw').closest('.box').style.display = 'none';   // no engine on the desk copy (see engine below)
  const status = (t, cls = '') => { $('status').textContent = t; $('status').className = cls; };

  // ---------- room (shared with the other laptop and the stream) ----------
  const { key, cams: PH } = await roomConfig();             // PH + c1..c4 = the room cameras' VDO.Ninja stream IDs
  let room = null, applying = false, pendingDoc = null;
  const myId = Math.random().toString(36).slice(2, 7);
  if (key) room = joinRoom(key, { role: DESK ? 'desk' : 'laptop', onDoc: d => adopt(d), onMsg: (m) => onRoomMsg(m), onPeers: list => renderLink(list),
    onBadKey: () => { try { localStorage.removeItem('boardKey'); } catch {} askAccess('The password was changed. Type the new one.'); } });
  if (key) { try { if (!DESK && !localStorage.getItem('guideSeen')) guide(true); } catch {} }
  else askAccess();
  // no key on this laptop (or the key stopped working): one field, the commentator password. Right -> the key is saved here and the page reloads into the room.
  function askAccess(why = '') {
    $('access').hidden = false; $('accMsg').textContent = why;
    const msg = t => $('accMsg').textContent = t;
    const go = async () => {
      const pw = $('accPw').value.trim(); if (!pw) { msg('Type the password first.'); return $('accPw').focus(); }
      $('accBtn').disabled = true; msg('Checking…');
      const a = await loginWithPassword(pw);
      if (a.ok) { msg('Opening the board…'); setTimeout(() => location.reload(), 300); }
      else { $('accBtn').disabled = false; msg(a.msg); $('accPw').select(); }
    };
    $('accBtn').onclick = go; $('accPw').onkeydown = e => { if (e.key === 'Enter') go(); };
    $('accSkip').onclick = () => { $('access').hidden = true; };
    $('accPw').focus();
  }

  // ---------- state ----------
  let nid = 0, root, cur, orientation = 'white', mode = 'analysis', engineOn = true, pick = null;   // pick = tray piece chosen for click-to-place
  let label = 'Live board', unsure = [], editTurn = 'w', editBackup = null, analysedFen = null;
  const nodes = new Map();
  const mk = (fen, extra = {}) => { const n = { id: `${myId}.${++nid}`, fen, children: [], parent: null, shapes: [], ...extra }; nodes.set(n.id, n); return n; };
  function setRoot(fen) { nodes.clear(); root = mk(fen, { ply: plyOf(fen) }); cur = root; }

  // ---------- board ----------
  const cg = Chessground($('boardBox'), { coordinates: true, animation: { duration: 200 }, highlight: { lastMove: true, check: true },
    movable: { free: false, showDests: true, events: { after: onBoardMove } }, premovable: { enabled: false },
    draggable: { showGhost: true },
    drawable: { enabled: true, brushes: ALL_BRUSHES, onChange: shapes => { if (mode !== 'analysis') return;
      cur.shapes = fromCg(shapes, cur.shapes || []); cg.setShapes(toCg(cur.shapes, orientation)); commit(); } },
    events: { change: () => { if (mode === 'edit') { const t = cg.state.lastMove || []; unsure = unsure.filter(s => !t.includes(s)); markUnsure(); } },
      select: key => { if (mode === 'edit' && pick) {            // a tray piece is picked: each click puts one there
        cg.setPieces(new Map([[key, { color: pick.color, role: pick.role }]])); cg.selectSquare(null);
        unsure = unsure.filter(s => s !== key); markUnsure(); } } } });
  const markUnsure = () => cg.set({ highlight: { custom: new Map(unsure.map(s => [s, 'unsure'])) } });

  function show() {                                   // put the current node on the board
    document.querySelector('.promo')?.remove();
    const pos = posOf(cur.fen), turn = pos.turn;
    cg.set({ fen: cur.fen, orientation, turnColor: turn, lastMove: cur.uci ? [cur.uci.slice(0, 2), cur.uci.slice(2, 4)] : undefined,
      check: pos.isCheck() ? turn : false,
      movable: { free: false, showDests: true, color: pos.isEnd() ? undefined : turn, dests: pos.isEnd() ? new Map() : chessgroundDests(pos) },
      draggable: { deleteOnDropOff: false } });
    cg.setShapes(toCg(cur.shapes, orientation));
    if (cur !== root && unsure.length) { unsure = []; markUnsure(); }
    renderMoveList($('moves'), lineFrom(root), cur.id, id => go(nodes.get(id)));
    if (cur.fen !== analysedFen) { analysedFen = cur.fen; engine.analyse(cur.fen, pos); } else showEval();   // arrows only: keep searching
    commit();
  }
  function play(uci) {
    const pos = posOf(cur.fen), move = parseUci(uci);
    if (!move || !pos.isLegal(move)) return show();
    const found = cur.children.find(c => c.uci === uci);
    if (found) { cur = found; return show(); }
    const norm = normalizeMove(pos, move), san = makeSan(pos, norm);
    pos.play(norm);
    const child = mk(makeFen(pos.toSetup()), { uci, san, ply: cur.ply + 1, parent: cur });
    cur.children.push(child); cur = child; show();
  }
  function onBoardMove(orig, dest) {
    if (mode !== 'analysis') return;
    const piece = cg.state.pieces.get(dest);
    if (piece?.role === 'pawn' && (dest[1] === '8' || dest[1] === '1')) return promote(orig, dest, piece.color);
    play(orig + dest);
  }
  function promote(orig, dest, color) {
    const ov = h('div', 'promo'), row = h('div'); ov.append(row);
    for (const [role, ch] of [['queen', 'q'], ['knight', 'n'], ['rook', 'r'], ['bishop', 'b']]) {
      const p = h('piece', `${color} ${role}`); p.onclick = () => { ov.remove(); play(orig + dest + ch); }; row.append(p);
    }
    ov.onclick = e => { if (e.target === ov) { ov.remove(); show(); } };
    $('boardBox').classList.add('cg-wrap'); $('boardBox').append(ov);
  }

  // ---------- sharing: publish our changes, take the newest document from the room ----------
  // sections: 'board' (moves, arrows, flip, engine) and the three stream-layout parts, each newest-wins on its own
  const timers = {}, seen = {};
  function commit(section = 'board') {
    if (applying || timers[section] || (section === 'board' && mode !== 'analysis')) return;
    timers[section] = setTimeout(() => { timers[section] = null;
      const body = section === 'board' ? treeToDoc(root, cur, { orientation, label, engineOn }) : Object.fromEntries(STAGE_PARTS[section].map(f => [f, stage[f]]));
      const d = room ? room.publish(section, body, section !== 'board') : { ...local, [section]: body };
      local = d; seen[section] = d[section]; saveLocal(d); }, 60);
  }
  let local = {};
  const saveLocal = d => { try { localStorage.setItem('boardDoc2', JSON.stringify({ board: d.board, savedAt: Date.now() })); } catch {} };
  function adopt(all) {
    local = all; saveLocal(all);
    let st = false;
    for (const k of Object.keys(STAGE_PARTS)) if (all[k] && all[k] !== seen[k]) { seen[k] = all[k]; st = true; for (const f of STAGE_PARTS[k]) if (f in all[k]) stage[f] = all[k][f]; }
    if (st) renderStage();
    if (!all.board || all.board === seen.board) return;
    if (mode === 'edit') { pendingDoc = all; return; } // keep editing undisturbed; applied when the edit ends
    seen.board = all.board;
    const d = all.board;
    let t; try { t = buildTree(d); } catch (e) { console.error('bad shared board', e); return; }
    const newRoot = !root || t.root.id !== root.id;
    nodes.clear(); for (const [k, v] of t.nodes) nodes.set(k, v); root = t.root; cur = t.cur;
    orientation = d.orientation || 'white'; label = d.label || label;
    if (typeof d.engineOn === 'boolean' && d.engineOn !== engineOn) { engineOn = d.engineOn; $('engSw').classList.toggle('on', engineOn); analysedFen = null; if (!engineOn) engine.stop(); }
    if (newRoot && unsure.length) { unsure = []; markUnsure(); $('scanbar').hidden = true; }
    applying = true; try { show(); } finally { applying = false; }
  }

  // ---------- navigation ----------
  const go = n => { if (n && mode === 'analysis' && !document.querySelector('.promo')) { cur = n; show(); } };
  $('first').onclick = () => go(root); $('prev').onclick = () => go(cur.parent);
  $('next').onclick = () => go(cur.children[0]); $('last').onclick = () => { let x = cur; while (x.children[0]) x = x.children[0]; go(x); };
  $('flip').onclick = () => { orientation = orientation === 'white' ? 'black' : 'white'; cg.set({ orientation });
    if (mode === 'analysis') { cg.setShapes(toCg(cur.shapes, orientation)); showEval(); } else setBar($('bar'), null, orientation, false); commit(); };
  addEventListener('keydown', e => {
    if (e.target.closest('input,textarea') || e.ctrlKey || e.metaKey || e.altKey) return;   // leave Ctrl+L, Ctrl+F… to the browser
    const k = e.key;
    if (mode === 'edit') {                            // in the editor the arrow keys move the whole position
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[k];
      if (d) { e.preventDefault(); shiftAll(...d); } else if (k.toLowerCase() === 'r') rotateAll();
      return;
    }
    if (k === 'ArrowLeft') $('prev').click(); else if (k === 'ArrowRight') $('next').click();
    else if (k === 'ArrowUp') { e.preventDefault(); $('first').click(); } else if (k === 'ArrowDown') { e.preventDefault(); $('last').click(); }
    else if (k === 'f') $('flip').click(); else if (k === 'l') $('engSw').click(); else if (k === 'e' && mode === 'analysis') enterEdit();
  });
  // mouse wheel over the board steps through the moves, like lichess
  $('boardBox').addEventListener('wheel', e => { if (mode !== 'analysis') return; e.preventDefault(); if (e.deltaY > 0) $('next').click(); else $('prev').click(); }, { passive: false });

  // ---------- engine: Stockfish 19 lite (multi-threaded when the page is cross-origin isolated) ----------
  // The tech desk's copy (DESK) runs no engine: it sits on the stream laptop, next to OBS, and the commentators' laptops
  // already send their lines. Laptops: 2 threads, depth 18 (about 2-5 s): enough for the bar, leaves the laptop smooth.
  const engine = DESK ? { last: null, analyse() { showEval(); }, stop() {} } : (() => {
    const sf = new Worker(crossOriginIsolated ? 'lib/stockfish-19-lite.js' : 'lib/stockfish-19-lite-single.js');
    let ready = false, searching = false, pending = null, fen = null, turn = 'w', last = null;
    sf.onmessage = ({ data: line }) => {
      if (line === 'uciok') { if (crossOriginIsolated) sf.postMessage(`setoption name Threads value ${Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 2) - 2))}`);
        sf.postMessage('setoption name Hash value 64'); sf.postMessage('isready'); }
      else if (line === 'readyok') { ready = true; if (pending) start(); }
      else if (line.startsWith('bestmove')) { searching = false; if (pending) start(); }
      else if (line.startsWith('info') && line.includes(' pv ') && !line.includes('multipv 2') && !/bound/.test(line) && fen === cur.fen && engineOn && mode === 'analysis') {
        const t = line.split(' '), at = k => t[t.indexOf(k) + 1];
        const depth = +at('depth'), pv = t.slice(t.indexOf('pv') + 1), sign = turn === 'w' ? 1 : -1;
        const e = { depth, pv };
        if (t.includes('mate')) e.mate = sign * +at('mate'); else e.cp = sign * +at('cp');
        last = e; showEval();
      }
    };
    sf.postMessage('uci');
    function start() { if (!ready || !pending) return;
      if (searching) { sf.postMessage('stop'); return; }
      fen = pending; pending = null; turn = fen.split(' ')[1]; searching = true;
      sf.postMessage(`position fen ${fen}`); sf.postMessage('go depth 18'); }
    return {
      get last() { return last; },
      analyse(f, pos) {
        last = null;
        if (pos.isEnd()) { const o = pos.outcome(); last = o?.winner ? { over: 'Checkmate', overWhite: o.winner === 'white' ? 100 : 0 } : { over: pos.isStalemate() ? 'Stalemate' : 'Draw', overWhite: 50 };
          pending = null; if (searching) sf.postMessage('stop'); fen = null; showEval(); return; }   // fen=null: late lines of the old search are ignored
        showEval(); if (!engineOn) return; pending = f; start();
      },
      stop() { pending = null; if (searching) sf.postMessage('stop'); },
    };
  })();
  function pvSan(fen, pv, max = 10) {
    try { const pos = posOf(fen); let out = [], ply = plyOf(fen);
      for (const u of pv.slice(0, max)) { const m = parseUci(u); if (!m || !pos.isLegal(m)) break; const n = normalizeMove(pos, m);
        ply++; out.push((ply % 2 === 1 ? `${(ply + 1) / 2}. ` : out.length ? '' : `${ply / 2}... `) + makeSan(pos, n)); pos.play(n); }
      return out.join(' '); } catch { return ''; }
  }
  let lastPvText = '', evalTimer = null;
  function showEval() {
    if (mode !== 'analysis') return;
    const e = engine.last;
    $('ev').textContent = engineOn || e?.over ? evalText(e) : '';
    $('engInfo').textContent = !engineOn ? 'Engine off' : e?.over ? '' : e ? `Stockfish 19 · depth ${e.depth}` : 'Stockfish 19 · thinking…';
    lastPvText = engineOn && e?.pv ? pvSan(cur.fen, e.pv) : '';
    $('pv').textContent = lastPvText;
    cg.setAutoShapes(engineOn && e?.pv?.[0] ? toCg([{ orig: e.pv[0].slice(0, 2), dest: e.pv[0].slice(2, 4), brush: 'paleBlue' }], orientation) : []);
    setBar($('bar'), e, orientation, engineOn);
    if (room && engineOn && e && !e.over && !evalTimer) evalTimer = setTimeout(() => { evalTimer = null;   // the stream's eval bar
      const x = engine.last; if (x && mode === 'analysis') room.send({ t: 'eval', fen: cur.fen, e: { depth: x.depth, cp: x.cp, mate: x.mate }, pv: lastPvText }); }, 300);
  }
  $('engSw').onclick = () => { engineOn = !engineOn; $('engSw').classList.toggle('on', engineOn); analysedFen = null;
    if (engineOn && mode === 'analysis') { analysedFen = cur.fen; engine.analyse(cur.fen, posOf(cur.fen)); } else { engine.stop(); showEval(); } commit(); };

  // ---------- what the stream shows (stage.html): board big / camera big / all rooms / break ----------
  let stage = { main: 'grid', cam: 4, pip: true, onBreak: false }, obsAck = null, ackTimer = null, peers = [];
  function renderStage() {
    document.querySelectorAll('#mainSeg button').forEach(b => {
      b.classList.toggle('on', b.dataset.main === 'break' ? !!stage.onBreak : !stage.onBreak && b.dataset.main === stage.main);
      const failed = obsAck && obsAck.onBreak === !!stage.onBreak && !obsAck.ok && (b.dataset.main === 'break') === !!stage.onBreak;
      b.classList.toggle('fail', !!failed); b.title = failed ? 'OBS did not switch scene: is OBS open on the stream laptop? Press again.' : '';
    });
    document.querySelectorAll('#camSeg button[data-cam]').forEach(b => b.classList.toggle('on', +b.dataset.cam === stage.cam));
  }
    function renderLink(list = peers) {
    peers = list;
    const el = $('link'); if (!room) { el.innerHTML = '⚠ Not on the stream yet. <button id="linkBtn">Enter the password</button>'; el.className = 'link bad';
      $('linkBtn').onclick = () => askAccess(); return; }
    const obs = list.some(p => p.role === 'obs'), mates = list.filter(p => p.role === 'laptop').length;
    el.textContent = (obs ? '✓ On the stream' : '⚠ Not on the stream: viewers do not see this board yet') + (obs && mates ? ` · your co-commentator is here too` : '');
    el.className = 'link' + (obs ? '' : ' bad');
  }
  function onRoomMsg(m) { if (m.t === 'obs') { obsAck = { onBreak: !!m.onBreak, ok: !!m.ok }; clearTimeout(ackTimer); renderStage(); } }
  function setMain(m) {
    const wasBreak = !!stage.onBreak;
    if (m === 'break') stage.onBreak = true; else { stage.main = m; stage.onBreak = false; }
    renderStage(); commit('sMain');
    if (wasBreak !== stage.onBreak) {                 // a scene change: the stream laptop confirms it, or the button turns red
      obsAck = null; clearTimeout(ackTimer);
      ackTimer = setTimeout(() => { if (!obsAck) { obsAck = { onBreak: !!stage.onBreak, ok: false }; renderStage(); } }, 5000);
    }
  }
  const setCam = n => { stage.cam = n; renderStage(); commit('sCam'); };
  document.querySelectorAll('#mainSeg button').forEach(b => b.onclick = () => setMain(b.dataset.main));
  document.querySelectorAll('#camSeg button[data-cam]').forEach(b => b.onclick = () => setCam(+b.dataset.cam));
  addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || mode === 'edit') return;   // holding a key must not flip the stream back and forth
    if (e.key.toLowerCase() === 's') setMain(stage.main === 'board' && !stage.onBreak ? 'feed' : 'board');
    else if (/^[1-4]$/.test(e.key)) setCam(+e.key);
  });

  // ---------- edit position (lichess editor style) ----------
  // tray: drag a piece onto the board, or click it and then click squares (click it again to stop)
  for (const color of ['white', 'black']) for (const role of ROLES) {
    const p = h('piece', `${color} ${role}`);
    const drag = e => { if (mode !== 'edit') return; e.preventDefault(); cg.dragNewPiece({ color, role }, e, true); };
    p.addEventListener('mousedown', drag); p.addEventListener('touchstart', drag, { passive: false });
    p.addEventListener('click', () => setPick(pick && pick.el === p ? null : { color, role, el: p }));
    $('spare').append(p);
  }
  function setPick(x) { pick = x; document.querySelectorAll('#spare piece').forEach(el => el.classList.toggle('picked', !!x && x.el === el)); }
  function enterEdit(placement = cur.fen.split(' ')[0], turn = cur.fen.split(' ')[1], msg = '') {
    document.querySelector('.promo')?.remove();
    if (mode !== 'edit') editBackup = { root, cur, label, nodes: new Map(nodes) };
    mode = 'edit'; editTurn = turn; engine.stop(); analysedFen = null; $('scanbar').hidden = true;
    $('turnBtn').textContent = editTurn === 'w' ? 'White to move' : 'Black to move';
    $('scanBox').hidden = true; $('editBox').hidden = false; $('app').classList.add('editing'); $('editMsg').textContent = msg; $('editMsg').style.color = msg ? '#ff9b9b' : '';
    cg.set({ fen: placement, lastMove: undefined, check: false, movable: { free: true, color: 'both', dests: undefined, showDests: false },
      draggable: { deleteOnDropOff: true } });
    cg.setShapes([]); cg.setAutoShapes([]); setBar($('bar'), null, orientation, false); $('ev').textContent = ''; $('pv').textContent = '';
    $('engInfo').textContent = 'Editing (the stream keeps the last position until Done)'; markUnsure();
  }
  // quick fixes for a scan that came out a square off, or upside down (directions as seen on screen)
  function remap(fn) {
    const diff = new Map(), moved = new Map();
    for (const [k, p] of cg.state.pieces) { const to = fn(fileOf(k), rankOf(k)); if (to) moved.set(sq(...to), p); }
    for (let f = 0; f < 8; f++) for (let r = 0; r < 8; r++) diff.set(sq(f, r), moved.get(sq(f, r)));
    cg.setPieces(diff); unsure = []; markUnsure();
  }
  function shiftAll(dx, dy) {
    const s = orientation === 'black' ? -1 : 1, df = dx * s, dr = dy * s;
    remap((f, r) => (f + df >= 0 && f + df < 8 && r + dr >= 0 && r + dr < 8) ? [f + df, r + dr] : null);
  }
  const rotateAll = () => remap((f, r) => [7 - f, 7 - r]);
  document.querySelectorAll('#editBox [data-shift]').forEach(b => b.onclick = () => shiftAll(...b.dataset.shift.split(',').map(Number)));
  $('rotBtn').onclick = rotateAll;
  // castling rights guessed from where kings and rooks stand (a photo can't tell more)
  function fenFrom(placement, turn) {
    const rows = placement.split('/').map(r => r.replace(/\d/g, n => '.'.repeat(n))), at = (f, r) => rows[8 - r]?.[f.charCodeAt(0) - 97];
    let c = '';
    if (at('e', 1) === 'K') { if (at('h', 1) === 'R') c += 'K'; if (at('a', 1) === 'R') c += 'Q'; }
    if (at('e', 8) === 'k') { if (at('h', 8) === 'r') c += 'k'; if (at('a', 8) === 'r') c += 'q'; }
    return `${placement} ${turn} ${c || '-'} - 0 1`;
  }
  const WHY = { ERR_KINGS: 'Each side needs exactly one king.', ERR_OPPOSITE_CHECK: 'The side NOT to move is in check: switch who is to move.',
    ERR_PAWNS_ON_BACKRANK: 'There is a pawn on the first or last rank.', ERR_EMPTY: 'The board is empty.' };
  function legal(fen) { const s = parseFen(fen); if (s.isErr) return 'Bad position.'; const p = Chess.fromSetup(s.value); return p.isErr ? (WHY[p.error.message] || 'Not a legal position.') : null; }
  function leaveEdit(fen) {
    mode = 'analysis'; $('scanBox').hidden = false; $('editBox').hidden = true; $('app').classList.remove('editing'); setPick(null);
    if (fen) { setRoot(fen); pendingDoc = null; }      // our new position is the newest edit: it wins over what arrived meanwhile
    else { ({ root, cur, label } = editBackup); nodes.clear(); for (const [k, v] of editBackup.nodes) nodes.set(k, v); }
    show(); renderStage();
    if (!fen && pendingDoc) { const d = pendingDoc; pendingDoc = null; seen.board = null; adopt(d); }   // Cancel: catch up with the other laptop
  }
  $('turnBtn').onclick = () => { editTurn = editTurn === 'w' ? 'b' : 'w'; $('turnBtn').textContent = editTurn === 'w' ? 'White to move' : 'Black to move'; };
  $('clearBtn').onclick = () => { cg.set({ fen: '8/8/8/8/8/8/8/8' }); unsure = []; markUnsure(); };
  $('startEdit').onclick = () => { cg.set({ fen: INITIAL_FEN.split(' ')[0] }); editTurn = 'w'; $('turnBtn').textContent = 'White to move'; unsure = []; markUnsure(); };
  $('doneBtn').onclick = () => { const fen = fenFrom(cg.getFen(), editTurn), why = legal(fen);
    if (why) { $('editMsg').textContent = why; $('editMsg').style.color = '#ff9b9b'; return; } leaveEdit(fen); };
  $('cancelBtn').onclick = () => { unsure = []; markUnsure(); leaveEdit(null); };
  $('editBtn').onclick = () => enterEdit();
  $('startBtn').onclick = () => { label = 'Start position'; unsure = []; markUnsure(); $('scanbar').hidden = true; setRoot(INITIAL_FEN); show(); };

  // ---------- scan a board (reader.worker.mjs) ----------
  const reader = new Worker('./reader.worker.mjs', { type: 'module' });
  let reqId = 0; const wait = new Map();
  reader.onmessage = ({ data }) => { const r = wait.get(data.id); if (r) { wait.delete(data.id); r(data); } };
  const read = bm => new Promise(res => { const id = ++reqId; wait.set(id, res); reader.postMessage({ id, image: bm }, [bm]); });
  const blank = new OffscreenCanvas(64, 64); blank.getContext('2d').fillRect(0, 0, 64, 64);
  read(blank.transferToImageBitmap()).then(r => { if (r.error) status('Board reader failed: ' + r.error, 'err');
    else if ($('status').textContent.startsWith('Loading')) status(''); });   // don't hide a grab already under way

  let frame = null, cropKey = 'paste', drag = null;
  const crops = (() => { try { return JSON.parse(localStorage.getItem('crops') || '{}'); } catch { return {}; } })();
  const saveCrops = () => { try { localStorage.setItem('crops', JSON.stringify(crops)); } catch {} };
  function drawPhoto(box) {
    const c = $('photo'); if (!frame) return;
    c.width = 390; c.height = Math.round(390 * frame.height / frame.width);
    const g = c.getContext('2d'); g.drawImage(frame, 0, 0, c.width, c.height);
    const k = box || crops[cropKey];
    if (k) { g.fillStyle = '#000a'; g.beginPath(); g.rect(0, 0, c.width, c.height); g.rect(k.x * c.width, k.y * c.height, k.w * c.width, k.h * c.height); g.fill('evenodd');
      g.strokeStyle = '#e3b341'; g.lineWidth = 2; g.strokeRect(k.x * c.width, k.y * c.height, k.w * c.width, k.h * c.height); }
  }
  const rel = e => { const r = $('photo').getBoundingClientRect(); return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))]; };
  const boxOf = (a, b) => ({ x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) });
  $('photo').addEventListener('mousedown', e => { if (frame) drag = rel(e); });
  addEventListener('mousemove', e => { if (drag) drawPhoto(boxOf(drag, rel(e))); });
  addEventListener('mouseup', e => { if (!drag) return; const box = boxOf(drag, rel(e)); drag = null;
    if (box.w > .05 && box.h > .05) { crops[cropKey] = box; saveCrops(); scan(); } else drawPhoto(); });
  $('photo').addEventListener('dblclick', () => { delete crops[cropKey]; saveCrops(); scan(); });

  let scanSeq = 0, nextLabel = label;
  async function scan() {
    if (!frame) return;
    const seq = ++scanSeq;                             // grabbing two cameras quickly: only the last one counts
    drawPhoto();
    const k = crops[cropKey] || { x: 0, y: 0, w: 1, h: 1 };
    const sx = k.x * frame.width, sy = k.y * frame.height, sw = k.w * frame.width, sh = k.h * frame.height;
    status('Reading the board…');
    const r = await read(await createImageBitmap(frame, sx, sy, sw, sh));
    if (seq !== scanSeq) return;
    if (r.error) return status('Could not read the board: ' + r.error, 'err');
    window.__lastScan = r;
    orientation = r.orientation; unsure = r.unsure;
    const fen = fenFrom(r.placement, 'w'), why = legal(fen);
    status(`Read in ${(r.ms / 1000).toFixed(1)} s.` + (unsure.length ? ` ${unsure.length} square(s) unsure (red).` : ''), unsure.length ? 'warn' : '');
    // enterEdit first keeps the previous position/label in its backup, so Cancel goes fully back
    if (why) { enterEdit(r.placement, 'w', 'Scan needs a fix: ' + why); cg.set({ orientation }); label = nextLabel; return; }
    if (mode === 'edit') { mode = 'analysis'; $('scanBox').hidden = false; $('editBox').hidden = true; $('app').classList.remove('editing'); setPick(null); pendingDoc = null; }
    label = nextLabel;
    setRoot(fen); show(); markUnsure(); scanBar();
  }
  // after a scan: who is to move can't be seen in a photo, so offer the switch right there
  function scanBar() {
    const b = $('scanbar'); b.hidden = false; b.innerHTML = '';
    const turn = root.fen.split(' ')[1];
    b.append(h('span', '', `Scanned from ${label}${unsure.length ? ` · check the ${unsure.length} red square(s)` : ''} ·`));
    const t = h('button', '', turn === 'w' ? 'White to move ⇄' : 'Black to move ⇄');
    t.onclick = () => { if (mode !== 'analysis') return; const fen = fenFrom(root.fen.split(' ')[0], turn === 'w' ? 'b' : 'w'), why = legal(fen); if (why) return status(why, 'err');
      setRoot(fen); show(); markUnsure(); scanBar(); };
    const ed = h('button', '', '✏ Fix'); ed.onclick = () => enterEdit();
    const x = h('button', '', '✕'); x.onclick = () => { b.hidden = true; };
    b.append(t, ed, x);
  }
  async function useImage(img, key, name) { frame = await createImageBitmap(img); cropKey = key; nextLabel = name; return scan(); }

  // camera frames: from OBS on the stream laptop, otherwise straight from the room phone over VDO.Ninja
  const camConn = [];
  async function vdoFrame(i) {
    if (!PH) throw new Error('open the board with the link from the stream laptop first');
    let c = camConn[i];
    if (!c) {
      const vdo = new VDONinjaSDK({ salt: 'vdo.ninja' }), video = document.createElement('video');
      video.muted = true; video.playsInline = true;
      c = camConn[i] = { vdo, video, timer: 0 };
      c.ready = new Promise((res, rej) => {
        vdo.addEventListener('track', e => { if (e.detail.track.kind !== 'video') return; video.srcObject = new MediaStream([e.detail.track]); video.play().catch(() => {}); res(); });
        setTimeout(() => rej(new Error('that camera is not live')), 15000);
      });
      c.ready.catch(() => {});
      try { await vdo.connect(); await vdo.view(PH + 'c' + (i + 1), { audio: false, video: true }); }
      catch (e) { camConn[i] = null; try { vdo.disconnect(); } catch {} throw e; }
    }
    clearTimeout(c.timer); c.timer = setTimeout(() => { try { c.vdo.disconnect(); } catch {} camConn[i] = null; }, 120000);   // keep it 2 min for re-scans
    try { await c.ready; } catch (e) { try { c.vdo.disconnect(); } catch {} camConn[i] = null; throw e; }
    for (let t = 0; t < 60 && (c.video.readyState < 2 || !c.video.videoWidth); t++) await new Promise(r => setTimeout(r, 100));
    if (!c.video.videoWidth) throw new Error('no picture from that camera yet');
    return createImageBitmap(c.video);
  }
  async function grabCam(i) {
    if (LOCAL) { try { const res = await fetch('/shot?source=' + encodeURIComponent(CAMS[i][0])); if (res.ok) return await res.blob(); } catch {} }
    return vdoFrame(i);
  }
  CAMS.forEach(([source, name], i) => {
    const b = h('button', '', name);
    b.onclick = async () => { status(`Grabbing ${name}…`); setCam(i + 1);   // the stream's room follows the scanned board
      try { await useImage(await grabCam(i), source, name); }
      catch (e) { status(`Could not grab ${name}: ${e.message}`, 'err'); } };
    $('cams').append(b);
  });
  addEventListener('paste', e => { const f = [...e.clipboardData.items].find(i => i.type.startsWith('image/')); if (f) useImage(f.getAsFile(), 'paste', 'Screenshot'); });
  addEventListener('dragover', e => e.preventDefault());
  addEventListener('drop', e => { e.preventDefault(); const f = [...e.dataTransfer.files].find(f => f.type.startsWith('image/')); if (f) useImage(f, 'paste', 'Screenshot'); });

  // ---------- start: the board saved on this laptop, then whatever newer the room has ----------
  let saved = null; try { saved = JSON.parse(localStorage.getItem('boardDoc2') || 'null'); } catch {}
  setRoot(INITIAL_FEN);
  // only the board (never the stream layout), only if saved in the last 6 h, and only if nobody in the room answers within 4 s
  const fresh = saved?.board?.rootFen && Date.now() - (saved.savedAt || 0) < 6 * 3600e3 ? { board: saved.board } : null;
  show();
  if (fresh) { if (room) setTimeout(() => { if (!room.doc.board || room.doc.board.by === room.me) room.seed(fresh); }, 4000); else adopt(fresh); }
  renderStage(); renderLink();
  window.__test = { useImage, cg, play, get fen() { return cur.fen; }, get engine() { return engine.last; }, get mode() { return mode; },
    nav: { go, root: () => root }, shiftAll, rotateAll, enterEdit, get shapes() { return cur.shapes; }, get doc() { return room?.doc; }, get stage() { return stage; }, setMain, askAccess };
}
