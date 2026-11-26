"use strict";
/*
 * 新聞拼圖 主程式
 * ------------------------------------------------------------
 * 1. AI 接入層：用使用者的 API key，直接從瀏覽器呼叫 Claude / OpenAI / Gemini
 * 2. 各項功能：抓新聞、整理成事件、依回饋改寫、聊天諮詢、今日簡報
 *    （每個功能只是「系統提示詞 + 資料」→ AI → 顯示結果）
 * 3. 畫面：分類（一般／財經／體育）、事件列表、事件詳情、聊天窗口
 */

/* ============ 小工具 ============ */
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function load(k, d){ try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch(e){ return d; } }
function save(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} }
const todayStr = () => new Date().toLocaleDateString("zh-TW", {year:"numeric", month:"long", day:"numeric", weekday:"long"});

/* ============ 1. AI 接入層 ============ */
const PROVIDERS = {
  anthropic: { label:"Claude", models:["claude-opus-5-5","claude-sonnet-5-5","claude-haiku-5-5"], web:true,
               hint:"預設 claude-opus-5-5。想省錢可改 claude-sonnet-5-5 或 claude-haiku-5-5。" },
  openai:    { label:"OpenAI", models:["gpt-4o-mini","gpt-4o"], url:"https://api.openai.com/v1/chat/completions",
               hint:"請填你的 OpenAI 帳號可以使用的模型名稱；如果出現「找不到模型」，請到 OpenAI 後台確認。" },
  gemini:    { label:"Gemini", models:["gemini-3.5-flash-lite","gemini-3.6-flash","gemini-3.1-flash-lite"], web:true, url:"https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
               hint:"使用 Gemini 的 OpenAI 相容介面；如果出現「找不到模型」，請到 Google AI Studio 確認模型名稱。" }
};
// Claude 新模型在被安全機制拒答時，可自動改由其他模型回答（server-side fallback）
const CLAUDE_FALLBACK_MODELS = ["claude-opus-5-5","claude-sonnet-5-5","claude-opus-5","claude-fable-5-1","claude-fable-5-2"];

let settings = Object.assign({provider:"anthropic", key:"", model:"", remember:false}, load("np-settings", {}));
function saveSettings(){
  save("np-settings", {provider:settings.provider, model:settings.model, remember:settings.remember, key: settings.remember ? settings.key : ""});
}
const modelOf = () => (settings.model || "").trim() || PROVIDERS[settings.provider].models[0];
const aiReady = () => !!settings.key;

class AIError extends Error { constructor(code, msg){ super(msg); this.code = code; } }

async function httpError(res){
  let detail = "";
  try { const j = await res.json(); detail = (j.error && (j.error.message || j.error)) || j.message || ""; if (Array.isArray(j) && j[0] && j[0].error) detail = j[0].error.message; } catch(e){}
  const s = res.status;
  if (s === 401 || s === 403) return new AIError("auth", "API key 無效或沒有權限，請到「設定」檢查。");
  if (s === 404) return new AIError("model", `找不到模型「${modelOf()}」，請到「設定」檢查模型名稱。`);
  if (s === 429) return new AIError("rate", "超過用量或速率限制，請稍後再試，或檢查帳戶餘額。" + (detail ? "\n（原始訊息：" + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 300) + "）" : ""));
  if (s === 529 || s >= 500) return new AIError("server", "AI 服務暫時忙碌，請稍後再試。");
  return new AIError("api", "AI 回傳錯誤：" + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 200));
}

/**
 * 統一的呼叫介面：所有功能都透過這個函式跟 AI 溝通。
 * system：系統提示詞；messages：[{role:"user"|"assistant", content:"..."}]
 * onText：有給就用串流，邊收邊回傳目前全文；webSearch：讓 Claude 上網搜尋
 */
async function callAI({system, messages, onText, webSearch=false, effort, signal}){
  if (!aiReady()) throw new AIError("nokey", "請先按右上角「設定」，輸入 API key。");
  try {
    if (settings.provider === "anthropic") return await callClaude({system, messages, onText, webSearch, effort, signal});
    if (settings.provider === "gemini" && webSearch) return await callGeminiSearch({system, messages, onText, signal});
    return await callOpenAICompatible({system, messages, onText, signal});
  } catch(e){
    if (e.name === "AbortError") throw new AIError("cancelled", "已停止");
    if (e instanceof AIError) throw e;
    throw new AIError("network", "連不上 AI 服務。請確認網路連線；如果持續發生，可能是瀏覽器擋下了跨網域請求。");
  }
}

async function callClaude({system, messages, onText, webSearch, effort, signal}){
  const model = modelOf();
  const headers = {
    "content-type":"application/json",
    "x-api-key": settings.key,
    "anthropic-version":"2026-10-21",
    "anthropic-dangerous-direct-browser-access":"true"   // 允許直接從瀏覽器呼叫
  };
  const body = { model, max_tokens: onText ? 32000 : 16000, system, messages };
  if (effort) body.output_config = { effort };
  if (CLAUDE_FALLBACK_MODELS.includes(model)){ headers["anthropic-beta"] = "server-side-fallback-2026-07-01"; body.fallbacks = "default"; }
  if (webSearch) body.tools = [{ type:"web_search_20260209", name:"web_search", max_uses:8 }];

  // 串流模式（聊天、簡報、整理時顯示進度）
  if (onText && !webSearch){
    const res = await fetch("https://api.anthropic.com/v1/messages", {method:"POST", headers, body:JSON.stringify({...body, stream:true}), signal});
    if (!res.ok) throw await httpError(res);
    let text = "", stop = null;
    await readSSE(res, data => {
      let ev; try { ev = JSON.parse(data); } catch(e){ return; }
      if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta"){ text += ev.delta.text; onText(text); }
      else if (ev.type === "message_delta" && ev.delta && ev.delta.stop_reason) stop = ev.delta.stop_reason;
      else if (ev.type === "error") throw new AIError("api", "AI 回傳錯誤：" + ((ev.error && ev.error.message) || ""));
    });
    if (stop === "refusal") throw new AIError("refused", "AI 拒絕回答這個內容，請換個說法。");
    return text;
  }

  // 一般模式（含網路搜尋；搜尋太久時 API 會回 pause_turn，要接著送）
  let msgs = messages.slice(), out = "";
  for (let round = 0; round < 5; round++){
    const res = await fetch("https://api.anthropic.com/v1/messages", {method:"POST", headers, body:JSON.stringify({...body, messages:msgs}), signal});
    if (!res.ok) throw await httpError(res);
    const data = await res.json();
    if (data.stop_reason === "refusal") throw new AIError("refused", "AI 拒絕回答這個內容，請換個說法。");
    out += (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    if (data.stop_reason === "pause_turn"){ msgs = msgs.concat([{role:"assistant", content:data.content}]); continue; }
    if (onText) onText(out);
    return out;
  }
  return out;
}

async function callOpenAICompatible({system, messages, onText, signal}){
  const url = PROVIDERS[settings.provider].url;
  const headers = { "content-type":"application/json", "authorization":"Bearer " + settings.key };
  const body = { model: modelOf(), messages: [{role:"system", content:system}, ...messages] };
  if (onText){
    const res = await fetch(url, {method:"POST", headers, body:JSON.stringify({...body, stream:true}), signal});
    if (!res.ok) throw await httpError(res);
    let text = "";
    await readSSE(res, data => {
      if (data === "[DONE]") return;
      let ev; try { ev = JSON.parse(data); } catch(e){ return; }
      const d = ev.choices && ev.choices[0] && ev.choices[0].delta && ev.choices[0].delta.content;
      if (d){ text += d; onText(text); }
    });
    return text;
  }
  const res = await fetch(url, {method:"POST", headers, body:JSON.stringify(body), signal});
  if (!res.ok) throw await httpError(res);
  const data = await res.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
}

async function callGeminiSearch({system, messages, onText, signal}){
  const model = modelOf().replace(/^models\//, "");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const headers = { "content-type":"application/json", "x-goog-api-key": settings.key };
  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents: messages.map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }]
    })),
    tools: [{ google_search: {} }]
  };
  const res = await fetch(url, {method:"POST", headers, body:JSON.stringify(body), signal});
  if (res.status === 429) throw new AIError("rate", "Gemini 的「上網搜尋」額度不足（免費方案通常不含或很少）。可以改用「貼上新聞」，或到 Google AI Studio 開啟帳單（Set up billing）後再試。");
  if (!res.ok) throw await httpError(res);
  const data = await res.json();
  const cand = data.candidates && data.candidates[0];
  if (!cand) throw new AIError("api", "Gemini 沒有回傳內容，請再試一次。");
  if (cand.finishReason === "SAFETY" || cand.finishReason === "RECITATION"){
    throw new AIError("refused", "AI 拒絕回答這個內容，請換個說法。");
  }
  const parts = (cand.content && cand.content.parts) || [];
  const out = parts.filter(p => !p.thought && typeof p.text === "string").map(p => p.text).join("");
  if (onText) onText(out);
  return out;
}

// 讀取 Server-Sent Events 串流，每收到一筆 data 就呼叫 onData
async function readSSE(res, onData){
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = "";
  for (;;){
    const {value, done} = await reader.read();
    if (done) break;
    buf += dec.decode(value, {stream:true}).replace(/\r/g, "");
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0){
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = chunk.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trim()).join("");
      if (data) onData(data);
    }
  }
}

// 從 AI 回覆中取出 JSON（容許前後多一句話或用 ``` 包起來）
function parseJSON(text){
  const t = String(text || "").trim();
  try { return JSON.parse(t); } catch(e){}
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence){ try { return JSON.parse(fence[1]); } catch(e){} }
  const a = t.search(/[\[{]/), b = Math.max(t.lastIndexOf("]"), t.lastIndexOf("}"));
  if (a >= 0 && b > a){ try { return JSON.parse(t.slice(a, b + 1)); } catch(e){} }
  throw new AIError("json", "AI 回覆的格式不完整，請再試一次。");
}

/* ============ 系統提示詞（可在設定中修改） ============ */
let promptOverrides = load("np-prompts", {});
const P = name => (promptOverrides[name] != null ? promptOverrides[name] : DEFAULT_PROMPTS[name].text);

/* ============ 狀態 ============ */
const CATS = ["一般","財經","體育"];
const CK = {一般:"gen", 財經:"fin", 體育:"sport"};
const ck = c => "c-" + (CK[c] || "all");

let items = SAMPLE_ITEMS.map(r => ({id:r[0], outlet:r[1], title:r[2], body:"", url:"", hint:"", mine:false}));
const byId = id => items.find(x => x.id === id);

const state = {
  events: JSON.parse(JSON.stringify(SAMPLE_EVENTS)), origin:"sample", dataDate:SAMPLE_DATE,
  view:"events", cat:"全部", onlyFollow:false, sel:null, level:"std",
  busy:null, msg:null, msgErr:false, unsorted:0, note:{}, gloss:{},
  chat:[], chatBusy:null, digest:{text:"", loading:false, err:null}
};
let prefs = Object.assign({follows:[], easy:false}, load("np-prefs", {}));
const savePrefs = () => save("np-prefs", prefs);
const easyLine = () => prefs.easy ? "\n（讀者偏好淺白說明）" : "";

const outletsOf = ev => [...new Set(ev.sources.map(byId).filter(Boolean).map(x => x.outlet))];
const titlesOf = ev => ev.sources.map(byId).filter(Boolean).map(x => x.title);
const linkOf = x => x.url || ("https://news.google.com/search?q=" + encodeURIComponent(x.title) + "&hl=zh-TW&gl=TW&ceid=TW:zh-Hant");
const srcLines = ids => ids.map(byId).filter(Boolean).map(x =>
  `[${x.id}] ${x.outlet}｜${x.title}` + (x.hint ? `（分類提示：${x.hint}）` : "") + (x.body ? `\n    內文：${x.body.slice(0, 1200)}` : "")).join("\n");

/* 追蹤：用來源標題比對，所以重新整理後仍認得同一個事件 */
function followOf(ev){ const ts = titlesOf(ev); return prefs.follows.find(f => f.title === ev.title || f.seen.some(t => ts.includes(t))); }
function newCount(ev){ const f = followOf(ev); return f ? titlesOf(ev).filter(t => !f.seen.includes(t)).length : 0; }
function markSeen(ev){
  const f = followOf(ev); if (!f) return;
  const ts = titlesOf(ev);
  if (ts.some(t => !f.seen.includes(t)) || f.title !== ev.title){ f.seen = [...new Set([...f.seen, ...ts])]; f.title = ev.title; savePrefs(); }
}
function toggleFollow(ev){
  const f = followOf(ev);
  if (f) prefs.follows = prefs.follows.filter(x => x !== f); else prefs.follows.push({title:ev.title, seen:titlesOf(ev)});
  savePrefs();
}

/* ============ 2. 功能：每個都是「系統提示詞 + 資料」 ============ */
let ctl = null, tick = null;
function startBusy(label){
  const t0 = Date.now();
  state.busy = {label, sec:0, found:0, t0}; state.msg = null; render();
  clearInterval(tick); tick = setInterval(() => { if (state.busy){ state.busy.sec = Math.round((Date.now() - t0) / 1000); renderStatus(); } }, 1000);
  ctl = new AbortController(); return ctl.signal;
}
function endBusy(msg, isErr){ clearInterval(tick); const sec = state.busy ? Math.round((Date.now() - state.busy.t0) / 1000) : 0; state.busy = null; ctl = null; if (msg != null){ state.msg = msg.replace("{sec}", sec); state.msgErr = !!isErr; } render(); }
function errMsg(e){ return (e && e.code === "cancelled") ? "已停止。" : "⚠ " + ((e && e.message) || "發生錯誤，請再試一次。"); }

// 功能 A：抓今日新聞（Claude 網路搜尋）
async function runFetch(){
  if (state.busy) return;
  if (!PROVIDERS[settings.provider].web){ state.msg = "⚠ 上網抓新聞目前僅支援 Claude 與 Gemini。OpenAI 請用「貼上新聞」，或直接整理內建範例。"; state.msgErr = true; render(); return; }
  const signal = startBusy(`${PROVIDERS[settings.provider].label} 正在上網搜尋今天的一般、財經、體育新聞`);
  try {
    const text = await callAI({system:P("fetch"), messages:[{role:"user", content:`今天是 ${todayStr()}。請搜尋並整理今天的一般、財經、體育新聞。`}], webSearch:true, effort:"medium", signal});
    const arr = parseJSON(text);
    if (!Array.isArray(arr) || !arr.length) throw new AIError("json", "沒有抓到新聞，請再試一次。");
    const n = useFetched(arr);
    endBusy(null);
    await runOrganize(`抓到 ${n} 則今日新聞。`);
  } catch(e){ endBusy(errMsg(e), true); }
}

// 用抓到的新聞取代目前清單（保留使用者自己貼的），回傳則數
function useFetched(arr){
  const mine = items.filter(x => x.mine);
  let id = 1;
  const fetched = arr.filter(a => a && a.title).slice(0, 45).map(a => ({
    id:id++, outlet:String(a.outlet || "未標示媒體"), title:String(a.title).slice(0, 150), body:String(a.snippet || ""),
    url: /^https?:\/\//.test(a.url || "") ? a.url : "", hint: CATS.includes(a.category) ? a.category : "", mine:false }));
  mine.forEach(m => { m.id = id++; });
  items = fetched.concat(mine);
  state.events = []; state.origin = "fetched"; state.dataDate = new Date().toLocaleDateString("zh-TW"); state.sel = null; state.note = {}; state.gloss = {};
  return fetched.length;
}

// 功能 A2：免費抓新聞（Google 新聞 RSS，不用 AI 的上網搜尋額度）
const RSS_FEEDS = [
  {cat:"一般", url:"https://news.google.com/rss?hl=zh-TW&gl=TW&ceid=TW:zh-Hant"},
  {cat:"財經", url:"https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=zh-TW&gl=TW&ceid=TW:zh-Hant"},
  {cat:"體育", url:"https://news.google.com/rss/headlines/section/topic/SPORTS?hl=zh-TW&gl=TW&ceid=TW:zh-Hant"}
];
// 瀏覽器不准網頁直接讀別的網站（CORS），所以透過免費的 rss2json 服務轉成 JSON（免費版每個來源 10 則）
async function fetchFeed(url, cat, signal){
  const res = await fetch("https://api.rss2json.com/v1/api.json?rss_url=" + encodeURIComponent(url), {signal});
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  if (data.status !== "ok" || !Array.isArray(data.items)) throw new Error(data.message || "RSS 讀取失敗");
  return data.items.map(it => storyOf(it, cat)).filter(s => s.length);
}
// 一則 RSS item = 一個新聞事件；Google 新聞會在 description 列出各家媒體對同一件事的報導
function storyOf(it, cat){
  const story = [];
  const d = new DOMParser().parseFromString(it.description || "", "text/html");
  d.querySelectorAll("li").forEach(li => {
    const a = li.querySelector("a"); if (!a) return;
    const title = a.textContent.trim();
    const outlet = li.textContent.replace(a.textContent, "").trim();
    if (title && !story.some(s => s.title === title)) story.push({outlet, title, url:a.getAttribute("href") || "", category:cat});
  });
  if (!story.length && it.title){   // 沒有列表時，用標題「標題 - 媒體」
    const m = String(it.title).match(/^(.*) - ([^-]+)$/);
    story.push({outlet: m ? m[2].trim() : "", title: m ? m[1].trim() : it.title, url:it.link || "", category:cat});
  }
  return story;
}
async function runRssFetch(){
  if (state.busy) return;
  if (!aiReady()){ state.msg = "⚠ 請先按右上角「設定」，輸入 API key。"; state.msgErr = true; render(); return; }
  const signal = startBusy("正在從 Google 新聞 RSS 抓今天的一般、財經、體育新聞");
  try {
    const results = await Promise.allSettled(RSS_FEEDS.map(f => fetchFeed(f.url, f.cat, signal)));
    if (signal.aborted) throw new AIError("cancelled", "已停止");
    // 每個分類最多 15 則；每個事件取 2 家媒體，讓 AI 能比對說法
    const PER_CAT = 15, PER_STORY = 2, arr = [];
    results.forEach(r => {
      if (r.status !== "fulfilled") return;
      let n = 0;
      for (const story of r.value){
        for (const a of story.slice(0, PER_STORY)){ if (n >= PER_CAT) break; arr.push(a); n++; }
        if (n >= PER_CAT) break;
      }
    });
    if (!arr.length) throw new AIError("network", "抓不到 RSS 新聞。免費轉送服務可能暫時故障，請稍後再試，或改用「貼上新聞」。");
    const failed = results.filter(r => r.status !== "fulfilled").length;
    const n = useFetched(arr);
    endBusy(null);
    await runOrganize(`從 RSS 抓到 ${n} 則新聞${failed ? `（有 ${failed} 個分類沒抓到）` : ""}。`);
  } catch(e){ endBusy(errMsg(e), true); }
}

// 功能 B：整理成事件（一般／財經／體育）
async function runOrganize(prefix){
  if (state.busy) return;
  const signal = startBusy(`${prefix || ""}AI 正在閱讀 ${items.length} 則新聞並整理成事件`);
  try {
    const text = await callAI({
      system:P("organize"),
      messages:[{role:"user", content:`新聞清單：\n${srcLines(items.map(x => x.id))}${easyLine()}`}],
      effort:"medium", signal,
      onText: t => { state.busy.found = (t.match(/"one_line"/g) || []).length; renderStatus(); }
    });
    const evs = normalize(parseJSON(text));
    if (!evs.length) throw new AIError("json", "AI 沒有整理出事件，請再試一次。");
    state.events = evs; state.origin = state.origin === "sample" ? "sample-ai" : state.origin === "sample-ai" ? "sample-ai" : "ai";
    state.sel = null; state.note = {}; state.gloss = {}; state.unsorted = 0;
    const used = new Set(evs.flatMap(e => e.sources)).size;
    endBusy(`${prefix || ""}AI 把 ${used} 則新聞整理成 ${evs.length} 個事件（{sec} 秒）。`);
  } catch(e){ endBusy(errMsg(e), true); }
}
function normalize(res){
  if (!Array.isArray(res)) return [];
  const ok = id => !!byId(Number(id));
  const strs = a => Array.isArray(a) ? a.filter(x => typeof x === "string" && x.trim()) : [];
  return res.filter(e => e && typeof e === "object").map(e => ({
    title:String(e.title || "未命名事件"), category: CATS.includes(e.category) ? e.category : "一般", topic:String(e.topic || ""),
    importance: Math.min(3, Math.max(1, Number(e.importance) || 1)),
    one_line:String(e.one_line || ""), summary:String(e.summary || e.one_line || ""),
    facts:(Array.isArray(e.facts) ? e.facts : []).filter(f => f && f.text).map(f => ({text:String(f.text), src:(Array.isArray(f.src) ? f.src : []).map(Number).filter(ok)})),
    conflicts:strs(e.conflicts),
    angles:(Array.isArray(e.angles) ? e.angles : []).filter(a => a && a.angle).map(a => ({outlets:strs(a.outlets), angle:String(a.angle)})),
    open_questions:strs(e.open_questions).slice(0, 2),
    sources:[...new Set((Array.isArray(e.sources) ? e.sources : []).map(Number).filter(ok))]
  })).filter(e => e.sources.length).sort((a, b) => b.importance - a.importance);
}

// 功能 C：依讀者回饋改寫（不準確／太難懂）
async function runRewrite(ev, kind){
  const key = ev.title;
  state.note[key] = {loading:true, text: kind === "wrong" ? "AI 正在只根據來源重寫摘要…" : "AI 正在改寫成淺白版本…"}; renderDetail(true);
  try {
    const text = await callAI({system:P("rewrite"), effort:"low", messages:[{role:"user", content:
      `回饋類型：${kind === "wrong" ? "不準確" : "太難懂"}\n\n事件：${ev.title}\n目前摘要：${ev.summary}\n來源：\n${srcLines(ev.sources)}`}]});
    const r = parseJSON(text);
    if (!r || !r.summary) throw new AIError("json", "AI 回覆的格式不完整，請再試一次。");
    ev.summary = String(r.summary);
    if (kind === "wrong"){
      if (r.one_line) ev.one_line = String(r.one_line);
      if (Array.isArray(r.facts)) ev.facts = r.facts.filter(f => f && f.text).map(f => ({text:String(f.text), src:(Array.isArray(f.src) ? f.src : []).map(Number).filter(id => ev.sources.includes(id))}));
      state.note[key] = {text:"已依你的回饋，只根據來源重寫了摘要與事實。"};
    } else {
      state.gloss[key] = (Array.isArray(r.glossary) ? r.glossary : []).filter(g => g && g.term).slice(0, 4);
      prefs.easy = true; savePrefs();
      state.note[key] = {text:"已改寫成淺白版本。AI 記住了這個偏好，之後的整理、聊天和簡報都會用淺白說法。"};
    }
  } catch(e){ state.note[key] = {text:errMsg(e)}; }
  render();
}

// 功能 D：新聞諮詢聊天
function newsContext(){
  const sel = state.events[state.sel];
  const evLines = state.events.map((e, i) => `#${i + 1}【${e.category}】${e.title}：${e.one_line}（來源 ${e.sources.join(",")}）` + (e.conflicts.length ? `\n   說法不一：${e.conflicts.join("；")}` : "")).join("\n");
  let ctx = `資料日期：${state.dataDate}\n\n事件列表：\n${evLines}\n\n所有來源：\n${srcLines(items.map(x => x.id))}`;
  if (sel) ctx += `\n\n使用者目前正在看的事件：${sel.title}\n摘要：${sel.summary}`;
  return ctx;
}
async function sendChat(q){
  q = q.trim(); if (!q || state.chatBusy) return;
  const turn = {q, a:"", loading:true};
  state.chat.push(turn); renderChat();
  // 只保留最近 8 輪對話；新聞資料只放在最新一則訊息，避免重複
  const history = state.chat.slice(0, -1).filter(t => t.a && !t.err).slice(-8).flatMap(t => [{role:"user", content:t.q}, {role:"assistant", content:t.a}]);
  const messages = history.concat([{role:"user", content:`【目前的新聞資料】\n${newsContext()}${easyLine()}\n\n【使用者的訊息】\n${q}`}]);
  state.chatBusy = new AbortController(); renderChat();
  try {
    turn.a = await callAI({system:P("chat"), messages, effort:"low", signal:state.chatBusy.signal, onText:t => { turn.a = t; renderChat(); }});
  } catch(e){ turn.err = errMsg(e); }
  turn.loading = false; state.chatBusy = null; renderChat();
}

// 功能 E：今日簡報（整理後送出給自己）
async function runDigest(){
  const d = state.digest;
  if (d.loading) return;
  d.loading = true; d.text = ""; d.err = null; renderDigest();
  const data = state.events.map(e => ({category:e.category, title:e.title, importance:e.importance, one_line:e.one_line, conflicts:e.conflicts, outlets:outletsOf(e)}));
  try {
    d.text = await callAI({system:P("digest"), effort:"low", messages:[{role:"user", content:`日期：${state.dataDate}${easyLine()}\n事件資料：\n${JSON.stringify(data)}`}], onText:t => { d.text = t; renderDigest(); }});
  } catch(e){ d.err = errMsg(e); }
  d.loading = false; renderDigest();
}

/* ============ 3. 畫面 ============ */
function visible(){
  return state.events.map((e, i) => ({e, i})).filter(({e}) => (state.cat === "全部" || e.category === state.cat) && (!state.onlyFollow || followOf(e)));
}
function renderTop(){
  const el = $("aiState");
  if (aiReady()){ el.className = "ai-state on"; el.textContent = `AI：${PROVIDERS[settings.provider].label}・${modelOf()}`; }
  else { el.className = "ai-state off"; el.textContent = "尚未設定 API key"; }
  const canWeb = !!PROVIDERS[settings.provider].web;
  $("fetchBtn").disabled = !!state.busy || !canWeb;
  $("fetchBtn").title = canWeb ? `讓 ${PROVIDERS[settings.provider].label} 上網搜尋今天的新聞` : "只有 Claude 與 Gemini 支援上網搜尋";
  $("aiBtn").disabled = !!state.busy;
  $("rssBtn").disabled = !!state.busy;
  $("digestBtn").disabled = !state.events.length;
}
function renderTabs(){
  const cats = ["全部", ...CATS];
  $("catTabs").innerHTML = cats.map(c => {
    const n = c === "全部" ? state.events.length : state.events.filter(e => e.category === c).length;
    return `<button role="tab" type="button" class="${ck(c)}" data-cat="${c}" aria-selected="${state.cat === c}">${c === "全部" ? "" : '<span class="dot"></span>'}${c} <span style="opacity:.6">${n}</span></button>`;
  }).join("");
  $("tabEvents").setAttribute("aria-selected", state.view === "events");
  $("tabRaw").setAttribute("aria-selected", state.view === "raw");
}
function renderStatus(){
  const el = $("status"), parts = [];
  el.className = "status" + (state.busy ? " busy" : state.msg && state.msgErr ? " err" : "");
  if (state.busy){
    const b = state.busy;
    parts.push(`<span><span class="spin"></span> <strong>${esc(b.label)}</strong>（${b.sec} 秒）${b.found ? `，已找出 ${b.found} 個事件…` : ""}</span><button class="btn" data-act="stop" type="button" style="padding:3px 10px;font-size:13px">停止</button>`);
  } else if (state.msg){
    parts.push(`<span><strong>${esc(state.msg)}</strong></span>`);
  } else if (state.origin === "sample"){
    parts.push(`<span>目前是<strong>內建範例</strong>（${SAMPLE_DATE} 的 ${items.length} 則真實新聞標題，已預先整理）。${aiReady() ? (PROVIDERS[settings.provider].web ? "按「🌐 抓今日新聞」取得今天的新聞，或按「AI 整理」重新分析範例。" : "按「AI 整理」讓 AI 重新分析，或「貼上新聞」加入今天的新聞。") : "到右上角「設定」輸入 API key 就能使用 AI 功能。"}</span>`);
  }
  if (state.unsorted && !state.busy) parts.push(`<span>有 <strong>${state.unsorted}</strong> 則你貼上的新聞還沒整理，按「AI 整理」。</span>`);
  if (prefs.easy) parts.push(`<span class="pill">AI 記住了：你偏好淺白說明<button data-act="uneasy" type="button" aria-label="取消淺白偏好">✕</button></span>`);
  el.innerHTML = parts.join("");
  renderTop();
}
const tiles = n => `<span class="tiles">${"<i></i>".repeat(Math.min(n, 10))}</span>`;
function renderList(){
  const v = visible();
  if (!v.length){
    $("list").innerHTML = `<div class="empty">${state.onlyFollow ? "你還沒有追蹤任何事件。打開一個事件，按「☆ 追蹤這個事件」，之後有新報導就會標示出來。" : state.events.length ? "這個分類目前沒有事件。" : "還沒有整理好的事件。"}</div>`;
    return;
  }
  if (state.sel == null || !v.some(x => x.i === state.sel)) state.sel = v[0].i;
  $("list").innerHTML = v.map(({e, i}) => {
    const f = followOf(e), nn = newCount(e);
    return `<button class="card ${ck(e.category)}" data-i="${i}" aria-current="${i === state.sel}" type="button">
      <div class="card-top"><span class="cat">${esc(e.category)}${e.topic ? "・" + esc(e.topic) : ""}</span>${tiles(e.sources.length)}<span>${e.sources.length} 則・${outletsOf(e).length} 家</span>${e.conflicts.length ? '<span class="flag">說法不一</span>' : ""}${f ? `<span class="fol">★ 追蹤中${nn ? `・${nn} 則新報導` : ""}</span>` : ""}</div>
      <h3>${esc(e.title)}</h3><p>${esc(e.one_line)}</p></button>`;
  }).join("");
}
const shortOutlet = o => o.replace(/新聞網|新聞雲|新聞| CNA|全球資訊網|今日新聞/g, "").trim() || o;
const srcBtn = id => { const x = byId(Number(id)); return x ? `<button class="src" data-src="${x.id}" type="button" title="${esc(x.outlet + "｜" + x.title)}">${esc(shortOutlet(x.outlet))}</button>` : ""; };
function richText(t){
  return esc(t).split(/\n+/).filter(p => p.trim()).map(p => {
    const html = p.replace(/\[(\d+)\]/g, (m, n) => srcBtn(n) || m);
    return /^背景補充/.test(p.trim()) ? `<span class="bg-note">${html}</span>` : html;
  }).join("\n");
}
function renderDetail(keepScroll){
  const d = $("detail");
  const ev = state.events[state.sel];
  if (!visible().length || !ev){ d.className = "detail"; d.innerHTML = `<div class="thinking">選一個事件來看詳情。</div>`; return; }
  markSeen(ev);
  const key = ev.title, f = followOf(ev), g = state.gloss[key], note = state.note[key];
  d.className = "detail " + ck(ev.category);
  d.innerHTML = `
  <div class="d-head">
    <div class="d-meta"><span class="cat">${esc(ev.category)}${ev.topic ? "・" + esc(ev.topic) : ""}</span>${tiles(ev.sources.length)}<span>${ev.sources.length} 則報導・${outletsOf(ev).length} 家媒體</span><span>${state.origin === "sample" ? "範例結果" : "AI 整理"}</span></div>
    <h2>${esc(ev.title)}</h2>
  </div>
  <div class="d-row">
    <div class="seg" role="group" aria-label="摘要長度">
      <button data-level="short" aria-pressed="${state.level === "short"}" type="button">一句話</button>
      <button data-level="std" aria-pressed="${state.level === "std"}" type="button">標準</button>
    </div>
    <button class="btn follow" data-act="follow" aria-pressed="${!!f}" type="button">${f ? "★ 追蹤中" : "☆ 追蹤這個事件"}</button>
  </div>
  <div class="summary">${esc(state.level === "short" ? ev.one_line : ev.summary)}</div>
  ${g && g.length ? `<div class="gloss">${g.map(x => `<div><b>${esc(x.term)}</b>：${esc(x.explain)}</div>`).join("")}</div>` : ""}
  ${note ? `<div class="note">${note.loading ? '<span class="spin"></span> ' : ""}${esc(note.text)}</div>` : ""}
  <div class="fb"><span>這段摘要：</span>
    <button data-act="wrong" type="button">不準確，請重寫</button>
    <button data-act="hard" type="button">太難懂</button>
    <button class="ask" data-act="deep" type="button">💬 請 AI 深入解說</button>
  </div>
  ${ev.facts.length ? `<section class="blk"><h3>來源一致的事實</h3><ul class="facts">${ev.facts.map(x => `<li>${esc(x.text)}${x.src.map(srcBtn).join("")}</li>`).join("")}</ul></section>` : ""}
  ${ev.conflicts.length ? `<section class="blk conf"><h3>說法不一</h3><ul>${ev.conflicts.map(c => `<li>${esc(c)}</li>`).join("")}</ul></section>` : ""}
  ${ev.angles.length ? `<section class="blk"><h3>各媒體怎麼說</h3><div class="angles">${ev.angles.map(a => `<div class="angle"><div class="who">${a.outlets.map(o => `<span class="outlet">${esc(o)}</span>`).join("")}</div><div>${esc(a.angle)}</div></div>`).join("")}</div></section>` : ""}
  ${ev.open_questions.length ? `<section class="blk"><h3>來源沒有交代的事</h3><ul class="qs">${ev.open_questions.map(q => `<li>${esc(q)}</li>`).join("")}</ul></section>` : ""}
  <section class="blk"><h3>來源（${ev.sources.length}）</h3><ol class="srcs">${ev.sources.map(byId).filter(Boolean).map(x => `<li id="src-${x.id}"><span class="n">[${x.id}]</span><span><span class="outlet">${esc(x.outlet)}</span> <a href="${esc(linkOf(x))}" target="_blank" rel="noopener">${esc(x.title)}</a>${x.mine ? ' <span class="muted">你貼上的</span>' : ""}${x.body && !x.mine ? `<span class="snip">${esc(x.body)}</span>` : ""}</span></li>`).join("")}</ol></section>`;
  if (!keepScroll && window.innerWidth >= 1280) d.scrollTop = 0;
}
function renderChat(){
  const ev = state.events[state.sel];
  $("chatCtx").textContent = ev ? `AI 會參考所有事件，並特別注意「${ev.title}」` : "AI 會參考目前整理好的所有新聞";
  const log = $("chatLog");
  log.innerHTML = state.chat.length
    ? state.chat.map(t => `<div class="q">${esc(t.q)}</div><div class="a${t.err ? " err" : ""}">${t.err ? (t.a ? richText(t.a) + "\n" : "") + esc(t.err) : t.a ? richText(t.a) : '<span class="spin"></span> 思考中…'}</div>`).join("")
    : `<div class="chat-hello">嗨，我是你的新聞諮詢助理。可以問我新聞的來龍去脈、對你的影響，或聊聊看了新聞的心情。我回答時會標出依據的新聞來源。</div>`;
  log.scrollTop = log.scrollHeight;
  const sugs = state.chat.length ? [] : [
    "今天最重要的三件事是什麼？",
    "財經新聞對一般上班族有什麼影響？",
    ev ? `「${ev.title}」各家媒體說法差在哪？` : "哪些新聞的說法互相矛盾？"
  ];
  $("chatSugs").innerHTML = sugs.map(s => `<button type="button" data-q="${esc(s)}">${esc(s)}</button>`).join("");
  $("chatSend").textContent = state.chatBusy ? "停止" : "送出";
}
function renderRaw(){
  const evOf = id => state.events.findIndex(e => e.sources.includes(id));
  const assigned = items.filter(x => evOf(x.id) >= 0).length;
  $("rawView").innerHTML = `<div class="raw-head"><span>共 ${items.length} 則原始新聞（${state.origin === "fetched" || state.origin === "ai" ? "今日抓取" : "內建範例 " + SAMPLE_DATE}${items.some(x => x.mine) ? "，含你貼上的" : ""}）</span><span>${assigned} 則已歸入事件</span></div>
  <ol>${items.map(x => { const i = evOf(x.id), e = state.events[i];
    return `<li id="raw-${x.id}"><span class="n">[${x.id}]</span><div><a href="${esc(linkOf(x))}" target="_blank" rel="noopener">${esc(x.title)}</a>
    <div class="meta"><span>${esc(x.outlet)}</span>${x.hint ? `<span>${esc(x.hint)}</span>` : ""}${x.mine ? "<span>你貼上的</span>" : ""}${e ? `<button class="${ck(e.category)}" data-goto="${i}" type="button">→ ${esc(e.title)}</button>` : "<span>未歸入事件</span>"}</div></div></li>`; }).join("")}</ol>`;
}
function md(t){ // 簡易 Markdown 顯示（標題、清單、粗體）
  const lines = esc(t).split("\n"); let html = "", inList = false;
  for (const raw of lines){
    const l = raw.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    const li = l.match(/^\s*[-*]\s+(.*)/);
    if (li){ if (!inList){ html += "<ul>"; inList = true; } html += `<li>${li[1]}</li>`; continue; }
    if (inList && /^\s{2,}\S/.test(l)){ html = html.replace(/<\/li>$/, `<br>${l.trim()}</li>`); continue; }
    if (inList){ html += "</ul>"; inList = false; }
    if (/^#\s/.test(l)) html += `<h1>${l.slice(2)}</h1>`;
    else if (/^##\s/.test(l)) html += `<h2>${l.slice(3)}</h2>`;
    else if (l.trim()) html += `<p>${l}</p>`;
  }
  return html + (inList ? "</ul>" : "");
}
function renderDigest(){
  const d = state.digest;
  $("digestBody").innerHTML = d.text ? md(d.text) : d.loading ? `<div class="thinking"><span class="spin"></span> AI 正在寫今日簡報…</div>` : "";
  $("digestState").textContent = d.err || (d.loading ? "產生中…" : "");
  const has = !!d.text && !d.loading;
  ["digestCopy","digestSave","digestRedo"].forEach(id => $(id).disabled = !has && id !== "digestRedo" || d.loading);
  const mail = $("digestMail");
  mail.href = has ? "mailto:?subject=" + encodeURIComponent("今日新聞簡報 " + state.dataDate) + "&body=" + encodeURIComponent(d.text.slice(0, 1800)) : "#";
  mail.style.pointerEvents = has ? "" : "none"; mail.style.opacity = has ? "" : ".45";
}
function render(){
  renderTabs(); renderStatus();
  $("eventsView").hidden = state.view !== "events"; $("rawView").hidden = state.view !== "raw";
  renderList(); renderDetail(); renderChat();
  if (state.view === "raw") renderRaw();
}

/* ============ 事件處理 ============ */
$("catTabs").onclick = e => { const b = e.target.closest("[data-cat]"); if (!b) return; state.cat = b.dataset.cat; state.sel = null; render(); };
$("tabEvents").onclick = () => { state.view = "events"; render(); };
$("tabRaw").onclick = () => { state.view = "raw"; render(); };
$("onlyFollow").onchange = e => { state.onlyFollow = e.target.checked; state.sel = null; render(); };
$("fetchBtn").onclick = runFetch;
$("rssBtn").onclick = runRssFetch;
$("aiBtn").onclick = () => runOrganize();
$("pasteBtn").onclick = () => { $("pastePanel").hidden = !$("pastePanel").hidden; if (!$("pastePanel").hidden) $("pasteText").focus(); };
$("pasteCancel").onclick = () => { $("pastePanel").hidden = true; };
$("pasteAdd").onclick = () => {
  const blocks = $("pasteText").value.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  if (!blocks.length){ $("pasteText").focus(); return; }
  let next = Math.max(0, ...items.map(x => x.id)) + 1;
  blocks.forEach(b => {
    const lines = b.split("\n"); let first = lines.shift().trim(), outlet = "你貼上的";
    const m = first.match(/^(.{1,20}?)[｜|](.+)$/); if (m){ outlet = m[1].trim(); first = m[2].trim(); }
    items.push({id:next++, outlet, title:first.slice(0, 150), body:lines.join(" ").trim().slice(0, 2000), url:"", hint:"", mine:true});
  });
  state.unsorted += blocks.length; state.msg = `已加入 ${blocks.length} 則新聞。`; state.msgErr = false;
  $("pasteText").value = ""; $("pastePanel").hidden = true; render();
};
$("status").onclick = e => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  if (b.dataset.act === "stop" && ctl) ctl.abort();
  if (b.dataset.act === "uneasy"){ prefs.easy = false; savePrefs(); render(); }
};
$("list").onclick = e => {
  const c = e.target.closest("[data-i]"); if (!c) return;
  state.sel = Number(c.dataset.i); renderList(); renderDetail(); renderChat();
  if (window.innerWidth < 900) $("detail").scrollIntoView({behavior:"smooth", block:"start"});
};
function gotoSource(id){
  const here = document.getElementById("src-" + id);
  if (here){ flash(here); return; }
  const i = state.events.findIndex(e => e.sources.includes(id));
  if (i >= 0){ state.view = "events"; state.cat = "全部"; state.sel = i; render(); flash(document.getElementById("src-" + id)); }
  else { state.view = "raw"; render(); flash(document.getElementById("raw-" + id)); }
}
function flash(el){ if (!el) return; el.scrollIntoView({behavior:"smooth", block:"center"}); el.classList.add("hl"); setTimeout(() => el.classList.remove("hl"), 1600); }
$("detail").onclick = e => {
  const ev = state.events[state.sel]; if (!ev) return;
  const s = e.target.closest("[data-src]"); if (s){ gotoSource(Number(s.dataset.src)); return; }
  const l = e.target.closest("[data-level]"); if (l){ state.level = l.dataset.level; renderDetail(true); return; }
  const a = e.target.closest("[data-act]"); if (!a) return;
  const act = a.dataset.act;
  if (act === "follow"){ toggleFollow(ev); renderList(); renderDetail(true); }
  if (act === "wrong" || act === "hard") runRewrite(ev, act);
  if (act === "deep"){ sendChat(`請深入解說「${ev.title}」：來龍去脈是什麼？為什麼重要？各家媒體的說法差在哪？`); $("chat").scrollIntoView({behavior:"smooth", block:"nearest"}); }
};
$("rawView").onclick = e => { const b = e.target.closest("[data-goto]"); if (!b) return; state.view = "events"; state.cat = "全部"; state.sel = Number(b.dataset.goto); render(); };
$("chatLog").onclick = e => { const s = e.target.closest("[data-src]"); if (s) gotoSource(Number(s.dataset.src)); };
$("chatSugs").onclick = e => { const b = e.target.closest("[data-q]"); if (b) sendChat(b.dataset.q); };
$("chatForm").onsubmit = e => {
  e.preventDefault();
  if (state.chatBusy){ state.chatBusy.abort(); return; }
  const v = $("chatInput").value; $("chatInput").value = ""; sendChat(v);
};
$("chatInput").onkeydown = e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing){ e.preventDefault(); $("chatForm").requestSubmit(); } };
$("chatClear").onclick = () => { if (state.chatBusy) state.chatBusy.abort(); state.chat = []; renderChat(); };

/* 今日簡報 */
$("digestBtn").onclick = () => {
  $("digestDlg").showModal();
  if (!aiReady()){ state.digest = {text:"", loading:false, err:"⚠ 請先到「設定」輸入 API key。"}; renderDigest(); return; }
  if (!state.digest.text) runDigest(); else renderDigest();
};
$("digestClose").onclick = () => $("digestDlg").close();
$("digestRedo").onclick = runDigest;
$("digestCopy").onclick = async () => {
  try { await navigator.clipboard.writeText(state.digest.text); $("digestState").textContent = "已複製"; }
  catch(e){ const r = document.createRange(); r.selectNodeContents($("digestBody")); const s = getSelection(); s.removeAllRanges(); s.addRange(r); $("digestState").textContent = "已選取文字，請按 Ctrl+C 複製"; }
};
$("digestSave").onclick = () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([state.digest.text], {type:"text/markdown;charset=utf-8"}));
  a.download = `今日新聞簡報_${state.dataDate.replace(/\//g, "-")}.md`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

/* 設定 */
function fillSettings(){
  $("provider").value = settings.provider; $("apiKey").value = settings.key; $("remember").checked = settings.remember;
  $("model").value = settings.model; $("model").placeholder = PROVIDERS[settings.provider].models[0];
  $("modelList").innerHTML = PROVIDERS[settings.provider].models.map(m => `<option value="${m}">`).join("");
  $("modelHint").textContent = PROVIDERS[settings.provider].hint;
}
function readSettings(){
  const provChanged = $("provider").value !== settings.provider;
  settings.provider = $("provider").value; settings.key = $("apiKey").value.trim(); settings.remember = $("remember").checked;
  settings.model = provChanged ? "" : $("model").value.trim();
  saveSettings(); if (provChanged) fillSettings(); render();
}
["provider","apiKey","model","remember"].forEach(id => $(id).addEventListener("change", readSettings));
$("apiKey").addEventListener("input", () => { settings.key = $("apiKey").value.trim(); saveSettings(); renderTop(); });
$("showKey").onclick = () => { const k = $("apiKey"); k.type = k.type === "password" ? "text" : "password"; $("showKey").textContent = k.type === "password" ? "顯示" : "隱藏"; };
$("settingsBtn").onclick = () => { fillSettings(); fillPrompt(); $("settingsDlg").showModal(); };
$("testBtn").onclick = async () => {
  readSettings(); $("testResult").textContent = "測試中…";
  try {
    const t = await callAI({system:"你是連線測試助理。", effort:"low", messages:[{role:"user", content:"請只回覆：連線成功"}]});
    $("testResult").textContent = "✓ " + t.trim().slice(0, 30) + `（${PROVIDERS[settings.provider].label}・${modelOf()}）`;
  } catch(e){ $("testResult").textContent = errMsg(e); }
};
function fillPrompt(){
  const sel = $("promptSel");
  if (!sel.options.length) sel.innerHTML = Object.keys(DEFAULT_PROMPTS).map(k => `<option value="${k}">${DEFAULT_PROMPTS[k].name}</option>`).join("");
  const k = sel.value || "organize"; sel.value = k;
  $("promptDesc").textContent = DEFAULT_PROMPTS[k].desc;
  $("promptText").value = P(k);
  $("promptState").textContent = promptOverrides[k] != null ? "已修改（使用你的版本）" : "預設值";
}
$("promptSel").onchange = fillPrompt;
$("promptText").addEventListener("input", () => {
  const k = $("promptSel").value, v = $("promptText").value;
  if (v === DEFAULT_PROMPTS[k].text) delete promptOverrides[k]; else promptOverrides[k] = v;
  save("np-prompts", promptOverrides); $("promptState").textContent = promptOverrides[k] != null ? "已修改，已自動儲存" : "預設值";
});
$("promptReset").onclick = () => { delete promptOverrides[$("promptSel").value]; save("np-prompts", promptOverrides); fillPrompt(); };

render();

