import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReceipt, calcTax, toCSV, groupLines, fitPrintedTax } from '../parser.js';

// テスト用のレシートはすべて架空のもの（店名・品名・品番・金額は実在のレシートとは関係ない）。
// 実際のレシートで起きたOCRの読み違いの形だけを再現している

const sample = `スーパーまるやま 駅前店
TEL 03-1234-5678
2026年11月01日(土) 18:32
※ 牛 乳 1000ml   ¥238
※食パン 6枚        158
ボールペン          ¥110
値引                 -30
小計               ¥476
(8%対象  ¥366)
(内消費税等 8%  ¥27)
(10%対象 ¥110)
(内消費税等 10% ¥10)
合計               ¥476
お預り            ¥1,000
お釣り              ¥524`;

test('品目・値引き・税額を読み取る', () => {
  const r = parseReceipt(sample);
  assert.deepEqual(r.items, [
    { name: '牛乳 1000ml', price: 238, reduced: true },
    { name: '食パン 6枚', price: 158, reduced: true },
    { name: 'ボールペン', price: 110, reduced: false },
    { name: '値引', price: -30, reduced: false },
  ]);
  assert.deepEqual(r.taxes.map(t => t.amount), [27, 10]);
  assert.equal(r.taxIncluded, true);
});

test('外税レシートを判定する', () => {
  assert.equal(parseReceipt('外税 10%\nお茶 100').taxIncluded, false);
});

test('税額を切り捨てで計算する', () => {
  assert.equal(calcTax(238, 8, true), 17);
  assert.equal(calcTax(110, 10, true), 10);
  assert.equal(calcTax(100, 10, false), 10);
  assert.equal(calcTax(-30, 8, true), -2);
});

test('CSVはBOM付きでエスケープされる', () => {
  const csv = toCSV([{ name: '=SUM(A1)', price: 100, tax: 9 }, { name: 'A,"B"', price: 1, tax: 0 }]);
  assert.equal(csv, '﻿品目,金額,税額\r\n\'=SUM(A1),100,9\r\n"A,""B""",1,0\r\n');
});

test('※印がなくても「8%対象」の金額から軽減税率の品目を推定する', () => {
  const r = parseReceipt('牛乳 ￥238\n食パン ￥158\nボールペン ￥110\n（8%对象 ￥396）\n(内消费税等8%￥29)');
  assert.deepEqual(r.items.map(i => i.reduced), [true, true, false]);
  assert.deepEqual(r.taxes, [{ label: '内消費税等8%', amount: 29 }]);
});

test('傾いた画像の文字ボックスを行ごとにまとめる', () => {
  // 右に行くほど下がる（傾き0.08）2行のレシート
  const box = (text, x, y, w) => ({
    text,
    box: { x, y, width: w, height: 20 + w * 0.08,
      points: [{ x, y }, { x: x + w, y: y + w * 0.08 }, { x: x + w, y: y + w * 0.08 + 20 }, { x, y: y + 20 }] },
  });
  const text = groupLines([
    box('￥238', 300, 24, 60), box('牛乳', 20, 0, 60),
    box('食パン', 20, 30, 80), box('￥158', 300, 54, 60),
  ]);
  assert.equal(text, '牛乳 ￥238\n食パン ￥158');
});

// 外税・商品コード付き・電子マネー払いのレシートのOCR結果（架空）
const codedReceipt = `责No00002031担当者4
1203JAN
000117りんご¥400
2000098765432JAN
000208#!ニンジン¥299
2007712004401JAN
002315ポテトコ口ッケ¥460
小計¥1,159
(外8 タイショウ¥1,159)
外8 ¥92
外税計¥92
(税合計¥92)
合計￥1,251
NFCPAY ¥1,251
お釣り¥0
お買上点数 3点
印は軽减税率対象商品です`;

test('外税・商品コード付きのレシートを読み取り、印字された税額に合わせる', () => {
  const r = parseReceipt(codedReceipt);
  assert.deepEqual(r.items, [
    { name: 'りんご', price: 400, reduced: true },
    { name: 'ニンジン', price: 299, reduced: true },
    { name: 'ポテトコロッケ', price: 460, reduced: true },
  ]);
  assert.equal(r.taxIncluded, false);
  const rows = r.items.map(i => ({ ...i, rate: 8, tax: calcTax(i.price, 8, false) }));
  fitPrintedTax(rows, r.taxes);
  // 切り捨てた税額の合計(91)を印字された税額(92)に合わせ、いちばん高い品目に1円足す
  assert.deepEqual(rows.map(x => x.tax), [32, 23, 37]);
});

test('※印が一部しか読めなくても「8%対象」から推定し直す', () => {
  const r = parseReceipt('※牛乳 ¥238\n食パン ¥158\nボールペン ¥110\n(8%対象 ¥396)');
  assert.deepEqual(r.items.map(i => i.reduced), [true, true, false]);
});

// スキャンした丸まったレシート（行頭「外8」・金額の後ろに「外」・半角カナ）のOCR結果（架空）
const scannedReceipt = `外8 ヤマダセイメンーインスタントラーメン¥158タト
夕18 ホッカイドウAーターバターキリミ¥298タト
外8 ナガネキ¥128外
外18 ギフケンサンホウレンソウ¥256外
(2個×@128)
外8 ギンザケキリミ¥1,580外
小計¥2,420
外税客額8 8% ¥193
買上点数 5点
合計十¥2,613
お予真心¥3,000
お釣り¥387`;

test('行頭の「外8」と金額の後ろの「外」を扱い、合計より後ろは品目にしない', () => {
  const r = parseReceipt(scannedReceipt);
  assert.deepEqual(r.items.map(i => [i.name, i.price, i.reduced]), [
    ['ヤマダセイメンーインスタントラーメン', 158, true],
    ['ホッカイドウAーターバターキリミ', 298, true],
    ['ナガネキ', 128, true],
    ['ギフケンサンホウレンソウ', 256, true],
    ['ギンザケキリミ', 1580, true],
  ]);
  assert.equal(r.subtotal, 2420);
  assert.equal(r.taxIncluded, false);
});

test('金額の後ろの印が「タ十」「タ」と読まれても品目にする', () => {
  const r = parseReceipt('外8 ミソラーメン¥178タ十\n外8 ポテトチップス¥148タ\nおにぎり 2個\n小計¥326');
  assert.deepEqual(r.items.map(i => [i.name, i.price]), [['ミソラーメン', 178], ['ポテトチップス', 148]]);
});

// 2個以上買った品目が「品名」と「@単価x 数量 *金額」の2行に分かれるレシートのOCR結果（架空）
const multiLineReceipt = `領収書
フランクフルト
@158x *316
Vピリ辛メンマの素 *120
Vプ°レミアムサラダチキン
@198x 2 *396
Vプ°レミアムマンゴ\`ープリ\`ン
@250x 2 *500
ABCレジ袋中1枚 5
小計(税抜8%) ¥1,332
消費税等(8%) ¥106
小計(税抜10%) ¥5
合計¥1,443
nanaco支払¥1,443`;

test('品名だけの行と「@単価x数量 *金額」の行を1品目にまとめ、税率別の小計を足す', () => {
  const r = parseReceipt(multiLineReceipt);
  assert.deepEqual(r.items.map(i => [i.name, i.price, i.reduced]), [
    ['フランクフルト', 316, true],
    ['Vピリ辛メンマの素', 120, true],
    ['Vプレミアムサラダチキン', 396, true],
    ['Vプレミアムマンゴープリン', 500, true],
    ['ABCレジ袋中1枚', 5, false],
  ]);
  assert.equal(r.subtotal, 1337);
  assert.equal(r.taxIncluded, false);
});

// 品番の行・「1点 単価 ¥金額」の行・小計の後の値引きがある領収書のOCR結果（架空）
const discountReceipt = `様
¥18,810
上記の通り領収いたしました
但し
ABC-12X-345ZZ 678/XABC12X345ZZ678
1点 8800 ¥8,800
K012 薄型レンス”UVタプ”ルカット/LN12345-2
1点 5500 ¥5,500
K012 薄型レンズUVダプ”ルカット/LN12345-2
1点 5500 ¥5,500
小計 3点¥19,800
QR値引1(5%) 5% -990
(無印:课税*:軽减税率H:非课税M:免税)
(D:値引除外)
合計¥18,810
(含む消費税等¥1,710)
(10%対象¥18,810内消費税¥1,710)
クレジットカード¥18,810
お釣り¥0
12345A6789012345 A678
担当者`;

test('品番で終わる品名の行・「1点 単価 ¥金額」の行・小計の後の値引きを読み取る', () => {
  const r = parseReceipt(discountReceipt);
  assert.deepEqual(r.items.map(i => [i.name, i.price, i.reduced]), [
    ['ABC-12X-345ZZ 678/XABC12X345ZZ678', 8800, false],
    ['K012 薄型レンズUVタブルカット/LN12345-2', 5500, false],
    ['K012 薄型レンズUVダブルカット/LN12345-2', 5500, false],
    ['QR値引1(5%) 5%', -990, false],
  ]);
  assert.equal(r.subtotal, 19800);
  assert.equal(r.discountAfterSubtotal, -990);
  assert.equal(r.taxIncluded, true);
  // 品目ごとの税額の合計がレシートの消費税額と一致する
  assert.equal(r.items.reduce((s, i) => s + calcTax(i.price, 10, true), 0), 1710);
});
