// ブラウザ内で動く無料の生成AI（WebLLM）でOCRテキストを品目・金額に整理する。
// モデルは利用者のPCで動くため、レシートの内容はどこにも送信されない。
const WEBLLM_URL = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.85/+esm';
const MODEL = 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC';

const PROMPT = `あなたは日本のレシートを読み取るアシスタントです。
OCRで読み取ったレシートのテキストが与えられます。誤認識を補正しながら、購入した品目だけを抜き出してください。
合計・小計・お預り・お釣り・消費税・店舗情報・日時の行は品目に含めないでください。
値引きは負の金額にしてください。軽減税率（8%）の印（※や*や軽）が付いた品目は reduced を true にしてください。
レシートが税込表示なら taxIncluded を true、外税（税抜表示）なら false にしてください。
次のJSONだけを出力してください:
{"items":[{"name":"品名","price":数値,"reduced":真偽値}],"taxIncluded":真偽値}`;

let enginePromise = null;

export function aiSupported() {
  return 'gpu' in navigator;
}

function loadEngine(onProgress) {
  if (!enginePromise) {
    enginePromise = import(WEBLLM_URL)
      .then(webllm => webllm.CreateMLCEngine(MODEL, {
        initProgressCallback: p => onProgress(`AIモデル準備中: ${p.text}`),
      }))
      .catch(e => { enginePromise = null; throw e; });
  }
  return enginePromise;
}

export async function structureWithAI(text, onProgress) {
  const engine = await loadEngine(onProgress);
  onProgress('AIで品目を整理中…');
  const res = await engine.chat.completions.create({
    messages: [
      { role: 'system', content: PROMPT },
      { role: 'user', content: text },
    ],
    temperature: 0,
    response_format: { type: 'json_object' },
  });
  const data = JSON.parse(res.choices[0].message.content);
  const items = (Array.isArray(data.items) ? data.items : [])
    .map(i => ({
      name: String(i.name ?? '').trim(),
      price: Math.round(Number(String(i.price).replace(/[^\d.-]/g, ''))),
      reduced: i.reduced === true,
    }))
    .filter(i => i.name && Number.isFinite(i.price));
  return { items, taxIncluded: data.taxIncluded !== false };
}
