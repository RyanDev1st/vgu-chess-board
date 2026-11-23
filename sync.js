// One shared board for both commentator laptops and the stream, through a private VDO.Ninja data room
// (peer-to-peer, no server or account of ours). Every page holds the whole document, made of sections ('board': moves,
// arrows, flip…; sMain/sCam/sPip: the stream layout). Per section the newest edit wins (a version number that only goes up,
// ties broken by page id), so two people changing different things at the same moment never undo each other.
// Robustness: every heartbeat (4 s) carries the versions each page holds, so an update lost in a Wi-Fi blip is re-sent;
// a page that has heard nobody for 25 s rebuilds its connection (the SDK itself gives up after ~30 s offline).

// Room key and camera prefix: given to an approved laptop (saved in its browser), or ../room.json on the stream machine. Neither is in the public code: the prefix would also reveal the face cameras.
export async function roomConfig() {
  // Keys in a link (#room=KEY&cams=PREFIX) count only on the stream laptop itself (tests, crew); on the public site a laptop
  // gets its key only by being approved. Stored under new names: keys saved before approval existed (2026-11-23) are dropped.
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const hash = new URLSearchParams(location.hash.slice(1)), get = k => hash.get(k) || new URLSearchParams(location.search).get(k);
  let key = local ? get('room') : null, cams = local ? get('cams') : null;
  try { localStorage.removeItem('roomKey'); localStorage.removeItem('roomCams'); } catch {}
  if (location.hash.includes('room=')) history.replaceState(null, '', location.pathname + location.search);
  if (!key) { try { const r = await fetch('../room.json', { cache: 'no-store' }); if (r.ok) ({ key, cams } = await r.json()); } catch {} }
  if (!key) { try { key = localStorage.getItem('boardKey'); cams = cams || localStorage.getItem('boardCams'); } catch {} }
  return { key: key || '', cams: cams || '' };
}

// ---------- access requests: the public "lobby" ----------
// A laptop without the key asks for it here with a name; the admin (approve page on the admin's tailnet, or the crew's
// control page) answers Approve -> the key + camera prefix go to that one laptop only.
// The lobby name is public on purpose: anyone can ask, nobody gets in without a click.
const LOBBY = 'vgubchess_lobby_v1';
function lobby(onMsg, onOpen = () => {}) {
  let vdo = null, my = 0;
  const start = () => {
    const g = ++my; try { vdo && vdo.disconnect(); } catch {}
    vdo = new VDONinjaSDK({ salt: 'vdo.ninja' });
    vdo.addEventListener('dataReceived', e => { const { data, uuid } = e.detail || {}; if (g === my && data && data.lob === 1) onMsg(data, uuid); });
    vdo.addEventListener('dataChannelOpen', e => { if (g === my) onOpen((e.detail || {}).uuid); });
    vdo.addEventListener('reconnectFailed', () => setTimeout(() => g === my && start(), 2000));
    (async function connect(wait = 3000) { try { await vdo.autoConnect({ room: LOBBY }); } catch { if (g === my) setTimeout(() => g === my && connect(Math.min(wait * 2, 30000)), wait); } })();
  };
  start();
  return { send: (m, to) => { try { vdo.sendData({ lob: 1, ...m }, to || undefined); } catch {} }, restart: start,
    close: () => { my++; try { vdo.disconnect(); } catch {} } };
}
// Security (anyone can join the lobby and see the requests):
//  - the admin's answers are signed (ECDSA; the private key is in room.json on the stream laptop, the public one is below),
//    so nobody else can fake an approval or a "denied";
//  - the key travels encrypted to the asking laptop's own one-time key (ECDH + AES-GCM): a stranger who copies a request
//    gets nothing even if the answer reached them;
//  - requests are tracked per connection (not by an id the sender chooses), and each shows a 4-character code that the
//    laptop also shows, so two requests with the same name can be told apart.
const ADMIN_PUB = { kty: 'EC', crv: 'P-256', x: '1DJsej734lBCIDdPORmObh_MjAhiY1WawUlV8BdRrOQ', y: 'M5X9DnVZRGgI1iIptqvZ1vUlwZFSeSO3x3X9owyHETI' };
const C = crypto.subtle, te = new TextEncoder(), td = new TextDecoder();
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf))), unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const codeOf = async raw => [...new Uint8Array(await C.digest('SHA-256', raw)).slice(0, 2)].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
const ECDH = { name: 'ECDH', namedCurve: 'P-256' }, ECDSA = { name: 'ECDSA', namedCurve: 'P-256' }, SIG = { name: 'ECDSA', hash: 'SHA-256' };
const aesFrom = (priv, pub, use) => C.deriveKey({ name: 'ECDH', public: pub }, priv, { name: 'AES-GCM', length: 256 }, false, [use]);

// laptop side: ask until answered. onCode(code) once; onAnswer({ok, key, cams} | {ok:false})
export function requestAccess(name, onAnswer, onCode = () => {}, role = '') {
  const rid = Math.random().toString(36).slice(2, 10);
  let done = false, l = null, t = 0;
  const finish = a => { if (done) return; done = true; clearInterval(t); l && l.close(); onAnswer(a); };
  (async () => {
    const kp = await C.generateKey(ECDH, false, ['deriveKey']), raw = await C.exportKey('raw', kp.publicKey), pub = b64(raw);
    const admin = await C.importKey('jwk', ADMIN_PUB, ECDSA, false, ['verify']);
    onCode(await codeOf(raw));
    if (done) return;
    const req = { t: 'req', rid, name, role, pub };
    l = lobby(async m => {
      if (done || m.rid !== rid || typeof m.body !== 'string' || typeof m.sig !== 'string') return;
      try {
        if (!(await C.verify(SIG, admin, unb64(m.sig), te.encode(m.body)))) return;   // not from the admin: ignore
        const b = JSON.parse(m.body); if (b.rid !== rid || b.pub !== pub) return;
        if (b.t === 'deny') return finish({ ok: false });
        if (b.t === 'grant') {
          const epk = await C.importKey('raw', unb64(b.epk), ECDH, false, []);
          const g = JSON.parse(td.decode(await C.decrypt({ name: 'AES-GCM', iv: unb64(b.iv) }, await aesFrom(kp.privateKey, epk, 'decrypt'), unb64(b.ct))));
          if (g.key) finish({ ok: true, key: g.key, cams: g.cams || '' });
        }
      } catch {}
    }, uuid => l.send(req, uuid));
    t = setInterval(() => l.send(req), 4000);                // keep asking (an approver may open later)
  })();
  return { cancel: () => { done = true; clearInterval(t); l && l.close(); } };
}
// admin side: onList([{id, name, role, code, dup, at}]) when requests change; answer(id, approve, secrets) with secrets = room.json
// (role = what the person picked: Commentator / Tech crew / Referee / Organiser; their own word, shown to the admin)
export function approveRequests(onList) {
  const reqs = new Map();                                    // sender connection -> { rid, name, pub, code, at, seen }
  const list = () => { const all = [...reqs].map(([id, r]) => ({ id, name: r.name, role: r.role, code: r.code, at: r.at }));
    for (const r of all) r.dup = all.filter(o => o.name.toLowerCase() === r.name.toLowerCase()).length > 1;
    onList(all); };
  const l = lobby(async (m, uuid) => {
    if (m.t !== 'req' || !uuid || typeof m.rid !== 'string' || m.rid.length > 16 || typeof m.pub !== 'string' || m.pub.length > 120) return;
    const r = reqs.get(uuid);
    if (r && r.rid === m.rid) { r.seen = Date.now(); return; }
    if (!r && reqs.size >= 20) return;                       // flood guard
    let code; try { code = await codeOf(unb64(m.pub)); } catch { return; }
    reqs.set(uuid, { rid: m.rid, name: String(m.name || '?').slice(0, 30), role: String(m.role || '').slice(0, 20), pub: m.pub, code, at: Date.now(), seen: Date.now() }); list();
  });
  setInterval(() => { let ch = false; for (const [k, r] of reqs) if (Date.now() - r.seen > 10000) { reqs.delete(k); ch = true; } if (ch) list(); }, 2000);
  return {
    async answer(id, approve, secrets) {
      const r = reqs.get(id); if (!r) return;
      const signer = await C.importKey('jwk', secrets.adminKey, ECDSA, false, ['sign']);
      let body = { t: 'deny', rid: r.rid, pub: r.pub };
      if (approve) {
        const eph = await C.generateKey(ECDH, true, ['deriveKey']), iv = crypto.getRandomValues(new Uint8Array(12));
        const theirs = await C.importKey('raw', unb64(r.pub), ECDH, false, []);
        const ct = await C.encrypt({ name: 'AES-GCM', iv }, await aesFrom(eph.privateKey, theirs, 'encrypt'), te.encode(JSON.stringify({ key: secrets.key, cams: secrets.cams })));
        body = { t: 'grant', rid: r.rid, pub: r.pub, epk: b64(await C.exportKey('raw', eph.publicKey)), iv: b64(iv), ct: b64(ct) };
      }
      const text = JSON.stringify(body), sig = b64(await C.sign(SIG, signer, te.encode(text)));
      l.send({ rid: r.rid, body: text, sig }, id);
      reqs.delete(id); list();
    },
  };
}

// role: 'laptop' | 'obs'. onDoc(doc) when any section gets newer, onMsg(m, from) for other messages, onPeers([{role}]) every 4 s.
export function joinRoom(key, { role, onDoc, onMsg = () => {}, onPeers = () => {}, onState = () => {} }) {
  const me = role + '-' + Math.random().toString(36).slice(2, 9);
  let doc = {}, version = 0, vdo = null, gen = 0, startedAt = 0, heardAt = 0;
  const peers = new Map();                                  // uuid -> { role, at }
  const newer = (a, b) => !b || a.v > b.v || (a.v === b.v && a.by > b.by);
  const send = (m, to) => { try { vdo && vdo.sendData({ vgub: 1, role, ...m }, to || undefined); } catch {} };
  const summary = () => Object.fromEntries(Object.entries(doc).map(([k, s]) => [k, [s.v, s.by]]));
  const take = d => {
    if (!d || typeof d !== 'object') return;
    let changed = false;
    for (const [k, sec] of Object.entries(d)) {
      if (!sec || typeof sec.v !== 'number' || !sec.by) continue;
      version = Math.max(version, sec.v);
      if (newer(sec, doc[k])) { doc = { ...doc, [k]: sec }; changed = true; }
    }
    if (changed) onDoc(doc);
  };
  function start() {
    const my = ++gen; startedAt = Date.now();
    try { vdo && vdo.disconnect(); } catch {}
    vdo = new VDONinjaSDK({ salt: 'vdo.ninja' });
    const on = (ev, fn) => vdo.addEventListener(ev, e => { if (my === gen) fn(e.detail || {}); });   // ignore a replaced connection
    on('dataReceived', ({ data: m, uuid }) => {
      if (!m || m.vgub !== 1) return;
      peers.set(uuid, { role: m.role, at: Date.now() }); heardAt = Date.now();
      if (m.t === 'doc') take(m.doc);
      else if (m.t === 'hb') {                              // the peer is behind on something we hold: send it our copy
        const theirs = m.vs || {};
        if (Object.entries(doc).some(([k, s]) => newer(s, theirs[k] && { v: theirs[k][0], by: theirs[k][1] }))) send({ t: 'doc', doc }, uuid);
      } else onMsg(m, uuid);
    });
    on('dataChannelOpen', ({ uuid }) => { send({ t: 'hb', vs: summary() }, uuid); if (Object.keys(doc).length) send({ t: 'doc', doc }, uuid); });
    on('peerDisconnected', ({ uuid }) => { peers.delete(uuid); });
    on('reconnectFailed', () => setTimeout(() => my === gen && start(), 2000));
    (async function connect(wait = 3000) {                  // no internet at start: keep trying
      try { onState('connecting'); await vdo.autoConnect({ room: 'vgubchess_' + key }); if (my === gen) onState('in room'); }
      catch { if (my !== gen) return; onState('offline, retrying'); setTimeout(() => my === gen && connect(Math.min(wait * 2, 30000)), wait); }
    })();
  }
  start();
  setInterval(() => {
    send({ t: 'hb', vs: summary() });
    const now = Date.now(); for (const [k, p] of peers) if (now - p.at > 15000) peers.delete(k);
    onPeers([...peers.values()]);
    if (now - Math.max(heardAt, startedAt) > 25000) start();   // heard nobody for 25 s: rebuild the connection
  }, 4000);
  return {
    me,
    seed: take,                                             // a document saved on this laptop: used unless the room has a newer one
    publish(section, body) { doc = { ...doc, [section]: { ...body, v: ++version, by: me } }; send({ t: 'doc', doc }); return doc; },
    send: m => send(m),
    get doc() { return doc; },
  };
}
