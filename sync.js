// One shared board for both commentator laptops and the stream, through a private VDO.Ninja data room
// (peer-to-peer, no server or account of ours). Every page holds the whole document, made of sections ('board': moves,
// arrows, flip…; sMain/sCam/sPip: the stream layout). Per section the newest edit wins (a version number that only goes up,
// ties broken by page id), so two people changing different things at the same moment never undo each other.
// Robustness: every heartbeat (4 s) carries the versions each page holds, so an update lost in a Wi-Fi blip is re-sent;
// a page that has heard nobody for 25 s rebuilds its connection (the SDK itself gives up after ~30 s offline).

// Room key and camera prefix: from the link (#room=KEY&cams=PREFIX, saved on this laptop after the first visit),
// or ../room.json on the stream machine. Neither is in the public code: the prefix would also reveal the face cameras.
export async function roomConfig() {
  const hash = new URLSearchParams(location.hash.slice(1)), get = k => hash.get(k) || new URLSearchParams(location.search).get(k);
  let key = get('room'), cams = get('cams');
  if (key) { try { localStorage.setItem('roomKey', key); if (cams) localStorage.setItem('roomCams', cams); } catch {} history.replaceState(null, '', location.pathname + location.search); }
  if (!key) { try { const r = await fetch('../room.json', { cache: 'no-store' }); if (r.ok) ({ key, cams } = await r.json()); } catch {} }
  if (!key) { try { key = localStorage.getItem('roomKey'); cams = cams || localStorage.getItem('roomCams'); } catch {} }
  return { key: key || '', cams: cams || '' };
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
