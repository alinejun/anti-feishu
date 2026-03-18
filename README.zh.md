# Anti-Feishu

> 通过飞书 Bot 远程操控 Antigravity Agent 的独立 Node.js 服务

## 功能

| 指令 | 说明 |
|------|------|
| `/send <msg>` | 发送消息给 Agent |
| `/latest` | 获取 Agent 最新回复 |
| `/stop` | 停止当前生成 |
| `/screenshot` | 获取 IDE 界面截图 |
| `/status` | 查看连接状态 |
| `/auto on/off` | 开关 Auto Accept |
| `/auto status` | 查看 Auto Accept 统计 |
| `/help` | 显示帮助 |
| 直接输入文本 | 自动发送给 Agent |

收到 Agent 回复时自动推送到飞书。

## 架构

```
飞书 App → WebSocket 长连接 → anti-feishu 服务 → CDP → Antigravity IDE
```

- **飞书通信**：`@larksuiteoapi/node-sdk` WSClient（无需公网 IP）
- **IDE 控制**：`puppeteer-core` 通过 CDP 协议连接 Chromium

---

## 快速启动

### 前置条件

- Node.js >= 18
- Antigravity IDE 已安装
- 飞书开放平台自建应用（已配置机器人能力）

### Step 1: 飞书开放平台配置

1. 登录 [飞书开放平台](https://open.feishu.cn/)，点击 **创建自建应用**
2. 进入应用 → **应用能力** → 添加 **机器人** 能力
3. 进入 **凭证与基础信息**，记录 `App ID` 和 `App Secret`
4. 进入 **权限管理**，开通以下权限：
   - `im:message` — 发送消息
   - `im:message.receive` — 接收消息
   - `im:resource` — 上传图片（截图功能）
5. 进入 **事件订阅**：
   - 添加事件：`im.message.receive_v1`
   - 订阅方式选择：**使用长连接接收事件**
6. 创建版本并 **发布应用**
7. 在飞书中找到你的机器人，给它发一条消息确认可以收到

### Step 2: 以 CDP 模式启动 Antigravity

Antigravity 需要开启远程调试端口，Anti-Feishu 才能通过 CDP 与之通信。

```bash
# 方式一：使用项目提供的脚本
bash scripts/start-antigravity.sh

# 方式二：手动启动
/Applications/Antigravity.app/Contents/MacOS/Antigravity --remote-debugging-port=9222
```

启动后验证 CDP 是否生效：

```bash
curl http://localhost:9222/json/version
```

应返回类似以下 JSON：

```json
{
  "Browser": "Chrome/xxx",
  "webSocketDebuggerUrl": "ws://localhost:9222/devtools/browser/xxx"
}
```

> **提示**：如果你想每次都自动带上 CDP 参数，可以创建一个 Alias：
> ```bash
> alias antigravity='/Applications/Antigravity.app/Contents/MacOS/Antigravity --remote-debugging-port=9222'
> ```

### Step 3: 配置环境变量

```bash
# 复制模板
cp .env.example .env

# 编辑 .env，填入你的飞书凭证
```

`.env` 文件内容：

```bash
# 必填：飞书应用凭证
FEISHU_APP_ID=cli_xxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxx

# 可选：CDP 端口（默认 9222）
CDP_PORT=9222

# 可选：限制允许操作的飞书用户 ID（逗号分隔，留空=不限制）
FEISHU_ALLOWED_USER_IDS=

# 可选：Agent 回复自动推送
MONITOR_ENABLED=true
MONITOR_INTERVAL_MS=3000

# 可选：Auto Accept（默认关闭，可通过飞书 /auto on 开启）
AUTO_ACCEPT_ENABLED=false
AUTO_ACCEPT_BLOCKED_COMMANDS=rm -rf,sudo,mkfs,format,drop table,drop database,shutdown,reboot,dd if=,chmod -R 777,git push --force,git reset --hard

# 日志级别
LOG_LEVEL=info
```

### Step 4: 安装依赖并启动

```bash
# 安装依赖
npm install

# 开发模式启动（支持热重载）
npm run dev
```

看到以下输出表示启动成功：

```
🚀 Anti-Feishu starting...
CDP connected. Page title: "Antigravity"
Feishu Bot connected via WebSocket
✅ Anti-Feishu is running!
   CDP: localhost:9222
   Monitor: ON
   Auto Accept: OFF
```

### Step 5: 在飞书中测试

打开飞书，找到你的机器人，发送以下消息测试：

```
/help
```

应收到指令列表回复。然后尝试：

```
/status
```

确认 IDE 连接状态。接着：

```
/send 你好，请帮我创建一个 hello world 项目
```

或直接输入（不带 `/`）：

```
请帮我创建一个 hello world 项目
```

---

## 探测 DOM 选择器

> **重要**：首次使用前，需要验证 DOM 选择器是否与你的 Antigravity 版本匹配。

1. 以 CDP 模式启动 Antigravity
2. 在浏览器打开 `http://localhost:9222`，找到 IDE 窗口的 **inspect** 链接
3. 在 Chrome DevTools 中，打开 Agent Chat 面板
4. 检查以下元素的实际选择器：
   - 聊天输入框（textarea）
   - 发送按钮
   - 停止按钮
   - 消息内容容器
5. 将发现的选择器更新到 `src/cdp/selectors.ts`

```typescript
// src/cdp/selectors.ts — 根据实际 DOM 修改这些选择器
export const CHAT_INPUT_SELECTORS = [
  'textarea[data-testid="chat-input"]',
  // 添加你发现的实际选择器...
];
```

---

## 常见问题

### CDP 连接失败

```
CDP connection failed, retry 1/10, retrying in 5s...
```

**检查**：
1. Antigravity 是否已启动？
2. 是否带了 `--remote-debugging-port=9222` 参数？
3. 端口是否被占用？`lsof -i :9222`

### 飞书 Bot 收不到消息

**检查**：
1. 飞书应用是否已发布？
2. 事件订阅是否选择了"长连接"模式？
3. `im.message.receive_v1` 事件是否已订阅？
4. 应用是否有 `im:message.receive` 权限？

### 消息发送到 Agent 失败

```
❌ Failed to send. Is Agent Chat panel open?
```

**检查**：
1. Antigravity 中是否已打开 Agent Chat 面板？
2. DOM 选择器是否需要更新？参见"探测 DOM 选择器"章节
3. 运行 `/screenshot` 查看当前 IDE 界面

---

## 开发

```bash
# 类型检查
npm run typecheck

# 构建
npm run build

# 生产模式运行
npm run start
```

## 技术文档

- [技术设计方案](docs/plans/2026-03-18-anti-feishu-design.zh.md)
- [Anti-Tools 分析](docs/anti-tools-analysis.zh.md)
- [Antigravity 插件开发指南](docs/antigravity-plugin-development-guide.zh.md)

## License

MIT
