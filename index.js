// 命令行报告：在终端打印当前的加密聪明钱信号 + 大额成交榜单。
// 运行： node index.js
const { scan, fmtUSD } = require("./radar");

function renderTrade(w) {
  const conv = w.directional ? "🎯方向性" : "🛡吃息";
  const name = w.name || w.pseudonym || "(匿名)";
  console.log(
    `\n${w.tag} | ${conv}  ${fmtUSD(w.notional)}  ${w.side}「${w.outcome}」@${Number(w.price).toFixed(3)}  (${w.ageMin}分钟前)`
  );
  console.log(`   市场: ${w.title}`);
  console.log(
    `   钱包: ${name}  ${w.proxyWallet.slice(0, 10)}...  | 全期盈亏 ${fmtUSD(w.allTimePnl)} | 市值 ${fmtUSD(w.value)}`
  );
}

(async () => {
  console.log("🔭 Polaris 雷达 — 正在扫描 Polymarket 加密市场...\n");
  const { signals, top, stats } = await scan();
  console.log(
    `加密市场名单 ${stats.marketCount} 个 | 大额成交 ${stats.tradeCount} 笔 | 其中加密大单 ${stats.cryptoWhaleCount} 笔`
  );

  console.log("\n" + "=".repeat(64));
  console.log("⭐ 重点信号：历史盈利 > $5,000 的钱包，正在做『方向性』下注");
  console.log("=".repeat(64));
  if (signals.length === 0) console.log("\n本轮暂无符合条件的高质量信号。");
  else signals.forEach(renderTrade);

  console.log("\n\n" + "=".repeat(64));
  console.log(`🐋 加密市场大额成交 TOP ${top.length}（按金额）`);
  console.log("=".repeat(64));
  top.forEach(renderTrade);

  console.log("\n" + "=".repeat(64));
  console.log("标签=钱包全期盈亏(🟢>$5k, 🐋🟢>$50k, 🔴<-$5k)。🎯=价格0.15~0.85真方向; 🛡=接近1吃息/套保。");
})().catch((e) => {
  console.error("出错了：", e.message);
  process.exit(1);
});
