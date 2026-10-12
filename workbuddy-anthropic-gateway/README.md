# workbuddy-anthropic-gateway

> ## ⚠️ 免责声明（请先读）
>
> - **本项目仅供个人学习、技术研究与互操作性探索**，不是腾讯或 Anthropic 的官方产品，与两家公司均无关联。
> - **不鼓励、不支持任何违反服务条款的行为**，包括但不限于：多账号刷额度、共享/出借账号、绕过付费墙、批量注册、商业用途。
> - **本网关只使用一个你本人已登录的 WorkBuddy 账号**：没有账号池、没有请求间轮换、没有自动切换、没有额度监控/刷取功能。
> - **使用风险自担**，包括账号被限制或封禁、服务随时失效。
> - **请优先使用官方 API 和官方集成。** 上游接口为逆向适配，无公开文档，不保证稳定性。
> - 本项目**不提供**任何账号购买、代充、分享链接或群组。

---

把本机已登录的**一个** **WorkBuddy** 账号，变成一条 **Anthropic Messages API**（`/v1/messages`）的本地端点，供 **Claude Code** 经 **cc-switch** 接入。

只做这一件事：**转录协议**。没有 WebUI、没有签到、没有账号管理界面 —— 账号直接用你现有的 WorkBuddy 登录态。

- 零 npm 依赖，Node 原生跑 TypeScript（需 Node ≥ 22.18；更旧的 22.x 要加 --experimental-strip-types 标志）
- 只监听 `127.0.0.1`
- 上游：`https://copilot.tencent.com/v2/chat/completions`（WorkBuddy 客户端同款接口，**逆向适配，见下**）

## 逆向适配声明

上游接口**没有公开文档、不属于任何公开 API**。网关对它的调用方式、请求头与请求体净化逻辑（如规避上游渠道校验 11128）均来自对客户端的观察，**可能随时变更或下线，本项目不对可用性与稳定性做任何保证**。代码中相关位置均有 `⚠️ 逆向适配` 注释标明。

---

## 快速开始

**双击 `start.bat`** —— 会启动服务并自动打开一个中文网页。页面上写着：

- 现在通没通（一条从 WorkBuddy 到 Claude Code 的连接线）
- 账号读到了没有、哪些文件读不了及原因
- **要填进 cc-switch 的六项配置，每项都有复制按钮**，密钥默认打码
- 一个「测一下」按钮，按下去真的发一条消息，成功就说明整条链路通了

命令行等价做法是 `node src/server.ts`，然后浏览器打开 <http://127.0.0.1:8789>。
启动后终端也会打印选用的账号、密钥和模型映射，例如：

```
地址    http://127.0.0.1:8789
密钥    sk-wb-…
模型    默认 glm-5.3-flash（映射 4 条，无回退链）
账号    <你的账号昵称> (<uid前8位>) ← …\.wb-switch\accounts.json
```

`GET http://127.0.0.1:8789/healthz` 免鉴权，返回当前账号、被跳过的文件与模型配置 —— 排障先看它。

---

## 接入 Claude Code（在 cc-switch 里加一个 provider）

cc-switch 写的就是 `~/.claude/settings.json` 的 `env` 块，填这几项：

| 键 | 值 |
|---|---|
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:8789`（**不带 `/v1`**，cc-switch 会自己拼接并折叠重复的 `/v1`） |
| `ANTHROPIC_AUTH_TOKEN` | `data/api-key.txt` 里的密钥（走 `Authorization: Bearer`） |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | `glm-5.3-flash` |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | `glm-5.3-flash` |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `deepseek-v4.1-flash` |
| `ANTHROPIC_MODEL` | `glm-5.3-flash` |

网关**同时接受** `Authorization: Bearer` 和 `x-api-key`，所以你想用 `ANTHROPIC_API_KEY` 也行。

> 三个 `ANTHROPIC_DEFAULT_*_MODEL` 必须填，否则 Claude Code 会发 `claude-sonnet-4-5` 这类真实
> Anthropic 模型名过来。网关有兜底映射（见下），但显式填更可控。

---

## 配置（`config.json` + `config.local.json`）

`config.json` 可入库、保持通用默认值；**本机相关配置放 `config.local.json`（已 gitignore）**，覆盖 `config.json` 同名字段。密钥不在这两个文件里 —— 首次运行自动生成于 `data/api-key.txt`。

```json
{
  "port": 8789,
  "models": {
    "default": "glm-5.3-flash",
    "map": {
      "claude-opus":   "glm-5.3-flash",
      "claude-sonnet": "glm-5.3-flash",
      "claude-haiku":  "deepseek-v4.1-flash"
    }
  },
  "minMaxTokens": 8192
}
```

**模型迭代时改这里就行，不用碰代码。**

- `models.map` —— 键做**最长前缀匹配**，所以 `claude-sonnet` 能接住 `claude-sonnet-4-5`。请求的模型名不在 map 里就原样透传。
- `models.default` —— 兜底，也是 `claude-*` 请求的落点。
- **没有回退链**：每个请求只用映射出的那一个模型；上游报错就原样返回，不会自动换模型重试（合规要求，也避免掩盖真实故障）。
- `minMaxTokens` —— **上游模型会把预算花在内部推理上**（`delta.reasoning_content` 字段）。实测把 `max_tokens` 设成 100 时，推理直接吃光预算、返回**空正文**（`stop_reason: max_tokens`）。所以客户端给的额度低于此值时会自动抬高。设为 `0` 关闭。
- `keepAliveMs` —— 上游推理期间可能几十秒不出字，网关按此间隔发 Anthropic `ping` 事件保活。
- `accounts.select` —— 手动指定用哪个账号（uid / uin / 备注名，大小写不敏感）。**这是唯一允许的"换账号"入口**，改后重载生效，运行中不轮换。

另外可调：`upstream.timeoutMs`（默认 300000）、`accounts.dirs` / `accounts.extraFiles` / `accounts.wbSwitchFiles`。

---

## 账号从哪来（单账号）

网关按以下顺序收集候选，然后按规则选出**唯一一个**：

| 来源 | 路径 | 令牌形态 | 有 refreshToken |
|---|---|---|---|
| 桌面端登录态 | `%APPDATA%` / `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\*.info` | 5.6.0+ 多为 `$wbEncrypted` 加密包装，**会被跳过** | 有（加密的，读不出） |
| xdpool 扫码 | 同上目录，`workbuddy-scan-<id>.info` | 明文 | 无 |
| **workbuddy-switch** | `~/.wb-switch/accounts.json` | **明文** | **有** |
| 显式指定 | `accounts.extraFiles` | 明文 | 视文件而定 |

**选用规则（启动时一次定型，之后不变）：**

1. `accounts.select` 命中 uid / uin / 备注名 → 固定用它；
2. 没配 select 但扫到多个账号 → 选第一个带 refreshToken 的（能自动续期）；
3. 再否则 → 选第一个。

启动日志会打印选用了哪个；扫到多个时会提示"如何在 config.json 里固定用别的账号"。**换账号 = 改 `accounts.select` 后重启（或等配置热重载）**，运行中不会自动轮换。

即你已有的 WorkBuddy 登录态 —— **不需要重新登录**。

**只认明文令牌。** `accessToken` 必须是裸字符串；桌面端 5.6.0+ 会把令牌包成 `$wbEncrypted` 对象，这类文件会被跳过并在启动日志里列出原因（不做任何猜测性解包 —— 猜错会拿到密文当令牌用）。

### workbuddy-switch：不产生 `workbuddy-pool-*.info`，改读账号库

早期文档说"让 switch 同步一次 → 写出 `workbuddy-pool-*.info`"，**实测不成立**（2026-10-12）：
workbuddy-switch 装好后并不会往 CodeBuddyExtension 的 auth 目录写任何文件，
它把账号存在自己的 `~/.wb-switch/accounts.json` 里，`access_token` / `refresh_token` 都是明文字符串。

因此网关**直接读这个账号库**（`accounts.wbSwitchFiles`，默认 `~/.wb-switch/accounts.json`），
按上面的选用规则取一个。**这条来源比 xdpool 更好用**：带 refresh_token，令牌过期时网关能自己续期，不用重新扫码。
`~` 在 Windows 下展开为 `%USERPROFILE%`，在 Linux / WSL 下展开为 `$HOME`。

> WSL 里跑网关时，把 `wbSwitchFiles` 改写成 `/mnt/c/Users/<你>/.wb-switch/accounts.json`，
> 见 `references/config-wsl.json`。

> `workbuddy-pool-*.info` 里**没有 refreshToken**，所以网关无法为它续期。
> 令牌失效时（401）会提示你重新登录；`/healthz` 会重新扫描，桌面端/switch 刷新后会自动跟上。

---

## 已验证行为

| 场景 | 结果 |
|---|---|
| 非流式 `/v1/messages` | ✅ 聚合成标准 message 对象 |
| 流式 `/v1/messages` | ✅ `message_start → content_block_start/delta/stop → message_delta → message_stop` |
| **工具调用** | ✅ `tool_use` 块 + `input_json_delta` 增量 + `stop_reason: "tool_use"` |
| 多模态图片 | ✅ `{type:"image",source:{...}}` → OpenAI `image_url` |
| 鉴权 | ✅ 缺密钥/错密钥均 401 |
| `/v1/messages/count_tokens` | ✅ 粗略估算（CJK 按 ~0.75 字/token，其余 ~4 字符/token） |
| `/v1/models` | ✅ 返回配置里的模型 |

工具的转换细节：Anthropic 的 `tools[].input_schema` 直接当 OpenAI 的 `function.parameters`；
`tool_choice` 的 `auto/any/{tool}` 映射为 `auto/required/{function}`，`none` 则整个丢掉 `tools`；
`tool_result` 拆成独立的 `role:"tool"` 消息并排在同条 user 文本之前，`is_error` 加 `Error:` 前缀
（OpenAI 没有对应字段，不加前缀模型会当成功结果用）。

---

## 已知特性与坑

- **延迟波动大。** 同一条请求实测 8 秒到 3 分钟以上都有，取决于模型当次愿意推理多久。
  我验证过 `reasoning_effort: "low"`，**没有帮助**（11.3s 对 8.0s，推理 token 反而 158 → 1023），
  所以没有把它做成开关。嫌慢就换 `models.default`（`hy3` 按上游说明实测免费且更快）。
- **推理内容被丢弃。** 上游的 `delta.reasoning_content` 不转成 Anthropic 的 `thinking` 块 ——
  真实的 thinking 块需要 `signature` 字段，伪造它会冒让 Claude Code 解析失败的风险。所以只取 `content`。
- **图片**：网关自身不做本地路径 → base64 转换，只做协议转换。Claude Code 发的是 base64 块，能直接用。
- **端口**：默认 8789，避开了 cc-switch 自己的代理（15721）和 codex 网关（53682）。
- **凭据不回写**：401 后刷新出的新令牌只存在内存里，不覆盖桌面 App 的文件；重启后靠重扫目录。

---

## 排障

先看 `http://127.0.0.1:8789/healthz`，它会列出当前账号（或为什么没有）、每个凭据文件是被跳过还是未被选中、以及原因。

| 现象 | 原因 |
|---|---|
| 启动日志显示没有账号 | 所有 `.info` 都是 `$wbEncrypted`。在 workbuddy-switch 里登录，或用 xdpool 扫码加号（见 `账号从哪来`） |
| 返回 401 | 网关密钥不对（见 `data/api-key.txt`） |
| 返回 503 | 没有可用账号，看启动日志的跳过原因 |
| 空正文 + `stop_reason: max_tokens` | 推理吃光了预算。检查 `minMaxTokens` 是否被调成 0 或过低 |
| 返回 429 | 上游 402（额度耗尽）被映射过来的，或真的限流 |
| 卡住不动 | 模型在推理。网关每隔 `keepAliveMs` 发 `ping` 保活，等着就行 |

---

## 目录

```
src/config.ts     配置加载（config.json + config.local.json 合并）、密钥生成、%VAR% 展开
src/accounts.ts   单账号加载：*.info / wb-switch 账号库解析、选用规则、令牌刷新
src/anthropic.ts  Anthropic 请求 → OpenAI 请求
src/translate.ts  OpenAI SSE → Anthropic 事件（流式状态机 + 非流式聚合）
src/upstream.ts   转发到 copilot.tencent.com
src/server.ts     HTTP 服务、鉴权、路由
src/page.ts       那个中文网页（单文件内嵌 HTML/CSS/JS，不依赖外网）
```

页面本身只用到两个接口：`GET /healthz` 取状态（免鉴权），`POST /api/test` 跑测试（免鉴权，
因为只监听回环地址 —— 能访问它就能读到 `data/api-key.txt`，没有额外的权限边界）。

---

## 伦理使用条款

仅供个人学习、技术研究与互操作性探索。请勿用于多账号刷额度、共享账号、绕过付费墙、商业用途；
请遵守腾讯服务条款，风险自担；官方方案可用时优先使用官方方案。本项目不提供账号购买、代充、分享链接或群组。

## License

MIT
