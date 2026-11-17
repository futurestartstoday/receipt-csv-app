import { parseReceipt, calcTax, toCSV, normalize, fitPrintedTax } from './parser.js';
import { aiSupported, structureWithAI } from './ai.js';
import { recognizeReceipt } from './ocr.js';
import { loadImages } from './image.js';

// データはこのページのメモリ上だけに置き、サーバーにもブラウザの保存領域にも残さない
let rows = [];
// 「高精度モードで読み直す」ために、直前に読み取った画像とそこから追加した行を覚えておく
let lastBatch = null;

const $ = id => document.getElementById(id);
const dropzone = $('dropzone');
const fileInput = $('file');
const statusEl = $('status');
const tbody = $('rows');
const useAI = $('use-ai');

if (!aiSupported()) {
  useAI.disabled = true;
  $('ai-note').textContent = 'このブラウザはWebGPUに対応していないため、AI整理は使えません（ルールで読み取ります）。';
}

function setStatus(text) {
  statusEl.textContent = text;
}

// 品目の合計と比べる金額（小計の後に値引きがあれば、小計から引いた金額）
const expectedSum = r => r.subtotal === null ? null : r.subtotal + (r.discountAfterSubtotal ?? 0);
const matchesSubtotal = r => r.subtotal !== null && r.items.reduce((s, i) => s + i.price, 0) === expectedSum(r);

// 高精度モードでは画像を横に1.5倍引き伸ばして読む（半角カナの品名を読み違えにくくなる）。
// 引き伸ばすと金額の数字が分かれて読まれることがあるので、小計と合わないときは通常の読み取り結果と比べる
async function readReceipt(image, onProgress, accurate) {
  const read = async stretch => {
    const text = await recognizeReceipt(image, onProgress, { stretch });
    return { text, result: parseReceipt(text) };
  };
  if (!accurate) return read(1);
  const stretched = await read(1.5);
  if (stretched.result.subtotal === null || matchesSubtotal(stretched.result)) return stretched;
  onProgress('金額が小計と合わないため、通常モードでも読み取って比べています…');
  const normal = await read(1);
  return matchesSubtotal(normal.result) ? normal : stretched;
}

// 1枚のレシート画像を読み取って表に追加し、読み取った品目数を返す
async function processImage(image, prefix, accurate) {
  let { text, result } = await readReceipt(image, t => setStatus(prefix + t), accurate);
  $('ocr-text').value = normalize(text);
  if (useAI.checked && !useAI.disabled) {
    try {
      const ai = await structureWithAI(normalize(text), t => setStatus(prefix + t));
      if (ai.items.length) result = { ...result, ...ai };
    } catch (e) {
      console.error(e);
      setStatus('AI整理に失敗したため、ルールでの読み取り結果を使います。');
    }
  }
  addReceipt(result);
  return result.items.length;
}

async function handleFiles(files, accurate = $('accurate').checked) {
  // HEICはWindowsで種類が空になることがあるので、種類では絞らず中身を見て判断する
  files = [...files];
  if (!files.length) return;
  lastBatch = { files, rows: [] };
  dropzone.classList.add('busy');
  $('reread').hidden = true;
  const messages = [];
  let succeeded = false;
  for (const [i, file] of files.entries()) {
    const prefix = files.length > 1 ? `(${i + 1}/${files.length}) ` : '';
    try {
      setStatus(`${prefix}画像を開いています…`);
      for (const { name, image } of await loadImages(file)) {
        const count = await processImage(image, prefix, accurate);
        image.close?.();
        messages.push(`${name}: ${count}件の品目を読み取りました`);
        succeeded = true;
      }
    } catch (e) {
      console.error(e);
      messages.push(`${file.name}: 読み取りに失敗しました（${e.message}）`);
    }
  }
  setStatus(messages.join(' / ') + (succeeded ? '。内容を確認・修正してください。' : ''));
  dropzone.classList.remove('busy');
  fileInput.value = '';
  $('reread').hidden = accurate;
}

function addReceipt(receipt) {
  const { items, taxes, taxIncluded, subtotal } = receipt;
  $('tax-included').value = taxIncluded ? 'in' : 'out';
  const notes = [];
  if (subtotal !== null) {
    const sum = items.reduce((s, i) => s + i.price, 0);
    const expected = expectedSum(receipt);
    const label = expected === subtotal
      ? `小計（${subtotal.toLocaleString()}円）`
      : `小計から値引きを引いた金額（${expected.toLocaleString()}円）`;
    notes.push(sum === expected
      ? `✓ 読み取った金額の合計がレシートの${label}と一致しました`
      : `⚠ 読み取った金額の合計 ${sum.toLocaleString()}円 がレシートの${label}と違います。読み漏れ・読み違いがないか確認してください`);
  }
  const printed = taxes.map(t => `${t.label} ${t.amount}円`).join(' / ');
  if (printed) notes.push(`レシート記載の税額: ${printed}`);
  $('printed-tax').textContent = notes.join('　');
  const added = items.map(item => {
    const rate = item.reduced ? 8 : 10;
    return { name: item.name, price: item.price, rate, tax: calcTax(item.price, rate, taxIncluded), taxEdited: false };
  });
  fitPrintedTax(added, taxes);
  rows.push(...added);
  lastBatch?.rows.push(...added);
  recalc();
}

function recalc() {
  const included = $('tax-included').value === 'in';
  for (const r of rows) if (!r.taxEdited) r.tax = calcTax(r.price, r.rate, included);
  render();
}

function render() {
  tbody.replaceChildren(...rows.map((r, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="text" data-k="name" aria-label="品目"></td>
      <td><input type="number" data-k="price" class="num" aria-label="金額"></td>
      <td><select data-k="rate" aria-label="税率"><option value="10">10%</option><option value="8">8%</option></select></td>
      <td><input type="number" data-k="tax" class="num" aria-label="税額"></td>
      <td><button type="button" class="del" aria-label="削除">×</button></td>`;
    for (const el of tr.querySelectorAll('[data-k]')) {
      el.value = r[el.dataset.k];
      el.addEventListener('change', () => {
        const k = el.dataset.k;
        r[k] = k === 'name' ? el.value : Number(el.value) || 0;
        if (k === 'tax') r.taxEdited = true;
        else if (k !== 'name') r.taxEdited = false;
        recalc();
      });
    }
    tr.querySelector('.del').addEventListener('click', () => { rows.splice(i, 1); render(); });
    return tr;
  }));
  const sum = k => rows.reduce((s, r) => s + r[k], 0);
  $('sum-price').textContent = sum('price').toLocaleString();
  $('sum-tax').textContent = sum('tax').toLocaleString();
  $('download').disabled = rows.length === 0;
  $('empty').hidden = rows.length > 0;
}

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
fileInput.addEventListener('change', () => handleFiles(fileInput.files));
dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('over'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
dropzone.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('over');
  handleFiles(e.dataTransfer.files);
});

$('reread').addEventListener('click', () => {
  if (!lastBatch) return;
  // 直前の画像から追加した行を取り除いてから、高精度モードで読み直す
  rows = rows.filter(r => !lastBatch.rows.includes(r));
  render();
  handleFiles(lastBatch.files, true);
});
$('tax-included').addEventListener('change', () => {
  for (const r of rows) r.taxEdited = false;
  recalc();
});
$('add-row').addEventListener('click', () => {
  rows.push({ name: '', price: 0, rate: 10, tax: 0, taxEdited: false });
  render();
  tbody.lastElementChild?.querySelector('input')?.focus();
});
$('clear').addEventListener('click', () => {
  if (rows.length && !confirm('表の内容をすべて消去しますか？')) return;
  rows = [];
  lastBatch = null;
  $('reread').hidden = true;
  $('ocr-text').value = '';
  $('printed-tax').textContent = '';
  setStatus('');
  render();
});
$('download').addEventListener('click', () => {
  const blob = new Blob([toCSV(rows)], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `receipt_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

render();
