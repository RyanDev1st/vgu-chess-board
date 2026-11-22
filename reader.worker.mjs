// Reads a chess position from a photo of a real board. Runs off the page's main thread.
// Model: ChessQ Lite V6 INT8 (https://huggingface.co/joelseytre/chessq-lite, PolyForm Noncommercial 1.0.0),
// the same model family lichess's editor "From image" uses; pre/post-processing follows lichess's
// ui/editor/src/editor.vision.worker.ts. Everything runs on this laptop: no photo leaves it.
import * as ort from './lib/ort.wasm.min.mjs';

const RES = 644, PLANE = RES * RES, CLASSES = '.PNBRQKpnbrqk';
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
const WHITE_VIEW_COS = Math.fround(Math.cos(100 * Math.PI / 180));   // White at the bottom within ±100°
let session;

async function load() {
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = { wasm: new URL('./lib/ort-wasm-simd-threaded.wasm', import.meta.url).href,
                             mjs: new URL('./lib/ort-wasm-simd-threaded.mjs', import.meta.url).href };
  session = await ort.InferenceSession.create(new URL('./lib/chessq-lite-v6-int8.onnx', import.meta.url).href,
    { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
}
const ready = load();

self.onmessage = async ({ data: { id, image } }) => {
  try {
    await ready;
    const t0 = performance.now();
    const canvas = new OffscreenCanvas(RES, RES), ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, 0, 0, RES, RES); image.close();
    const px = ctx.getImageData(0, 0, RES, RES).data, input = new Float32Array(3 * PLANE);
    for (let p = 0, i = 0; p < PLANE; p++, i += 4)
      for (let c = 0; c < 3; c++) input[c * PLANE + p] = (px[i + c] / 255 - MEAN[c]) / STD[c];
    const tensor = new ort.Tensor('float32', input, [1, 3, RES, RES]);
    const out = await session.run({ image: tensor });
    const logits = out.logits.data, [cos] = out.direction.data;
    // per square: best class and how sure the model is (softmax probability of that class)
    const board = [], sure = [];
    for (let s = 0; s < 64; s++) {
      const o = s * 13; let best = 0, max = -Infinity, sum = 0;
      for (let k = 0; k < 13; k++) if (logits[o + k] > max) { max = logits[o + k]; best = k; }
      for (let k = 0; k < 13; k++) sum += Math.exp(logits[o + k] - max);
      board.push(CLASSES[best]); sure.push(1 / sum);
    }
    tensor.dispose(); for (const v of Object.values(out)) v.dispose();
    const placement = [0, 1, 2, 3, 4, 5, 6, 7].map(r => board.slice(r * 8, r * 8 + 8).join('').replace(/\.+/g, m => m.length)).join('/');
    // squares in FEN order a8..h1 -> names
    const unsure = sure.flatMap((p, s) => p < 0.7 ? ['abcdefgh'[s % 8] + (8 - (s >> 3))] : []);
    self.postMessage({ id, placement, orientation: cos < WHITE_VIEW_COS ? 'black' : 'white', unsure, ms: Math.round(performance.now() - t0) });
  } catch (e) { self.postMessage({ id, error: e.message || String(e) }); }
};
