// Face numbers for the avatars: turns one MediaPipe FaceLandmarker result into VTube-Studio-style parameters.
// Shared by the phone page (board/face/index.html, which sends the numbers) and the stream laptop (vtuber/face.js, old video path).
//   head: FaceAngleX/Y/Z (degrees), FacePositionX/Y     eyes: EyeOpenLeft/Right (0..1.2, wide > 1), EyeSmile, EyeLeftX/Y
//   mouth: MouthOpen, MouthSmile (.5 = neutral), MouthPucker     brows: BrowLeft/BrowRight (.5 = neutral), BrowAngry     Cheek, Talk
// Calibrates to the resting face for the first 30 frames (and after recentre()).
// Head pose is measured against the resting pose in the head's own axes (R0ᵀ·R): it does not matter whether the phone
// is held upright, sideways or upside down, a turn stays a turn and a nod stays a nod.

// One-euro filter: smooth when still, fast when moving (less lag than plain smoothing, no jitter at rest)
function oneEuro(minCutoff = 1.2, beta = 0.02) {
  let x = null, dx = 0, t = 0;
  const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
  return (v, now) => {
    if (x === null) { x = v; t = now; return v; }
    const dt = Math.max(1e-3, (now - t) / 1000); t = now;
    const ndx = (v - x) / dt; dx += alpha(1, dt) * (ndx - dx);
    x += alpha(minCutoff + beta * Math.abs(dx), dt) * (v - x); return x;
  };
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rotOf = d => { const s = Math.hypot(d[0], d[1], d[2]) || 1;   // 3x3 rotation, rows, from MediaPipe's column-major 4x4
  return [[d[0] / s, d[4] / s, d[8] / s], [d[1] / s, d[5] / s, d[9] / s], [d[2] / s, d[6] / s, d[10] / s]]; };
const angles = M => ({ yaw: Math.atan2(M[0][2], M[2][2]) * 57.3, pitch: Math.asin(clamp(-M[1][2], -1, 1)) * 57.3, roll: Math.atan2(M[1][0], M[1][1]) * 57.3 });
const meanRot = list => {                            // average of the calibration frames, made a proper rotation again
  const col = j => [0, 1, 2].map(i => list.reduce((a, R) => a + R[i][j], 0));
  const norm = v => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); }, dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const x = norm(col(0)), y0 = col(1), y = norm(y0.map((v, i) => v - dot(y0, x) * x[i]));
  const z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  return [0, 1, 2].map(i => [x[i], y[i], z[i]]);
};

export function createTracker({ flip = 1 } = {}) {
  const F = {}, f = (k, v, now, mc, b) => (F[k] || (F[k] = oneEuro(mc, b)))(v, now);
  let centre = null, calib = [], R0 = null, calibR = [], prevJaw = 0, talk = 0;
  const relative = R => R0[0].map((_, i) => R0[0].map((_, j) => R0[0][i] * R[0][j] + R0[1][i] * R[1][j] + R0[2][i] * R[2][j]));   // R0ᵀ·R
  const recentre = () => { centre = null; calib = []; R0 = null; calibR = []; };

  // fc = { lm: landmarks, bs: blendshape categories, mx: facial transformation matrix (optional) }; returns the parameters
  function process(fc, now) {
    const lm = fc.lm, bs = Object.fromEntries(fc.bs.categories.map(c => [c.categoryName, c.score]));
    let yaw, pitch, roll, R = null;
    if (fc.mx) { R = rotOf(fc.mx.data); ({ yaw, pitch, roll } = angles(R)); }   // 3D head pose from MediaPipe's matrix
    else {
      const L = lm[234], Rt = lm[454], nose = lm[1], brow = lm[168], chin = lm[152];
      yaw = ((nose.x - L.x) / (Rt.x - L.x) - .5) * 110; pitch = ((nose.y - brow.y) / (chin.y - brow.y) - .5) * 140;
      roll = Math.atan2(lm[263].y - lm[33].y, lm[263].x - lm[33].x) * 57.3;
    }
    const raw = { yaw, pitch, roll, x: (lm[234].x + lm[454].x) / 2, y: (lm[168].y + lm[152].y) / 2,
      bl: bs.eyeBlinkLeft, br: bs.eyeBlinkRight, gx: bs.eyeLookOutLeft - bs.eyeLookInLeft, gy: bs.eyeLookUpLeft - bs.eyeLookDownLeft,
      sm: (bs.mouthSmileLeft + bs.mouthSmileRight) / 2, bu: bs.browInnerUp, bd: (bs.browDownLeft + bs.browDownRight) / 2 };
    if (!centre) { calib.push(raw); if (R) calibR.push(R); if (calib.length >= 30) { centre = {};
      for (const k in raw) centre[k] = calib.reduce((a, c) => a + c[k], 0) / calib.length;
      if (calibR.length >= 20) R0 = meanRot(calibR); } }
    const c = centre || raw, G = 1.35;            // G: a bit of exaggeration reads better on a small avatar
    if (R0 && R) ({ yaw, pitch, roll } = angles(relative(R)));   // head motion in its own axes (centre is then 0)
    const h = R0 && R ? { yaw: 0, pitch: 0, roll: 0 } : c;
    const smile = clamp((raw.sm - c.sm) * 1.8 + .1, 0, 1);
    const eye = (b, cb, wide) => clamp(1 - (b - cb - .04) / ((1 - cb) * .5), 0, 1) + clamp(wide - .25, 0, .5) * .4;
    // jawOpen is ~.1-.3 in normal speech: gain 3.4 with a soft curve makes a talking mouth clearly open
    const jo = clamp(bs.jawOpen - .02, 0, 1), jaw = clamp(Math.sqrt(jo) * 1.6 * Math.min(1, jo * 12 + .25) , 0, 1);
    // talking = the jaw keeps moving (a held open smile does not count)
    talk = talk * .88 + Math.min(1, Math.abs(jaw - prevJaw) * 7) * .12; prevJaw = jaw;
    const p = {
      FaceAngleX: f('ax', clamp(-(yaw - h.yaw) * G * flip, -30, 30), now, 1.5, .03),
      FaceAngleY: f('ay', clamp((pitch - h.pitch) * G, -30, 30), now, 1.5, .03),
      FaceAngleZ: f('az', clamp(-(roll - h.roll) * G * flip, -30, 30), now, 1.5, .03),
      FacePositionX: f('px', clamp(-(raw.x - c.x) * 30 * flip, -10, 10), now, .8, .02),
      FacePositionY: f('py', clamp(-(raw.y - c.y) * 30, -10, 10), now, .8, .02),
      EyeOpenLeft: f('el', eye(raw.bl, c.bl, bs.eyeWideLeft), now, 4, .1),
      EyeOpenRight: f('er', eye(raw.br, c.br, bs.eyeWideRight), now, 4, .1),
      EyeSmile: f('es', clamp(smile * 1.2 - .2 + (bs.cheekSquintLeft + bs.cheekSquintRight) * .8, 0, 1), now, 2, .05),
      EyeLeftX: f('gx', clamp((raw.gx - c.gx) * 1.8 * flip, -1, 1), now, 2, .05),
      EyeLeftY: f('gy', clamp((raw.gy - c.gy) * 1.8, -1, 1), now, 2, .05),
      MouthOpen: f('mo', clamp(jaw + bs.mouthFunnel * .4, 0, 1), now, 6, .3),
      MouthSmile: f('ms', clamp(.5 + smile * .6 - (bs.mouthFrownLeft + bs.mouthFrownRight) * .5 - bs.mouthPucker * .3, 0, 1), now, 2, .05),
      MouthPucker: f('mp', clamp((bs.mouthPucker + bs.mouthFunnel) * 1.2, 0, 1), now, 2, .05),
      BrowLeft: f('bl', clamp(.5 + (bs.browOuterUpLeft + raw.bu - c.bu) * .9 - (bs.browDownLeft - c.bd) * .9, 0, 1), now, 2, .05),
      BrowRight: f('bR', clamp(.5 + (bs.browOuterUpRight + raw.bu - c.bu) * .9 - (bs.browDownRight - c.bd) * .9, 0, 1), now, 2, .05),
      BrowAngry: f('ba', clamp((raw.bd - c.bd) * 2.2, 0, 1), now, 2, .05),
      Cheek: f('ck', clamp(smile * 1.3 - .35, 0, 1), now, 1, .02),
      Talk: talk
    };
    p.EyeRightX = p.EyeLeftX; p.EyeRightY = p.EyeLeftY;
    return p;
  }
  return { process, recentre, calibrated: () => !!centre };
}

// The numbers go over the wire as a flat array in this order (about 20 numbers, ~170 bytes of text).
export const KEYS = ['FaceAngleX', 'FaceAngleY', 'FaceAngleZ', 'FacePositionX', 'FacePositionY', 'EyeOpenLeft', 'EyeOpenRight', 'EyeSmile',
  'EyeLeftX', 'EyeLeftY', 'MouthOpen', 'MouthSmile', 'MouthPucker', 'BrowLeft', 'BrowRight', 'BrowAngry', 'Cheek', 'Talk'];
export const pack = p => KEYS.map(k => Math.round(p[k] * 1000) / 1000);
export const unpack = a => { const p = {}; KEYS.forEach((k, i) => { p[k] = +a[i] || 0; }); p.EyeRightX = p.EyeLeftX; p.EyeRightY = p.EyeLeftY; return p; };
