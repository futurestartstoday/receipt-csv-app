// 選ばれたファイルを、OCRに渡せる画像（ImageBitmap または canvas）に変換する。
// 拡張子ではなくファイルの中身から形式を判断する（「.jpeg」でも中身がHEICのことがあるため）。
// 変換はすべてブラウザ内で行い、ファイルはどこにも送信しない。
const HEIC_URL = 'https://cdn.jsdelivr.net/npm/heic-to@1.6.6/dist/heic-to.js';
const PDFJS_DIR = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/';
const JPEG_JS_URL = 'https://cdn.jsdelivr.net/npm/jpeg-js@0.4.4/+esm';
// PDFのページを画像にするときの長辺の大きさ
const PDF_LONG_SIDE = 3000;

async function sniff(file) {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const ascii = (from, to) => String.fromCharCode(...head.slice(from, to));
  if (ascii(0, 4) === '%PDF') return 'pdf';
  if (ascii(4, 8) === 'ftyp' && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(ascii(8, 12))) return 'heic';
  if (head[0] === 0xff && head[1] === 0xd8) return 'jpeg';
  return 'other';
}

async function fromPdf(file) {
  const pdfjs = await import(PDFJS_DIR + 'pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_DIR + 'pdf.worker.min.mjs';
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const pdf = await task.promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: PDF_LONG_SIDE / Math.max(base.width, base.height) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvas, viewport }).promise;
    pages.push({ name: pdf.numPages > 1 ? `${file.name}（${n}ページ目）` : file.name, image: canvas });
  }
  await task.destroy();
  return pages;
}

async function fromHeic(file) {
  const { heicTo } = await import(HEIC_URL);
  const jpeg = await heicTo({ blob: file, type: 'image/jpeg', quality: 0.95 });
  return createImageBitmap(jpeg);
}

// ブラウザが読めないJPEG（特殊な形式のもの）をJavaScriptで読む
async function fromJpegFallback(file) {
  const { default: jpeg } = await import(JPEG_JS_URL);
  const { width, height, data } = jpeg.decode(new Uint8Array(await file.arrayBuffer()), {
    useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024,
  });
  return createImageBitmap(new ImageData(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width, height));
}

// 1つのファイルから読み取る画像の一覧を返す（PDFは複数ページのことがある）
export async function loadImages(file) {
  const kind = await sniff(file);
  if (kind === 'pdf') return fromPdf(file);
  if (kind === 'heic') return [{ name: file.name, image: await fromHeic(file) }];
  try {
    return [{ name: file.name, image: await createImageBitmap(file, { imageOrientation: 'from-image' }) }];
  } catch (e) {
    if (kind === 'jpeg') {
      try {
        return [{ name: file.name, image: await fromJpegFallback(file) }];
      } catch (fallbackError) {
        console.error(fallbackError);
      }
    }
    console.error(e);
    throw new Error(`「${file.name}」を画像として開けませんでした。別の形式（JPEG・PNG・HEIC・PDF）で保存し直してお試しください`);
  }
}
