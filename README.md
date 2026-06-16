# Polaris Whale Radar 🔭

监控 Polymarket **加密市场**的大额交易，识别历史盈利钱包（聪明钱）的「方向性下注」，
自动推送到 Telegram 频道 [@polarisresearch2000](https://t.me/polarisresearch2000)。

零依赖，只用 Node.js 自带能力 + Polymarket 公开 API + Telegram Bot API。

## 文件结构

| 文件 | 作用 |
|---|---|
| `radar.js` | 核心：拉数据、算钱包战绩、挑信号 |
| `index.js` | 命令行报告（`node index.js`，给自己看） |
| `bot.js` | Telegram 推送机器人 |
| `.github/workflows/radar.yml` | 免费云托管：每 15 分钟自动扫描推送 |
| `.env` | 机密（bot token），**不要分享、不会上传** |

## 本地运行

```bash
node index.js          # 在终端看当前信号
node bot.js --test     # 发一条连通性测试消息
node bot.js --once     # 扫描一次并推送
node bot.js            # 持续运行（每 3 分钟）
```

## 免费云托管（GitHub Actions）—— 让它 24 小时运行

> 思路：GitHub 每 15 分钟帮你免费跑一次扫描脚本，不需要你的电脑开着，也不用花钱。

**第一步：把代码放上 GitHub**
1. 注册 [github.com](https://github.com) 账号（如果没有）。
2. 下载安装 [GitHub Desktop](https://desktop.github.com)（图形界面，最适合非程序员）。
3. 打开 GitHub Desktop → `File` → `Add local repository` → 选择 `D:\STM\whale-radar` 文件夹。
4. 点 `Publish repository`。**重要：勾选 "Keep this code private"（保持私有）取消**，即设为 **Public 公开**
   —— 公开仓库的 Actions 免费额度无限（代码里没有任何机密，token 是单独加的，见下）。

**第二步：把 bot token 作为机密加进去**
1. 在 github.com 打开你刚发布的仓库 → `Settings` → `Secrets and variables` → `Actions`。
2. 点 `New repository secret`。
3. Name 填：`TELEGRAM_BOT_TOKEN`
4. Secret 填你的 bot token（就是 `.env` 里那串）。
5. 保存。

**第三步：开启并测试**
1. 打开仓库的 `Actions` 标签页，如提示则点击启用 workflows。
2. 选左边的 `Polaris Whale Radar` → 点 `Run workflow` 手动跑一次试试。
3. 看频道有没有收到新信号。之后它会每 15 分钟自动跑。

完成后，**你的电脑关机也没关系**，频道会持续更新。

## 安全提醒
- 正式公开推广前，建议在 Telegram `@BotFather` 发 `/revoke` 重新生成 token
  （旧 token 出现过在聊天里），然后更新 `.env` 和 GitHub 的 Secret。
- `.env` 已被 `.gitignore` 忽略，不会上传到 GitHub。
