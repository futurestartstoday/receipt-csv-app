// レシートのOCRテキストから品目・金額を取り出すルールベースの解析と、税額計算・CSV生成

// 品目ではない行（合計・支払・店舗情報・日時など）
const SKIP = /(合計|小計|総計|預り|預かり|お釣|釣銭|おつり|現金|支払|クレジット|カード|ポイント|対象|タイショウ|点数|領収|電話|TEL|登録番号|レジ(?!袋)|担当|責任者|No\.|PAY|ペイ|Suica|PASMO|nanaco|WAON|Edy|電子マネー|\d{2,4}\s*[年\/.-]\s*\d{1,2}\s*[月\/.-]|\d{1,2}:\d{2}\s*$)/i;
// 「外8 ¥108」「内10 ¥37」のような税率ごとの税額の行（品名部分）
const TAX_RATE_NAME = /^[(\s]*[外内]\s*\d{1,2}\s*%?\s*$/;
// カタカナの間にある、形の似た漢字・記号をカタカナに直す（例: コ口ッケ → コロッケ）
const KATAKANA_LOOKALIKE = { 口: 'ロ', 一: 'ー', 力: 'カ', 工: 'エ', 夕: 'タ', 卜: 'ト', 八: 'ハ', 二: 'ニ' };
const LOOKALIKE_RE = /(?<=[ァ-ヶー])[口一力工夕卜八二]|[口一力工夕卜八二](?=[ァ-ヶ])/g;
// OCRモデルが中国語の字体で出力しやすい文字を日本語の字体に直す
const VARIANTS = {
  对: '対', 费: '費', 值: '値', 价: '価', 计: '計', 总: '総', 额: '額', 现: '現', 预: '預',
  钱: '銭', 优: '優', 惠: '恵', 购: '購', 杂: '雑', 货: '貨', 鸡: '鶏', 鱼: '魚', 饮: '飲',
  酱: '醤', 盐: '塩', 时: '時', 间: '間', 别: '別', 叶: '葉', 发: '発', 卖: '売', 买: '買',
  课: '課', 减: '減',
};
const VARIANT_RE = new RegExp(`[${Object.keys(VARIANTS).join('')}]`, 'g');

// OCRの文字ボックスを行ごとにまとめてテキストにする。
// 丸まったレシートは行ごとに傾きが違うので、横長のボックスから行ごとの中心線を作り、
// 短いボックス（「外8」や金額など）はいちばん近い中心線の行に入れる。
export function groupLines(results) {
  const boxes = results.filter(r => r.text.trim()).map(({ text, box }) => {
    const p = box.points;
    const width = p ? Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y) : box.width;
    const height = p ? Math.hypot(p[3].x - p[0].x, p[3].y - p[0].y) : box.height;
    return {
      text: text.trim(),
      cx: p ? (p[0].x + p[1].x + p[2].x + p[3].x) / 4 : box.x + box.width / 2,
      cy: p ? (p[0].y + p[1].y + p[2].y + p[3].y) / 4 : box.y + box.height / 2,
      width,
      height,
      slope: p ? (p[1].y - p[0].y) / (p[1].x - p[0].x || 1) : 0,
    };
  });
  if (!boxes.length) return '';

  const lines = [];
  const lineY = (line, x) => line.cy + line.slope * (x - line.cx);
  const nearest = (b, list) => {
    let best = null;
    for (const line of list) {
      const d = Math.abs(b.cy - lineY(line, b.cx));
      if (!best || d < best.d) best = { line, d };
    }
    return best;
  };
  // 長いボックスほど傾きが正確なので先に行を作る
  for (const b of [...boxes].sort((a, c) => c.width - a.width)) {
    const hit = nearest(b, lines);
    if (hit && hit.d < hit.line.height * 0.5) {
      hit.line.boxes.push(b);
    } else {
      // 短いボックスの傾きは当てにならないので近くの行の傾きを使う
      const slope = b.width > b.height * 4 || !hit ? b.slope : hit.line.slope;
      lines.push({ cx: b.cx, cy: b.cy, slope, height: b.height, boxes: [b] });
    }
  }
  const midX = boxes.reduce((s, b) => s + b.cx, 0) / boxes.length;
  return lines
    .sort((a, b) => lineY(a, midX) - lineY(b, midX))
    .map(l => l.boxes.sort((a, b) => a.cx - b.cx).map(b => b.text).join(' '))
    .join('\n');
}
// 税額の行
const TAX = /(消費税|税額|内税|外税|税等)/;
// 数量・単価の補足行（例: 2個 × @150、1点 5500 ¥5,500）
const QTY = /[@＠]|\d\s*[個点]\s*[x×X]|^\d{1,3}\s*[個点]\s+[\d¥￥\\]/;
// 値引き・割引の行
const DISCOUNT = /値引|割引|引き|クーポン/;
// 行末の金額（例: 品名 ¥1,234※、品名 *110）。
// 英数字のすぐ後ろの数字は品番の一部（例: ZZ678、LN12345-2）なので金額にしない
const PRICE_LINE = /^(.*?)[\s¥￥\\*＊]*(?<![A-Za-z0-9\-\/.,])(-?\d{1,3}(?:,\d{3})+|-?\d{1,7})\s*円?\s*([※*＊軽外内]?)\s*$/;

export function normalize(text) {
  return text
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    // 半角カナの濁点・半濁点は「`」「°」などと読まれるので、前のかなと合成する（例: ハ° → パ、テ` → デ、ス” → ズ）
    // 「プ”」のように半濁点の字に濁点が付いて読まれたものは濁点の字にする（プ” → ブ）
    .replace(/([ぱぴぷぺぽパピプペポ])\s?[`´゛ﾞ"”]/g, c => c.normalize('NFD')[0] + '゙')
    .replace(/([ぁ-ゖァ-ヺ])\s?[`´゛ﾞ"”]/g, '$1゙')
    .replace(/([ぁ-ゖァ-ヺ])\s?[°º゜ﾟ]/g, '$1゚')
    .normalize('NFC')
    // すでに濁点付きの文字に重なって合成できなかった記号は捨てる
    .replace(/[゙゚]/g, '')
    .replace(VARIANT_RE, c => VARIANTS[c])
    .replace(LOOKALIKE_RE, c => KATAKANA_LOOKALIKE[c])
    .replace(/[，]/g, ',')
    .replace(/[：]/g, ':')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    // 「1.000」のように桁区切りが点で読まれた金額を直す
    .replace(/(\d)\.(\d{3})(?!\d)/g, '$1,$2')
    .replace(/[－ー−](?=\d)/g, '-')
    // Tesseractは日本語の文字間に空白を入れるので詰める
    .replace(/([^\x00-\x7F])[ \t]+(?=[^\x00-\x7F])/g, '$1');
}

export function parseReceipt(text) {
  const lines = normalize(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const items = [];
  const taxes = [];
  let taxIncluded = true;

  let reducedTarget = null;
  // 小計・合計より後ろ（お預り・お釣りなど）は品目ではない
  let pastTotal = false;
  // ただし小計と合計の間にある値引き（例: 小計 ¥19,800 → QR値引 -990 → 合計 ¥18,810）は品目に入れる
  let pastGrandTotal = false;
  let discountAfterSubtotal = 0;
  // 読み取り漏れの確認用に、レシートに印字された小計を覚えておく。
  // 「小計(税抜8%)」「小計(税抜10%)」のように税率ごとに分かれていれば足し合わせる
  let subtotal = null;
  let subtotalByRate = false;
  // 品名だけの行（次の「@158x 2 *316」の行に金額がある）
  let pendingName = null;

  for (const line of lines) {
    if (/外税|外消費税|税抜|^[(\s]*外\s*\d/.test(line)) taxIncluded = false;
    const body = line
      // 「(内消費税等 ¥27)」のような括弧付きの行にも対応する
      .replace(/[)）]\s*$/, '')
      // 金額の後ろの税区分の印（「¥158外」。「外」は「タト」「タ十」「タ」などと読まれやすい）
      .replace(/(\d)\s*(外|内|非|タト|夕ト)\s*$/, '$1')
      .replace(/([¥￥\\]\s*[\d,]+)\s*[^\d\s,]{1,2}\s*$/, '$1');
    const m = body.match(PRICE_LINE);
    if (/小計|合計/.test(line)) pastTotal = true;
    if (/合計|総計|預り|預かり|お釣|釣銭/.test(line)) pastGrandTotal = true;
    if (!m) {
      const name = cleanName(line);
      pendingName = !pastTotal && !SKIP.test(line) && !QTY.test(line) && /[^\d\s\-,.:]/.test(name) ? name : null;
      continue;
    }
    const amount = parseInt(m[2].replace(/,/g, ''), 10);
    if (/小計/.test(line)) {
      const byRate = /\d\s*%/.test(line);
      if (subtotal === null) [subtotal, subtotalByRate] = [amount, byRate];
      else if (byRate && subtotalByRate) subtotal += amount;
    }

    // 「(8%対象 ¥396)」「(外8 タイショウ ¥1,159)」
    if (/(8\s*%?|軽減)\D*(対象|タイショウ)/.test(line)) reducedTarget = amount;

    if (TAX.test(line) || TAX_RATE_NAME.test(m[1])) {
      taxes.push({ label: m[1].replace(/[()（）]/g, '').trim(), amount });
      continue;
    }
    // 「@158x 2 *316」のような数量の行は、直前の品名だけの行の金額として扱う
    const qtyName = QTY.test(line) ? pendingName : null;
    pendingName = null;
    const discountAfterTotal = pastTotal && !pastGrandTotal && !/小計/.test(line) && DISCOUNT.test(line);
    if ((pastTotal && !discountAfterTotal) || SKIP.test(line) || (QTY.test(line) && !qtyName)) continue;

    // 行頭の税区分の印（「外8」「内8」は軽減税率。「外18」「夕18」などと読まれることもある）
    const rateMark = m[1].match(/^[外内タ夕ト]{1,2}\s*(1?8|10)\s+/);
    const name = qtyName ?? cleanName(m[1].slice(rateMark ? rateMark[0].length : 0));
    // 名前が数字・記号だけの行は品目とみなさない
    if (!/[^\d\s\-,.:¥￥\\]/.test(name)) continue;
    const discount = DISCOUNT.test(name);
    const price = discount ? -Math.abs(amount) : amount;
    if (discountAfterTotal) discountAfterSubtotal += price;
    items.push({
      name,
      price,
      reduced: rateMark ? rateMark[1] !== '10' : /[※*＊軽]/.test(line),
    });
  }
  // ※印が一部しか読み取れなかったときは「8%対象」の金額から軽減税率の品目を推定する
  const markedSum = items.filter(i => i.reduced).reduce((s, i) => s + i.price, 0);
  if (reducedTarget && markedSum !== reducedTarget) {
    const subset = findSubset(items, reducedTarget);
    if (subset.length) items.forEach((item, i) => { item.reduced = subset.includes(i); });
  }
  // 品目（小計の後の値引きを含む）の合計と比べるのは、小計から値引きを引いた金額
  return { items, taxes, taxIncluded, subtotal, discountAfterSubtotal };
}

// 先頭の商品コード（例: 000043）や記号（※ # ! *）と、末尾の記号を取り除く
function cleanName(s) {
  return s
    .replace(/^\d{4,}\s*/, '')
    .replace(/^[※*＊軽#＃!！\s・.:]+|[\s・.:*＊]+$/g, '');
}

// レシートに税率ごとの税額が印字されていれば、品目ごとの税額の合計がそれと一致するよう
// 端数を金額の大きい品目から1円ずつ調整する（調整した行は taxEdited にする）
export function fitPrintedTax(rows, taxes) {
  for (const rate of [8, 10]) {
    const printed = taxes.find(t => new RegExp(`(^|\\D)${rate}\\s*%?$`).test(t.label));
    const target = rows.filter(r => r.rate === rate);
    if (!printed || !target.length) continue;
    const diff = printed.amount - target.reduce((s, r) => s + r.tax, 0);
    // 端数で説明できない差は読み取り違いとみなして触らない
    if (diff === 0 || Math.abs(diff) > target.length) continue;
    const sorted = [...target].sort((a, b) => b.price - a.price);
    for (let i = 0; i < Math.abs(diff); i++) {
      sorted[i].tax += Math.sign(diff);
      sorted[i].taxEdited = true;
    }
  }
}

// 金額の合計が target になる品目の組み合わせ（見つからなければ空）
function findSubset(items, target) {
  const from = new Array(target + 1).fill(null);
  from[0] = [];
  items.forEach((item, idx) => {
    if (item.price <= 0) return;
    for (let s = target; s >= item.price; s--) {
      if (!from[s] && from[s - item.price]) {
        from[s] = [...from[s - item.price], idx];
      }
    }
  });
  return from[target] ?? [];
}

// 1品目あたりの税額（円未満切り捨て）
export function calcTax(price, rate, taxIncluded) {
  return Math.trunc(taxIncluded ? price * rate / (100 + rate) : price * rate / 100);
}

export function toCSV(rows) {
  const esc = v => {
    let s = String(v ?? '');
    // Excelで数式として実行されないようにする
    if (typeof v === 'string' && /^[=+\-@]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const body = [['品目', '金額', '税額'], ...rows.map(r => [r.name, r.price, r.tax])]
    .map(r => r.map(esc).join(','))
    .join('\r\n');
  // BOM付きUTF-8にしてExcelで文字化けしないようにする
  return '﻿' + body + '\r\n';
}
