# 终端 Claude Code 的 env 配置（含 WSL / cc-switch v4）

> Claude 桌面端**不需要**填这些——它走模型发现自动出全部模型。这些只在终端 CLI（Claude Code）用。

---

## 一图看懂：cc-switch 到底做了什么

cc-switch 不参与任何网络转发，它**只做一件事**：把选中供应商的 `env` 块写进
`~/.claude/settings.json`（Windows 版写的是 `settings.json` 里 `claudeConfigDir` 指定的目录）。
Claude Code 启动时读这个文件。

所以只要 `~/.claude/settings.json` 里的 env 对了，Claude Code 就能走网关——
cc-switch 里配好只是让"切供应商"这个动作自动化。

---

## 方式 A（推荐）：在 cc-switch 里新增一个供应商

### 前提：网关已经在 WSL 里跑起来

```bash
cd ~/wb-gateway && node src/server.ts      # 另开一个终端，或按下方 systemd 常驻
cat ~/wb-gateway/data/api-key.txt          # 记下这串 sk-wb-…，下面要填
```

网关**没跑起来**的话，cc-switch 里填了也会连不上——没有"稍后自愈"这回事。

### 操作

打开 cc-switch（WSL 里执行 `cc-switch`，WSLg 会拉起窗口）：

1. 切到 **Claude** 分类
2. **新增供应商 / Add Provider**（不要改现有的 `AICODE-MIRROR`，那个是另一个镜像站）
3. 按下表填：

| 字段 | 填什么 |
|---|---|
| 名称 | `WorkBuddy 网关`（随意，只是显示名） |
| 供应商分类 | 自定义 / Custom（各版本叫法可能是"第三方""custom"） |
| API 地址 / Base URL | `http://127.0.0.1:8789` |
| API Key / 令牌 | `~/wb-gateway/data/api-key.txt` 的内容（`sk-wb-` 开头） |
| 模型（若界面有独立输入框） | opus/sonnet → `glm-5.3-flash`；haiku → `deepseek-v4.1-flash` |
| 超时 | `3000000`（上游推理慢，8 秒~3 分钟波动） |

4. 保存 → 在列表里**切换到** `WorkBuddy 网关`
5. 验证 cc-switch 已写盘：`cat ~/.claude/settings.json` 应出现 `127.0.0.1:8789`

> 各版本 GUI 文案不一。若界面提供"编辑 JSON / 高级配置"，直接把下节那段 JSON 粘进去，
> 比逐个填输入框更可靠。

### 可直接粘贴的完整 env（cc-switch 的 `settings_config` 就是这一整块）

cc-switch v4 把供应商存在 `~/.cc-switch/cc-switch.db`（SQLite）的 `providers` 表里，
`settings_config` 字段就是下面这个 JSON 字符串：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8789",
    "ANTHROPIC_AUTH_TOKEN": "<~/wb-gateway/data/api-key.txt 的内容>",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.3-flash",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME": "glm-5.3-flash",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.3-flash",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": "glm-5.3-flash",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4.1-flash",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME": "deepseek-v4.1-flash",
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "hy3",
    "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME": "hy3",
    "CLAUDE_CODE_SUBAGENT_MODEL": "deepseek-v4.1-flash",
    "API_TIMEOUT_MS": "3000000"
  }
}
```

**这几个模型选值的依据**（积分倍率来自网关 `/v1/models`，越低越省）：

| 变量 | 值 | 倍率 | 理由 |
|---|---|---|---|
| `OPUS` | `glm-5.3-flash` | x0.06 | 便宜且是主力 |
| `SONNET` | `glm-5.3-flash` | x0.06 | 日常主力，最省 |
| `HAIKU` | `deepseek-v4.1-flash` | x0.11 | 快，适合小任务/子代理 |
| `FABLE` | `hy3` | x0.00 | 限时免费且更快 |

想换别的：网关 `/v1/models` 里 28 个模型任选，例如 `kimi-k3-1`(x1.62)、`glm-5.3`(x0.79)、`minimax-m3`(x0.25)。

### 不填模型变量也能跑（已验证）

即使一个 `ANTHROPIC_DEFAULT_*_MODEL` 都不填，Claude Code 发来的原生 Anthropic 模型名也会被
网关 `config.json` 的 `models.map` 按**最长前缀**兜底翻译。2026-10-12 实测：

| Claude Code 发出 | 上游实际使用 | HTTP |
|---|---|---|
| `claude-sonnet-5-5` | `deepseek-v4.1-flash` | 200 |
| `claude-opus-5-5` | `glm-5.3-flash` | 200 |
| `claude-haiku-4-5-20251001` | `glm-5.3-flash` | 200 |

所以**填不填都能用**；填了是"我说了算"，不填是"交给 `models.map`"。

---

## 方式 B（兜底）：直接写 `~/.claude/settings.json`

不经过 cc-switch，Claude Code 一样能跑：

```bash
cat > ~/.claude/settings.json <<'EOF'
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8789",
    "ANTHROPIC_AUTH_TOKEN": "<把 cat ~/wb-gateway/data/api-key.txt 的结果粘这里>",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.3-flash",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.3-flash",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4.1-flash",
    "API_TIMEOUT_MS": "3000000"
  }
}
EOF
```

**注意交互**：cc-switch 切换供应商时会**重写**这个文件。所以——
先用方式 B 验证链路，确认没问题后再回方式 A 落到 cc-switch 里，
否则你在 cc-switch 里切一次供应商，手写的内容就没了。

写之前先备份：`cp ~/.claude/settings.json ~/.claude/settings.json.bak`

---

## 要点（两种方式都适用）

- **`ANTHROPIC_BASE_URL` 不带 `/v1`**——Claude Code 会自己拼 `/v1/messages`，带了会变成 `/v1/v1/messages`
- **`ANTHROPIC_AUTH_TOKEN` 用 Bearer 头**；网关同时接受 `x-api-key`，想用 `ANTHROPIC_API_KEY` 也行
- **`API_TIMEOUT_MS` 给足**，上游推理 8 秒~3 分钟波动（pitfalls.md #10）
- **端口要对**：网关默认 `8789`。若 WSL 里跑了别的服务占了它，网关启动会报错，改 `~/wb-gateway/config.json` 的 `port` 并同步改这里的 URL
- **网关必须常驻**：Claude Code 每次请求都打网关，网关不在就整体不可用。WSL 里建议做成 systemd 用户服务，见 `wsl-claude-code.md`

---

## 验证

```bash
# 1) 网关活着
curl -s http://127.0.0.1:8789/healthz | head -c 120      # 要有 "ok":true 和非空 accounts

# 2) cc-switch / 手写配置生效
grep 8789 ~/.claude/settings.json

# 3) Claude Code 实跑
claude -p "用一句话说明你是谁"
```

第 3 步若回话正常，且网关终端里出现 `假名 claude-… → 真实模型` 的日志行，就是通了。
