# CLAUDE.md — Polaris Whale Radar 驾驭文档

> 这份是项目操作手册。任何 AI 对话或维护者读完这页即可接手、运行、续做本项目。
> 当前版本 **V4.2**。详细迭代见 [CHANGELOG.md](CHANGELOG.md)。

## 1. 这是什么

Polymarket「聪明钱」雷达 → 自动推送到 Telegram 频道。**只读公开 API，从不下单。零依赖**（仅用 Node 自带 `fetch`，Node ≥20）。
用户：香港、非程序员、靠 AI 开发，目标是**侧收入**。

定位是**「卖铲子」的内容产品**（养受众 → 变现），**不是交易策略**。回测已证明：用散户可得的免费数据，Polymarket 上**没有可交易的 edge**（赛前价值法 = 市场有效；直播滞后法 = ESPN 比 Polymarket 还慢）。所以方向是产品/受众，不是自己下注。

两个频道：
- **加密** `@polarisresearch2000`（bot token = `TELEGRAM_BOT_TOKEN`）
- **世界杯** `@polarisresearch2000_PE`（bot token = `SPORTS_BOT_TOKEN`，PROFILE=SPORTS）

## 2. 硬性边界（务必遵守）

- **只读**：绝不下真实订单。
- **`.bat` 文件内容必须纯 ASCII**：cmd 用 GBK 读 UTF-8，中文(连 `rem`/`echo` 里的)会乱码并**破坏后面的 `set` 行**。中文只放进 Node 程序输出，不放 .bat。改完用字节检查（>127 的字节数应为 0）。
- **同一频道不要云端 + 本地同时跑**：各自独立去重 → 会重复推送。
- **`D:\PM-NO2`（Polaris 量化项目）对本项目只读**：永不修改它。
- 所有新代码都在 `D:\STM` 下。

## 3. 文件结构

| 文件 | 作用 |
|---|---|
| `radar.js` | 核心：拉数据 + 扫描/持仓/观察名单/赛果预判逻辑（加密与体育共用） |
| `bot.js` | Telegram bot：消息格式化、轮询循环、定时摘要、赛果追踪、CLI |
| `index.js` | 命令行报告（给自己看，中文） |
| `启动世界杯雷达.bat` | 世界杯本地启动（PROFILE=SPORTS + 门槛 + 关信号/风格榜） |
| `启动本地雷达.bat` | 加密本地启动 |
| `.github/workflows/worldcup.yml` | 世界杯云端 24h（cron */5，**需仓库密钥 `SPORTS_BOT_TOKEN`**） |
| `.github/workflows/radar.yml` | 加密云端（schedule 已注释=暂停；保留手动触发） |
| `.env` | 机密 token（**gitignored，不上传**） |
| `data/` | 状态文件（见 §7），云端工作流会 commit 回写 |
| `backtest-whales.js` | 历史回测工具（`node backtest-whales.js fifa-world-cup`） |
| `CHANGELOG.md` | 版本日志 |

GitHub 仓库：`https://github.com/polarisresearch2000-create/Polaris-Whale-Radar`（公开）。

## 4. 怎么运行

**本地**：双击桌面快捷方式，或：
```
node bot.js            # 持续轮询(每 POLL_MINUTES 分；设了 POLL_SECONDS 则按秒)
node bot.js --once     # 扫描一次(测试用)
node bot.js --test     # 发一条连通性测试到频道
node bot.js --results  # 打印赛果追踪/策略 ROI
node index.js          # 命令行信号报告
```
> bot 走哪个频道由环境变量 `PROFILE` 决定：`PROFILE=SPORTS` → 世界杯；空 → 加密(默认)。启动脚本里已设好。

**云端 24h**：GitHub Actions。世界杯 = `worldcup.yml`（每 5 分钟跑 `node bot.js --once`）。
启用步骤：GitHub 仓库 → Settings → Secrets and variables → Actions → New secret，名 `SPORTS_BOT_TOKEN`、值见 `.env`；然后 Actions 页 Run workflow。**启用云端后关掉本地世界杯窗口**（避免重复）。

## 5. 频道里会推什么

| 内容 | 触发 | 加密 | 世界杯 |
|---|---|---|---|
| 📊 巨鲸持仓分析（多空分布 + 💎最赚大户/⚠️输家反指） | 每 `POSITIONING_MIN` 分钟 | ✅ | ✅(15分) |
| ☀️ 今日巨鲸预判（含🎯准确比分概率榜Top3） | 每天 HKT `PREVIEW_HOUR` 点 | ✅ | ✅(比分榜仅世界杯) |
| 🏁 赛果总结 + 策略 ROI | 完赛/市场结算后 | ✅(UMA结算) | ✅(ESPN) |
| 📌 置顶策略战绩(自动更新) | 有新结算时 + 每≥30分钟刷新 | ✅ | ✅ |
| 🐋/👑 逐条实时信号 | 每轮 | ✅ | ❌(已关，整合进持仓分析) |
| 🏆 全站顶级赢家风格榜 | 每天 | ✅ | ❌(跑题，已关) |

## 6. 关键环境变量

| 变量 | 默认 | 含义 |
|---|---|---|
| `PROFILE` | (空) | `SPORTS`=用 `SPORTS_BOT_TOKEN`/`SPORTS_CHANNEL`；空=用 `TELEGRAM_*` |
| `POLY_TAG` | crypto | Polymarket 标签：`crypto` / `fifa-world-cup`（radar 在 require 时读，**须由启动脚本 `set` 成真环境变量**） |
| `VERTICAL_LABEL` | Crypto | 消息落款里的赛道名 |
| `POLL_SECONDS` | (空) | 设了就按秒轮询(本地快速)；同时把 whale 拉取量降到 500 省流量 |
| `MIN_NOTIONAL` | 1000 | 大额信号门槛(USDC)。世界杯=5000 |
| `SIGNAL_MIN_PNL` | 5000 | 算「聪明钱」的全期盈亏门槛。世界杯=20000 |
| `WATCHLIST_MIN_PNL` / `WATCHLIST_MIN_NOTIONAL` | 30000 / 100 | 观察名单收录/动作门槛。世界杯=50000 / 500 |
| `POSITIONING_MIN_NOTIONAL` | 500 | 持仓快照独立(低)门槛 |
| `POSITIONING_MIN` | 120 | 持仓快照间隔(分)。世界杯=15 |
| `PREVIEW_HOUR` | 9 | 每日预判推送时刻(HKT) |
| `SIGNALS_ENABLED` | on | 逐条信号开关；世界杯=off |
| `PROFILES_ENABLED` | on | 全站赢家风格榜；世界杯=off |
| `DIGESTS` | on | 持仓/风格摘要总开关 |

机密(在 `.env`)：`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHANNEL`(加密)、`SPORTS_BOT_TOKEN`/`SPORTS_CHANNEL`(世界杯)。

## 7. 数据 / 状态文件（`data/`）

- `seen_<tag>.json` — 逐条信号去重
- `watchlist_<tag>.json` — 加密活跃常胜钱包缓存(6h)
- `digest_<tag>.json` — 持仓/风格摘要上次推送时间戳
- `results_<tag>.json` — 赛果追踪：`predictions`(赛前锁定的预判, 含 `eventSlug`+`scoreBoard`准确比分概率榜) / `settled`(含 `scoreBoard`+`scoreRank`) / `strategies`(各策略 bets/wins/profit) / `scoreStats`(比分 Top3/榜首命中数) / `pinnedMsgId` / `trackUpdatedAt`

**重置追踪记录**：删对应 `results_<tag>.json`（干净起跑；现无已结算数据时无损失）。

## 8. 数据源

- `gamma-api.polymarket.com` — 市场/事件（`tag_slug=`、`markets/{id}` 读结算 outcomePrices）
- `data-api.polymarket.com` — `/trades`（`filterType=CASH&filterAmount=` 服务端按金额过滤；`market=` 按市场拉）、`/positions`、`/value`、`/activity`
- `clob.polymarket.com/book` — 实时买卖盘
- `user-pnl-api.polymarket.com/user-pnl` — 钱包全期盈亏(最后一点=总盈亏)；`lb-api.polymarket.com/profit` — 盈利榜
- `site.api.espn.com/.../soccer/fifa.world/scoreboard` — 免费：比分、状态、开赛时间(`date`)、DraftKings 赔率

## 9. 多策略 ROI 追踪 & 回测（诚实纪律）

赛前(state=pre)锁定每场预判(无前视偏差)，完赛/结算后按**下注价算 ROI**(非胜率)，并行测 4 策略：跟巨鲸多数方 / 跟最大单大户 / 高共识>85%才跟 / 反向 fade。`node bot.js --results` 查看。
**当前样本太小，不足以证明任何 edge** —— 让 forward 跑、攒到几十场再说。**绝不拿小样本的漂亮数字对外宣传。**

## 10. 版本约定（每次迭代必做）

升级 = 改代码 + 在**三处**同步版本号：`bot.js` 的 `const VERSION` + 两个 `.bat` 横幅 + `CHANGELOG.md` 加一条。

## 11. 战略现状 & 下一步

- 功能已**基本完整，建议冻结**（避免复杂度蔓延）。
- 真正瓶颈是**非功能**两件：① 加 `SPORTS_BOT_TOKEN` 密钥 → 世界杯 24h 云端(数据不漏)；② 发 Threads 引流（二维码在 `D:\STM\promo\worldcup-channel-qr.png`，文案见对话/记忆）。
- 变现路径：免费频道养受众 → 返佣/affiliate（零门槛）→ 免费/VIP 订阅，收 USDC。定位「数据分析」非「投注建议」(香港合规)。
- token 正式公开推广前建议 `@BotFather` `/revoke` 重置(曾在聊天出现过)。
