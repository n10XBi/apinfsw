/**
 * Cloudflare Worker (Classic syntax) — FIXED
 * - No `export default` (so it builds under Service Worker/Classic runtime)
 * - Uses `addEventListener('fetch', ...)`
 * - validateApiKey() reads KV via `env` (Modules) OR global binding (Classic)
 * - CORS helpers + Telegram bypass for /telegram/*
 * - /generate and /get_result enforce API key (except Telegram)
 * - Telegram bot UI flows preserved (models, loras, settings, prompt, etc.)
 *
 * NOTE:
 * - If you later switch to Modules, you can wrap with `export default { fetch(request, env, ctx) { ... } }`
 *   and keep the same `handleRequest` implementation. This file supports BOTH by checking `env` first, then globals.
 */

// ======= CONFIG =======
// Prefer setting ARTING_TOKEN as an Environment Variable in dashboard (ARTING_TOKEN),
// but fallback to hardcoded token if not provided.
const ARTING_TOKEN = typeof ARTING_TOKEN !== 'undefined' ? ARTING_TOKEN : (
  // fallback (PLEASE move to env var for security)
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjo4OTE2MSwiZXhwIjoxNzU2MDI2OTgxfQ.rkTVuPCz5b7icxAKKCrd3j3ZCSqm5F9adRgtUQRFWy4"
);

// A small in-memory store (ephemeral) for Telegram sessions
const BOT_TOKENS = new Set();
const SESSIONS = new Map();

// ======= CONSTANT OPTIONS =======
const MODEL_IDS = [
  "pastelMixPrunedFP16",
  "comicBabes_v2",
  "ghostmix_v20Bakedvae",
  "cyberrealisticSemi_v30",
  "mistoonJade_v10Anime",
  "fuwafuwamix_v15BakedVae",
  "furworldFurry",
  "maturemalemix_v14",
  "divineanimemix_V2",
  "asyncsMIX_v7",
  "cyberrealisticPony_v65",
  "cuteAnime_v10",
  "absolutereality_v181",
  "animatedModelsOf_31",
  "SDXLFaetastic_v24",
  "divineelegancemix_V10"
];

const LORA_IDS = [
  "add_detail","SeleneTer","COMMIX_r1","Sv5-10","StarRail_Kafka_AP_v4","asamiya_athena",
  "purah-nvwls-v3-final","sailor_venus_v2","lucy_offset","makima_offset",
  "keqing_lion_optimizer_dim64_loraModel_5e-3noise_token1_4-3-2023","one_last_misaka",
  "Rem_ReZero_v1_1","tifa-nvwls-v2","Genshin_Kirara_AP_v3","CHP_0.1v",
  "aidmaMidjourneyV6.1-v0.1","ponyv4_noob1_2_adamW-000017","detailed_notrigger","kachina",
  "ECuthDS3","Expressive_H-000001","Char-Genshin-Shenhe-V1","sailormoon-pdxl-nvwls-v1",
  "yui_kamishiro_Pony_v01","hentai_anime_style_pony_v2","BishopNew_Illustrious",
  "MixedLatina_LORA","latinaDollLikeness","MomoAyase","the_bt-10","EtherPDXLStyleXL","pixel_f2"
];

const SAMPLER_IDS = [
  "Euler a","Euler","LMS","Heun","DPM2","DPM2 a","DPM++ 2S a","DPM++ 2M",
  "DPM++ SDE","DPM fast","DPM adaptive","LMS Karras","DPM2 Karras","DPM2 a Karras",
  "DPM++ 2S a Karras","DPM++ 2M Karras","DPM++ SDE Karras"
];

const RESOLUTION_OPTIONS = ["512x768","768x512","512x512","768x768"];
const STEPS_OPTIONS = ["10","20","25","30","40","50"];
const GUIDANCE_OPTIONS = ["5.0","7.0","9.0","11.0","13.0"];
const CLIP_SKIP_OPTIONS = ["1","2","3","4","5"];
const SAMPLES_OPTIONS = ["1","2","3"];

// ======= UTIL =======
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key"
  };
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function getKVFromEnv(env) {
  // Prefer modules env, fallback to classic global binding
  return (env && env["Gen-api-txt2img"]) || globalThis["Gen-api-txt2img"]; // KV Namespace
}

// ======= TELEGRAM HELPERS =======
async function telegramApi(token, method, body) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  if (typeof body === "string") {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    return res.json();
  } else if (body instanceof FormData) {
    const res = await fetch(url, { method: "POST", body });
    return res.json();
  } else {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return res.json();
  }
}

async function sendLongMessage(botToken, chatId, text, extra = {}) {
  const chunks = text.match(/[\s\S]{1,4000}/g) || [];
  for (const chunk of chunks) {
    await telegramApi(botToken, "sendMessage", { chat_id: chatId, text: chunk, ...extra });
  }
}

// ======= ARTING API =======
async function generateImageArting(payload, env) {
  const token = (env && env.ARTING_TOKEN) || ARTING_TOKEN;
  const url = "https://api.arting.ai/api/cg/text-to-image/create";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to generate image, status ${res.status}: ${text}`);
  }
  const data = await res.json();
  if (data.code === 100000 && data.data && data.data.request_id) return data.data.request_id;
  throw new Error(`API error: ${data.message || "Unknown error"}`);
}

async function getImageResultArting(request_id, env) {
  const token = (env && env.ARTING_TOKEN) || ARTING_TOKEN;
  const url = "https://api.arting.ai/api/cg/text-to-image/get";
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ request_id })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to get image result, status ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data?.data?.output || null;
}

async function pollImageResultArting(request_id, env, { timeout = 180000, interval = 4000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const output = await getImageResultArting(request_id, env);
    if (output && output.length > 0) return output;
    await wait(interval);
  }
  throw new Error("Timeout reached, image not ready yet. Coba lagi ya, duniakuu 🥺");
}

// ======= SESSIONS =======
function getSessionKey(botToken, chatId) { return `${botToken}::${chatId}`; }

function ensureSession(botToken, chatId) {
  const key = getSessionKey(botToken, chatId);
  if (!SESSIONS.has(key)) {
    SESSIONS.set(key, {
      botToken,
      chatId,
      model_id: null,
      lora: {}, // id -> weight
      nsfw: true,
      height: 768,
      width: 768,
      samples: 3,
      negative_prompt: "",
      seed: -1,
      sampler: "Euler a",
      steps: 50,
      guidance: 7,
      clip_skip: 2,
      awaiting_prompt: false,
      awaiting_negative_prompt: false,
    });
  }
  return SESSIONS.get(key);
}

// ======= KEYBOARDS =======
function buildMainKeyboard() {
  return { reply_markup: { inline_keyboard: [
    [{ text: "Pilih Model", callback_data: "show_models" }],
    [{ text: "Pilih LORA", callback_data: "show_lora" }],
    [{ text: "Pengaturan Lanjutan", callback_data: "show_settings" }],
    [{ text: "Kirim Prompt", callback_data: "send_prompt" }],
  ] } };
}

function buildModelKeyboard() {
  const rows = [];
  for (let i = 0; i < MODEL_IDS.length; i += 2) {
    const a = MODEL_IDS[i];
    const b = MODEL_IDS[i + 1];
    const row = [];
    if (a) row.push({ text: a, callback_data: `model|${a}` });
    if (b) row.push({ text: b, callback_data: `model|${b}` });
    rows.push(row);
  }
  rows.push([{ text: "Lewati (pakai default)", callback_data: "model|default" }]);
  rows.push([{ text: "Kembali ke Menu Utama", callback_data: "main_menu" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function buildLoraKeyboard(session) {
  const rows = [];
  if (LORA_IDS.length === 0) {
    rows.push([{ text: "Ndak ada LORA yang tersedia, sayangku.", callback_data: "noop" }]);
    rows.push([{ text: "Kembali", callback_data: "main_menu" }]);
    return { reply_markup: { inline_keyboard: rows } };
  }
  for (let i = 0; i < LORA_IDS.length; i += 3) {
    const row = [];
    for (let j = 0; j < 3; j++) {
      const id = LORA_IDS[i + j];
      if (!id) continue;
      const selected = session.lora && session.lora[id] !== undefined;
      const label = selected ? `✓ ${id}` : id;
      const shortId = `${i}_${j}`;
      if (!session.loraMap) session.loraMap = {};
      session.loraMap[shortId] = id;
      row.push({ text: label, callback_data: `lora_toggle|${shortId}` });
    }
    rows.push(row);
  }
  rows.push([
    { text: "Atur Bobot LORA", callback_data: "lora_weights" },
    { text: "Selesai Pilih LORA", callback_data: "lora_done" },
  ]);
  rows.push([{ text: "Kembali ke Menu Utama", callback_data: "main_menu" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function buildLoraWeightsKeyboard(session) {
  const rows = [];
  const selectedIds = Object.keys(session.lora || {});
  if (selectedIds.length === 0) {
    rows.push([{ text: "Belum ada LORA terpilih", callback_data: "noop" }]);
    rows.push([{ text: "Kembali", callback_data: "back_to_lora" }]);
    return { reply_markup: { inline_keyboard: rows } };
  }
  for (const id of selectedIds) {
    rows.push([
      { text: `${id} (0.3)`, callback_data: `weight|${id}|0.3` },
      { text: `${id} (0.5)`, callback_data: `weight|${id}|0.5` },
      { text: `${id} (0.7)`, callback_data: `weight|${id}|0.7` },
      { text: `${id} (1.0)`, callback_data: `weight|${id}|1.0` },
    ]);
  }
  rows.push([{ text: "Selesai", callback_data: "back_to_lora" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function buildSettingsKeyboard(session) {
  const rows = [
    [{ text: `Samples: ${session.samples}`, callback_data: "show_samples" }],
    [{ text: `Resolusi: ${session.width}x${session.height}`, callback_data: "show_resolution" }],
    [{ text: `Negative Prompt`, callback_data: "set_negative_prompt" }],
    [{ text: `Sampler: ${session.sampler}`, callback_data: "show_samplers" }],
    [{ text: `Steps: ${session.steps}`, callback_data: "show_steps" }],
    [{ text: `Guidance Scale: ${session.guidance}`, callback_data: "show_guidance" }],
    [{ text: `Clip Skip: ${session.clip_skip}`, callback_data: "show_clip_skip" }],
    [{ text: `NSFW: ${session.nsfw ? "ON" : "OFF"}`, callback_data: `nsfw|${!session.nsfw}` }],
    [{ text: "Kembali ke Menu Utama", callback_data: "main_menu" }],
  ];
  return { reply_markup: { inline_keyboard: rows } };
}

function buildSamplesKeyboard() {
  const rows = [];
  for (let i = 0; i < SAMPLES_OPTIONS.length; i += 2) {
    const a = SAMPLES_OPTIONS[i];
    const b = SAMPLES_OPTIONS[i + 1];
    const row = [];
    if (a) row.push({ text: a, callback_data: `samples_set|${a}` });
    if (b) row.push({ text: b, callback_data: `samples_set|${b}` });
    rows.push(row);
  }
  rows.push([{ text: "Kembali", callback_data: "show_settings" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function buildResolutionKeyboard() {
  const rows = [];
  for (let i = 0; i < RESOLUTION_OPTIONS.length; i += 2) {
    const a = RESOLUTION_OPTIONS[i];
    const b = RESOLUTION_OPTIONS[i + 1];
    const row = [];
    if (a) row.push({ text: a, callback_data: `resolution_set|${a}` });
    if (b) row.push({ text: b, callback_data: `resolution_set|${b}` });
    rows.push(row);
  }
  rows.push([{ text: "Kembali", callback_data: "show_settings" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function buildSamplerKeyboard() {
  const rows = [];
  for (let i = 0; i < SAMPLER_IDS.length; i += 2) {
    const a = SAMPLER_IDS[i];
    const b = SAMPLER_IDS[i + 1];
    const row = [];
    if (a) row.push({ text: a, callback_data: `sampler_set|${a}` });
    if (b) row.push({ text: b, callback_data: `sampler_set|${b}` });
    rows.push(row);
  }
  rows.push([{ text: "Kembali", callback_data: "show_settings" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function buildStepsKeyboard() {
  const rows = [];
  for (let i = 0; i < STEPS_OPTIONS.length; i += 3) {
    const a = STEPS_OPTIONS[i];
    const b = STEPS_OPTIONS[i + 1];
    const c = STEPS_OPTIONS[i + 2];
    const row = [];
    if (a) row.push({ text: a, callback_data: `steps_set|${a}` });
    if (b) row.push({ text: b, callback_data: `steps_set|${b}` });
    if (c) row.push({ text: c, callback_data: `steps_set|${c}` });
    rows.push(row);
  }
  rows.push([{ text: "Kembali", callback_data: "show_settings" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function buildGuidanceKeyboard() {
  const rows = [];
  for (let i = 0; i < GUIDANCE_OPTIONS.length; i += 3) {
    const a = GUIDANCE_OPTIONS[i];
    const b = GUIDANCE_OPTIONS[i + 1];
    const c = GUIDANCE_OPTIONS[i + 2];
    const row = [];
    if (a) row.push({ text: a, callback_data: `guidance_set|${a}` });
    if (b) row.push({ text: b, callback_data: `guidance_set|${b}` });
    if (c) row.push({ text: c, callback_data: `guidance_set|${c}` });
    rows.push(row);
  }
  rows.push([{ text: "Kembali", callback_data: "show_settings" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function buildClipSkipKeyboard() {
  const rows = [];
  for (let i = 0; i < CLIP_SKIP_OPTIONS.length; i += 3) {
    const a = CLIP_SKIP_OPTIONS[i];
    const b = CLIP_SKIP_OPTIONS[i + 1];
    const c = CLIP_SKIP_OPTIONS[i + 2];
    const row = [];
    if (a) row.push({ text: a, callback_data: `clip_skip_set|${a}` });
    if (b) row.push({ text: b, callback_data: `clip_skip_set|${b}` });
    if (c) row.push({ text: c, callback_data: `clip_skip_set|${c}` });
    rows.push(row);
  }
  rows.push([{ text: "Kembali", callback_data: "show_settings" }]);
  return { reply_markup: { inline_keyboard: rows } };
}
const authHeader = request.headers.get("Authorization");
let apiKey = null;

if (authHeader && authHeader.startsWith("Bearer ")) {
  apiKey = authHeader.substring(7).trim();
} else {
  apiKey = request.headers.get("x-api-key");
}

if (!apiKey) {
  return {
    ok: false,
    res: new Response(JSON.stringify({ error: "Missing API key" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...corsHeaders() }
    })
  };
}

// ======= AUTH (KV) =======
async function validateApiKey(env, request, url) {
  // Bypass untuk Telegram routes
  if (url.pathname.startsWith("/telegram/")) return { ok: true };

  const authHeader = request.headers.get("Authorization");
  let key = null;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    key = authHeader.substring(7).trim();
  } else {
    key = request.headers.get("x-api-key") || url.searchParams.get("key");
  }

  if (!key) {
    return {
      ok: false,
      res: new Response(JSON.stringify({ error: "Missing API key" }), {
        status: 401,
        headers: corsHeaders()
      })
    };
  }

  const KV = getKVFromEnv(env);
  if (!KV) {
    return {
      ok: false,
      res: new Response(JSON.stringify({ error: "KV binding Gen-api-txt2img not found" }), {
        status: 500,
        headers: corsHeaders()
      })
    };
  }

  const raw = await KV.get(key);
  if (!raw) {
    return {
      ok: false,
      res: new Response(JSON.stringify({ error: "Invalid API key" }), {
        status: 403,
        headers: corsHeaders()
      })
    };
  }

  let rec;
  try { rec = JSON.parse(raw); } catch (e) { rec = {}; }

  if (rec.revoked) {
    return {
      ok: false,
      res: new Response(JSON.stringify({ error: "API key revoked" }), {
        status: 403,
        headers: corsHeaders()
      })
    };
  }

  if (typeof rec.usage === "number" && typeof rec.limit === "number" && rec.usage >= rec.limit) {
    return {
      ok: false,
      res: new Response(JSON.stringify({ error: "API limit exceeded" }), {
        status: 429,
        headers: corsHeaders()
      })
    };
  }

  return { ok: true, key, rec, KV };
}


  // Increment usage (best-effort)
  try {
    rec.usage = (rec.usage || 0) + 1;
    await KV.put(key, JSON.stringify(rec));
  } catch (e) {
    // ignore but log
    console.log('KV put error:', e);
  }

  return { ok: true, rec };


// ======= TELEGRAM HANDLERS =======
async function handleTelegramMessage(botToken, message, env) {
  const chatId = message.chat.id;
  const session = ensureSession(botToken, chatId);
  BOT_TOKENS.add(botToken);
  const text = message.text ? message.text.trim() : null;

  if (text && text.startsWith("/start")) {
    SESSIONS.delete(getSessionKey(botToken, chatId));
    ensureSession(botToken, chatId);
    await telegramApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: `Halo sayangkuuuu 👋\nAku bot AI Image. Mau buat gambar apa hari ini?` ,
      ...buildMainKeyboard()
    });
    return;
  }

  if (text && (text.toLowerCase() === "/cancel" || text.toLowerCase() === "batal")) {
    SESSIONS.delete(getSessionKey(botToken, chatId));
    await telegramApi(botToken, "sendMessage", { chat_id: chatId, text: "Oke dibatalin sayangkuuu 😌. Session direset." });
    return;
  }

  if (text && session.awaiting_prompt) {
    session.awaiting_prompt = false;

    const loraIds = Object.keys(session.lora || {});
    const loraWeights = loraIds.map(id => String(session.lora[id] ?? 0.7));
    const loraStrings = loraIds.map((id, i) => `<lora:${id}:${loraWeights[i]}>`).join(" ");
    const finalPrompt = `${loraStrings} ${text}`.trim();

    const payload = {
      prompt: finalPrompt,
      model_id: session.model_id || MODEL_IDS[0],
      samples: session.samples || 1,
      height: session.height || 768,
      width: session.width || 512,
      negative_prompt: session.negative_prompt || "",
      seed: session.seed ?? -1,
      sampler: session.sampler || "Euler a",
      steps: session.steps || 25,
      guidance: session.guidance || 7,
      clip_skip: session.clip_skip || 2,
      is_nsfw: !!session.nsfw,
      lora_ids: loraIds.length ? loraIds.join(",") : "",
      lora_weight: loraIds.length ? loraWeights.join(",") : "",
    };

    await sendLongMessage(botToken, chatId, `✨ Tunggu sebentar ya, my Angellin… 🥺`);

    try {
      const request_id = await generateImageArting(payload, env);
      const images = await pollImageResultArting(request_id, env, { timeout: 300000, interval: 5000 });
      if (!images || images.length === 0) throw new Error("No images returned");

      for (const img of images) {
        if (typeof img === "string" && img.startsWith("data:image")) {
          const match = img.match(/^data:(image\/[a-zA-Z]+);base64,(.+)$/);
          if (match) {
            const mime = match[1];
            const b64 = match[2];
            const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
            const form = new FormData();
            const file = new Blob([bytes], { type: mime });
            form.append("chat_id", String(chatId));
            form.append("photo", file, "image.png");
            await telegramApi(botToken, "sendPhoto", form);
          } else {
            await telegramApi(botToken, "sendMessage", { chat_id: chatId, text: "Gambar (base64) diterima tapi format nda dikenali." });
          }
        } else if (typeof img === "string") {
          await telegramApi(botToken, "sendPhoto", { chat_id: chatId, photo: img, caption: "🔥 Ini dia hasil gambarnya, sayangkuuuu!" });
        } else {
          await telegramApi(botToken, "sendMessage", { chat_id: chatId, text: "Hasil gambar nda dikenali." });
        }
      }

      await telegramApi(botToken, "sendMessage", { chat_id: chatId, text: "Selesai deh! Mau bikin lagi? 😉", ...buildMainKeyboard() });
    } catch (e) {
      console.error("generateErr", e);
      await telegramApi(botToken, "sendMessage", { chat_id: chatId, text: `😕 Gagal generate gambar: ${String(e.message)}` });
    }
    return;
  }

  if (text && session.awaiting_negative_prompt) {
    session.negative_prompt = text;
    session.awaiting_negative_prompt = false;
    await telegramApi(botToken, "sendMessage", { chat_id: chatId, text: `Negative Prompt diset: ${text}`, ...buildSettingsKeyboard(session) });
    return;
  }
}

async function handleTelegramCallback(botToken, cq) {
  const chatId = cq.message.chat.id;
  const data = cq.data || "";
  const session = ensureSession(botToken, chatId);

  try { await telegramApi(botToken, "answerCallbackQuery", { callback_query_id: cq.id }); } catch {}

  const parts = data.split("|");
  const cmd = parts[0];

  switch (cmd) {
    case "main_menu":
      await telegramApi(botToken, "sendMessage", { chat_id: chatId, text: "Kembali ke menu utama ya, sayangkuuu. 💖", ...buildMainKeyboard() });
      break;

    case "show_models":
      await telegramApi(botToken, "sendMessage", { chat_id: chatId, text: "Pilih model yang yuww mau:", ...buildModelKeyboard() });
      break;

    case "model": {
      const model = parts[1];
      session.model_id = model === "default" ? MODEL_IDS[0] : model;
      await telegramApi(botToken, "sendMessage", { chat_id: chatId, text: `Model diset ke: ${session.model_id}.`, ...buildMainKeyboard() });
      break;
    }

    case "show_lora":
      await telegramApi(botToken, "sendMessage", { chat_id: chatId, text: "Pilih sampai 3 LORA ya. Klik lagi untuk hapus.", ...buildLoraKeyboard(session) });
      break;

    case "lora_toggle": {
      const id = session.loraMap?.[parts[1]];
      if (!id) break;
      if (session.lora && session.lora[id] !== undefined) {
        delete session.lora[id];
        await telegramApi(botToken, "sendMessage", { chat_id: chatId, text: `LORA ${id} dihapus.`, ...buildLoraKeyboard(session) });
      } else {
        if (Object.keys(session.lora).length >= 3) {
          await telegramApi(botToken, "sendMessage", { chat_id: chatId, text: "Maksimum 3 LORA ya cintakkuuu 😅." });
          break;
        }
        session.lora[id] = 0.7;
        await telegramApi(botToken, "sendMessage", { chat_id: chatId, text: `LORA ${id} ditambahkan.`, ...buildLoraKeyboard(session) });
      }
      break;
    }

    case "lora_done": {
      const selectedLoras = Object.keys(session.lora).join(", ") || "(none)";
      await telegramApi(botToken, "sendMessage", {
        chat_id: chatId,
        text: `LORA terpilih: ${selectedLoras}\nAtur bobot atau kembali ke menu utama.`,
        reply_markup: { inline_keyboard: [
          [{ text: "Atur Bobot LORA", callback_data: "lora_weights" }],
          [{ text: "Kembali ke Menu Utama", callback_data: "main_menu" }],
        ]}
      });
      break;
    }

    case "lora_weights":
      await telegramApi(botToken, "sendMessage", { chat_id: chatId, text: "Pilih bobot untuk tiap LORA:", ...buildLoraWeightsKeyboard(session) });
      break;

    case "weight": {
      const loraId = parts[1];
      const weight = parseFloat(parts[2]);
      if (loraId && !isNaN(weight) && weight >= 0.1 && weight <= 1) {
        session.lora[loraId] = weight;
        await telegramApi(botToken, "sendMessage", { chat_id: chatId, text: `Bobot LORA ${loraId} diset ke ${weight}.`, ...buildLoraWeightsKeyboard(session) });
      } else {
        await telegramApi(botToken, "sendMessage", { chat_id: chatId, text: "Bobot harus antara 0.1 sampai 1.0 ya sayangku", ...buildLoraWeightsKeyboard(session) });
      }
      break;
    }

    case "back_to_lora":
      await telegramApi(botToken, "sendMessage", { chat_id: chatId, text: "Kembali ke menu LORA", ...buildLoraKeyboard(session) });
      break;

    case "show_settings":
      await telegramApi(botToken, "sendMessage", { chat_id: chatId, text: "Pilih pengaturan yang mau diubah, duniaku:", ...buildSettingsKeyboard(session) });
      break;

    case "show_samples":
      await telegramApi(botToken, "sendMessage", { chat_id: chatId, text: "Berapa gambar yang mau digenerate? (max 3):", ...buildSamplesKeyboard() });
      break;

    case "samples_set": {
      const samples = parseInt(parts[1]);
      if (!isNaN(samples)) {
        session.samples = samples;
        await telegramApi(botToken, "sendMessage", { chat_id: chatId, text: `Jumlah gambar diset ke: ${session.samples}.`, ...buildSettingsKeyboard(session) });
      } else {
        await telegramApi(botToken, "sendMessage", { chat_id: chatId, text: "Pilihan nda valid, coba lagi ya.", ...buildSettingsKeyboard(session) });
      }
      break;
    }

    case "show_resolution":
      await telegramApi(botToken, "sendMessage", { chat_id: chatId, text: "Pilih resolusi gambar, duniaku:", ...buildResolutionKeyboard() });
      break;

    case "resolution_set": {
      const [w, h] = (parts[1] || "").split("x");
      const W = parseInt(w), H = parseInt(h);
      if (!isNaN(W) && !isNaN(H)) {
        session.width = W; session.height = H;
        await telegramApi(botToken, "sendMessage", { chat_id: chatId, text: `Resolusi diset ke: ${W}x${H}.`, ...buildSettingsKeyboard(session) });
      }
      break;
    }

    case "set_negative_prompt":
      session.awaiting_negative_prompt = true;
      await telegramApi(botToken, "sendMessage", { chat_id: chatId, text: "Kirim Negative Prompt kamu ya (contoh: blur, bad anatomy, deformed)" });
      break;

    case "show_samplers":
      await telegramApi(botToken, "sendMessage", { chat_id: chatId, text: "Pilih Sampler yang kamu mau, sayangku:", ...buildSamplerKeyboard() });
      break;

    case "sampler_set":
      session.sampler = parts[1];
      await telegramApi(botToken, "sendMessage", { chat_id: chatId, text: `Sampler diset ke: ${session.sampler}.`, ...buildSettingsKeyboard(session) });
      break;

    case "show_steps":
      await telegramApi(botToken, "sendMessage", { chat_id: chatId, text: "Pilih jumlah Steps (langkah) yang kamu mau:", ...buildStepsKeyboard() });
      break;

    case "steps_set": {
      const steps = parseInt(parts[1]);
      if (!isNaN(steps)) {
        session.steps = steps;
        await telegramApi(botToken, "sendMessage", { chat_id: chatId, text: `Steps diset ke: ${session.steps}.`, ...buildSettingsKeyboard(session) });
      }
      break;
    }

    case "show_guidance":
      await telegramApi(botToken, "sendMessage", { chat_id: chatId, text: "Pilih Guidance Scale yang kamu mau:", ...buildGuidanceKeyboard() });
      break;

    case "guidance_set": {
      const guidance = parseFloat(parts[1]);
      if (!isNaN(guidance)) {
        session.guidance = guidance;
        await telegramApi(botToken, "sendMessage", { chat_id: chatId, text: `Guidance diset ke: ${session.guidance}.`, ...buildSettingsKeyboard(session) });
      }
      break;
    }

    case "show_clip_skip":
      await telegramApi(botToken, "sendMessage", { chat_id: chatId, text: "Pilih Clip Skip yang kamu mau:", ...buildClipSkipKeyboard() });
      break;

    case "clip_skip_set": {
      const clip_skip = parseInt(parts[1]);
      if (!isNaN(clip_skip)) {
        session.clip_skip = clip_skip;
        await telegramApi(botToken, "sendMessage", { chat_id: chatId, text: `Clip Skip diset ke: ${session.clip_skip}.`, ...buildSettingsKeyboard(session) });
      }
      break;
    }

    case "nsfw": {
      const val = parts[1] === "true";
      session.nsfw = val;
      await telegramApi(botToken, "sendMessage", { chat_id: chatId, text: `NSFW diset ke: ${session.nsfw}` });
      try {
        await telegramApi(botToken, "editMessageReplyMarkup", { chat_id: chatId, message_id: cq.message.message_id, reply_markup: buildSettingsKeyboard(session).reply_markup });
      } catch {}
      break;
    }

    case "send_prompt":
      session.awaiting_prompt = true;
      await telegramApi(botToken, "sendMessage", { chat_id: chatId, text: "Oke, kirimkan teks prompt kamu sekarang ya, duniakuu. Contoh: kucing imut putih di taman bunga" });
      break;

    case "noop":
    default:
      await telegramApi(botToken, "sendMessage", { chat_id: chatId, text: `Unknown action: ${data}` });
      break;
  }
}

// ======= HTTP HANDLER =======
async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  try {
    if (pathname === "/") {
      return new Response(JSON.stringify({ status: "online", message: "Selamat datang di API Callback FreeFire 🎉", timestamp: new Date().toISOString() }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders() } });
    }

    if (pathname === "/health") {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders() } });
    }

    if (pathname === "/set_webhook" && request.method === "POST") {
      const body = await request.json();
      const tokens = body.tokens || [];
      const baseUrl = body.base_url;
      if (!baseUrl) {
        return new Response(JSON.stringify({ error: "base_url is required" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders() } });
      }
      const results = [];
      for (const t of tokens) {
        try {
          const hookUrl = `${baseUrl}/${encodeURIComponent(t)}`;
          const setRes = await fetch(`https://api.telegram.org/bot${t}/setWebhook`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: hookUrl, allowed_updates: ["message", "callback_query"] })
          });
          const jr = await setRes.json();
          if (jr.ok) BOT_TOKENS.add(t);
          results.push({ token: t, result: jr });
        } catch (e) {
          results.push({ token: t, error: String(e) });
        }
      }
      return new Response(JSON.stringify({ results }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders() } });
    }

    if (pathname === "/generate" && request.method === "POST") {
      const auth = await validateApiKey(env, request, url);
      if (!auth.ok) return auth.res;

      const payload = await request.json();
      if (!payload.prompt || !payload.model_id) {
        return new Response(JSON.stringify({ error: "Field prompt dan model_id wajib diisi, jangan lupa ya wanitaku" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders() } });
      }
      const request_id = await generateImageArting(payload, env);
      return new Response(JSON.stringify({ request_id }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders() } });
    }

    if (pathname === "/get_result") {
      const auth = await validateApiKey(env, request, url);
      if (!auth.ok) return auth.res;

      const request_id = url.searchParams.get("request_id");
      if (!request_id) {
        return new Response(JSON.stringify({ error: "Missing request_id" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders() } });
      }
      const images = await pollImageResultArting(request_id, env);
      return new Response(JSON.stringify({ images }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders() } });
    }

    if (pathname.startsWith("/telegram/")) {
      if (request.method !== "POST") return new Response("ok", { status: 200 });
      const botToken = decodeURIComponent(pathname.split("/")[2] || "");
      if (!botToken) return new Response("missing token in path", { status: 400 });
      const update = await request.json();
      if (update.message) {
        await handleTelegramMessage(botToken, update.message, env).catch(e => console.error("handleMessageErr", e));
      } else if (update.callback_query) {
        await handleTelegramCallback(botToken, update.callback_query).catch(e => console.error("handleCallbackErr", e));
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders() } });
    }

    return new Response("Not found", { status: 404 });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders() } });
  }
}

// ======= ENTRYPOINT (CLASSIC) =======
addEventListener('fetch', event => {
  // Classic runtime: no `env` param; but Modules-style deployers may still pass env via global.
  // We keep a signature `handleRequest(request, env, ctx)` so this same file is forward-compatible.
  event.respondWith(handleRequest(event.request, /*env*/ undefined, event));
});
