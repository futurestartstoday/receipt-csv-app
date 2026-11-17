// PaddleOCR（日本語対応）をブラウザ内で動かす。画像はどこにも送信しない。
// 文字の検出は PP-OCRv5 mobile、認識は PP-OCRv6 small を使う。
import { groupLines } from './parser.js';

const ORT_DIR = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
const PADDLE_URL = 'https://cdn.jsdelivr.net/npm/paddleocr@1.2.0/dist/index.mjs';
const MODEL_DIR = new URL('./models/', import.meta.url);
const CACHE_NAME = 'receipt-csv-models-v1';
// 大きすぎる画像だけ長辺をこのサイズまで縮小する。
// 文字の検出は内部でさらに縮小して行うが、文字の認識はこの解像度の画像から切り出すので、縮小しすぎると誤読が増える
const MAX_SIDE = 4000;

let servicePromise = null;

// モデルを読み込む。一度読み込んだモデルはブラウザのキャッシュに保存し、2回目以降はそこから読む
async function fetchModel(name) {
  const url = new URL(name, MODEL_DIR);
  let cache = null;
  try {
    cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(url);
    if (hit) return hit.arrayBuffer();
  } catch { /* キャッシュが使えない環境では毎回読み込む */ }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${name} を読み込めません (${res.status})`);
  const buffer = await res.arrayBuffer();
  try { await cache?.put(url, new Response(buffer.slice(0))); } catch { /* 保存できなくても続行する */ }
  return buffer;
}

function loadService() {
  servicePromise ??= (async () => {
    const [ort, { PaddleOcrService }] = await Promise.all([
      import(ORT_DIR + 'ort.wasm.min.mjs'),
      import(PADDLE_URL),
    ]);
    ort.env.wasm.wasmPaths = ORT_DIR;
    const [det, rec, dict] = await Promise.all([
      fetchModel('PP-OCRv5_mobile_det_infer.onnx'),
      fetchModel('PP-OCRv6_small_rec.onnx'),
      fetch(new URL('ppocrv6_dict.txt', MODEL_DIR)).then(r => r.text()),
    ]);
    return PaddleOcrService.createInstance({
      ort,
      modelPreset: 'PP-OCRv6_small',
      detection: { modelBuffer: det },
      recognition: {
        modelBuffer: rec,
        // 辞書の末尾に空白文字を加える
        charactersDictionary: [...dict.replace(/\r/g, '').replace(/\n$/, '').split('\n'), ' '],
      },
    });
  })().catch(e => { servicePromise = null; throw e; });
  return servicePromise;
}

// image: ImageBitmap または canvas
// stretch: 横方向の引き伸ばし倍率。半角カナは幅が狭く読み違えやすいので、1.5倍に広げると品名の精度が上がる
function toPixels(image, stretch) {
  const scale = Math.min(1, MAX_SIDE / Math.max(image.width * stretch, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.width * stretch * scale);
  canvas.height = Math.round(image.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, data: new Uint8Array(data.buffer) };
}

export async function recognizeReceipt(image, onProgress, { stretch = 1 } = {}) {
  onProgress('OCRを準備中…（初回のみ約26MBのモデルを読み込みます）');
  const ocr = await loadService();
  const pixels = toPixels(image, stretch);
  onProgress('文字を読み取り中…');
  let count = 0;
  const results = await ocr.recognize(pixels, {
    // 検出モデル(v5 mobile)向けの設定。標準(960px)だと縦長のレシートで文字が小さくなりすぎるので大きめにする
    detection: {
      limitType: 'max', maxSideLength: 1600,
      textPixelThreshold: 0.3, boxScoreThreshold: 0.6, unclipRatio: 1.5,
    },
    onProgress(e) {
      if (e.type === 'rec' && e.stage === 'item') onProgress(`文字を読み取り中… ${++count}: ${e.result?.text ?? ''}`);
    },
  });
  return groupLines(results);
}
