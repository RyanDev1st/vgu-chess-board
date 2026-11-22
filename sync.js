// One shared board for both commentator laptops and the stream, through a private VDO.Ninja data room
// (peer-to-peer, no server or account of ours). Every page holds the whole document, made of sections ('board': moves,
// arrows, flip…; 'stage': the stream layout). Per section the newest edit wins (a version number that only goes up,
// ties broken by page id), so two people changing different things at the same moment never undo each other.

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

// role: 'laptop' | 'obs'. onDoc(doc) when any section gets newer, onMsg(m) for other messages, onPeers([{role}]) every 4 s.
export function joinRoom(key, { role, onDoc, onMsg = () => {}, onPeers = () => {}, onState = () => {} }) {
  const me = role + '-' + Math.random().toString(36).slice(2, 9);
  let doc = {}, version = 0;
  const peers = new Map();                                  // uuid -> { role, at }
  const vdo = new VDONinjaSDK({ salt: 'vdo.ninja' });
  const send = (m, to) => { try { vdo.sendData({ vgub: 1, role, ...m }, to || undefined); } catch {} };
  const take = d => {
    if (!d || typeof d !== 'object') return;
    let changed = false;
    for (const [k, sec] of Object.entries(d)) {
      if (!sec || typeof sec.v !== 'number' || !sec.by) continue;
      version = Math.max(version, sec.v);
      const old = doc[k];
      if (!old || sec.v > old.v || (sec.v === old.v && sec.by > old.by)) { doc = { ...doc, [k]: sec }; changed = true; }
    }
    if (changed) onDoc(doc);
  };
  vdo.addEventListener('dataReceived', ({ detail }) => {
    const m = detail.data; if (!m || m.vgub !== 1) return;
    peers.set(detail.uuid, { role: m.role, at: Date.now() });
    if (m.t === 'doc') take(m.doc); else if (m.t !== 'hb') onMsg(m, detail.uuid);
  });
  vdo.addEventListener('dataChannelOpen', ({ detail }) => { send({ t: 'hb' }, detail.uuid); if (Object.keys(doc).length) send({ t: 'doc', doc }, detail.uuid); });
  vdo.addEventListener('peerDisconnected', ({ detail }) => { peers.delete(detail.uuid); });
  setInterval(() => {
    send({ t: 'hb' });
    const now = Date.now(); for (const [k, p] of peers) if (now - p.at > 15000) peers.delete(k);
    onPeers([...peers.values()]);
  }, 4000);
  (async function connect(wait = 3000) {                    // no internet at start: keep trying
    try { onState('connecting'); await vdo.autoConnect({ room: 'vgubchess_' + key }); onState('in room'); }
    catch (e) { onState('offline, retrying'); setTimeout(() => connect(Math.min(wait * 2, 30000)), wait); }
  })();
  return {
    me,
    seed: take,                                             // a document saved on this laptop: used unless the room has a newer one
    publish(section, body) { doc = { ...doc, [section]: { ...body, v: ++version, by: me } }; send({ t: 'doc', doc }); return doc; },
    send: m => send(m),
    get doc() { return doc; },
  };
}
