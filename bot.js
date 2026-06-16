// Telegram 推送机器人：定时扫描 → 去重 → 把 ⭐聪明钱信号 推到频道。
//
// 运行方式：
//   node bot.js --test   只发一条连通性测试消息
//   node bot.js --once    扫描一次并推送(不循环)，适合测试
//   node bot.js           持续运行，每 POLL_MINUTES 分钟扫描一次

const fs = require("fs");
const path = require("path");
const { scan, fmtUSD } = require("./radar");

// ---------- 读取 .env（自己解析，跨 Node 版本稳定）----------
function loadEnv(p) {
  try {
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {}
}
loadEnv(path.join(__dirname, ".env"));

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL = process.env.TELEGRAM_CHANNEL || "@polarisresearch2000";
const POLL_MINUTES = Number(process.env.POLL_MINUTES || 3);
const SEEN_FILE = path.join(__dirname, "data", "seen.json");

if (!TOKEN) {
  console.error("❌ 缺少 TELEGRAM_BOT_TOKEN（请检查 .env）");
  process.exit(1);
}

// ---------- 去重存储 ----------
function loadSeen() {
  try {
    return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")));
  } catch {
    return new Set();
  }
}
function saveSeen(set) {
  fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
  fs.writeFileSync(SEEN_FILE, JSON.stringify([...set].slice(-5000)));
}

// ---------- Telegram ----------
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`Telegram ${method} 失败: ${j.error_code} ${j.description}`);
  return j.result;
}

const tagEn = (p) =>
  p > 50000
    ? "🐋🟢 PROFITABLE WHALE"
    : p > 5000
    ? "🟢 Winning wallet"
    : p < -5000
    ? "🔴 Losing wallet"
    : "⚪ Neutral wallet";

function fmtSignal(w) {
  const name = esc(w.name || w.pseudonym || w.proxyWallet.slice(0, 8));
  const conv = w.directional ? "🎯 Directional bet" : "🛡 Yield/hedge";
  const slug = w.eventSlug || w.slug || "";
  const url = slug ? `https://polymarket.com/event/${slug}` : "https://polymarket.com";
  const isYes = /yes/i.test(w.outcome || "");
  const sq = isYes ? "🟩" : "🟥";
  const oc = String(w.outcome || "").toUpperCase();
  const price = Number(w.price).toFixed(3);
  const pct = Math.round(Number(w.price) * 100);
  return [
    `${tagEn(w.allTimePnl)}  ·  ${conv}`,
    ``,
    `${sq} <b>${w.side} ${oc}</b>  @ ${price}  (${pct}% implied)`,
    `💰 Size: <b>${fmtUSD(w.notional)}</b>`,
    ``,
    `📊 ${esc(w.title)}`,
    ``,
    `👤 <b>${name}</b>`,
    `   All-time PnL: <b>${fmtUSD(w.allTimePnl)}</b>  ·  Portfolio: ${fmtUSD(w.value)}`,
    `   <code>${esc(w.proxyWallet)}</code>`,
    ``,
    `🔗 <a href="${url}">View market on Polymarket ↗</a>`,
    `🔭 Polaris Research · Polymarket Crypto Smart-Money Radar`,
  ].join("\n");
}

// ---------- 一轮扫描 ----------
async function pollOnce() {
  const seen = loadSeen();
  const { signals, stats } = await scan({ whaleTradesToPull: 2000 });
  const fresh = signals.filter((s) => !seen.has(s.key));
  console.log(
    `[${new Date().toISOString()}] 加密大单 ${stats.cryptoWhaleCount} ｜ 信号 ${signals.length} ｜ 新信号 ${fresh.length}`
  );
  for (const s of fresh) {
    await tg("sendMessage", {
      chat_id: CHANNEL,
      text: fmtSignal(s),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
    seen.add(s.key);
    await new Promise((r) => setTimeout(r, 1200)); // 避免触发限频
  }
  saveSeen(seen);
  return fresh.length;
}

// ---------- 入口 ----------
async function main() {
  if (process.argv.includes("--test")) {
    await tg("sendMessage", {
      chat_id: CHANNEL,
      text: "✅ <b>Polaris Radar</b> connected and standing by.",
      parse_mode: "HTML",
    });
    console.log("✅ 测试消息已发送到", CHANNEL);
    return;
  }

  console.log(`🔭 Polaris 雷达启动 ｜ 频道 ${CHANNEL} ｜ 每 ${POLL_MINUTES} 分钟扫描一次`);
  const n = await pollOnce();
  console.log(`首轮推送 ${n} 条`);

  if (process.argv.includes("--once")) return;
  setInterval(() => {
    pollOnce().catch((e) => console.error("轮询出错:", e.message));
  }, POLL_MINUTES * 60 * 1000);
}

main().catch((e) => {
  console.error("启动失败:", e.message);
  process.exit(1);
});
