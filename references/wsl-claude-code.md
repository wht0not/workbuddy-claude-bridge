# 在 WSL 里跑网关 + 接 Claude Code

目标：**Claude Code 跑在 WSL（Ubuntu）里，背后用 WorkBuddy 的模型**。
Windows 上的 Claude 桌面端、cc-switch 那套都不需要。

---

## 0. 先理解两个约束（决定后面怎么走）

| 约束 | 事实 | 影响 |
|---|---|---|
| 网关是 TypeScript，零 npm 依赖 | 靠 **Node ≥ 22.18** 直接跑 `.ts` | WSL 的 `node` 若低于 22.18 跑不了 |
| WSL2 默认 NAT 网络 | **WSL → Windows 的 `localhost` 不通** | 网关若跑在 Windows，WSL 里 `127.0.0.1:8789` 连不上 |

先确认 WSL 的 Node 版本：

```bash
node --version        # ≥ 22.18 才能直接跑 .ts
```

> `localhostForwarding=true`（`.wslconfig`）只解决 **Windows → WSL** 方向，
> 反向（WSL → Windows）要么用宿主机 IP（会变），要么开 mirrored 模式（要重启 WSL）。
> 所以**最稳的是让网关也跑在 WSL 里** —— 那时 `127.0.0.1:8789` 对 Claude Code 就是真本地。

---

## 方案 A（推荐）：网关跑在 WSL 内

### A1. 装 Node 22 LTS（若版本不够）

```bash
# NodeSource，一条命令装 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version        # 确认 ≥ 22.18
```

已经够了就跳过。

### A2. 把网关代码放进 WSL

网关是纯 TypeScript、零依赖，**整个文件夹复制过去即可**：

```bash
mkdir -p ~/wb-gateway
cp -r /mnt/d/Users/28690/Desktop/workbuddy-claude-bridge/workbuddy-anthropic-gateway/* ~/wb-gateway/
```

> 想省这一次复制、直接在 Windows 项目目录上跑也行
> （`cd /mnt/d/Users/28690/Desktop/workbuddy-claude-bridge/workbuddy-anthropic-gateway`），
> 但那样 Windows / WSL 会抢同一个 8789 端口和 `data/api-key.txt`，**二选一，别同时跑**。
> 推荐复制到 `~/wb-gateway`，两边互不干扰。

### A3. 写 WSL 版 config.json

关键是 `accounts.wbSwitchFiles` 和 `accounts.dirs` 必须用 `/mnt/c/...` 绝对路径
（WSL 里没有 `%LOCALAPPDATA%` 这种 Windows 环境变量，展开不了）：

```bash
# 用模板生成 config.json（用户名 28690 已按本机填好；换机器就改这个 sed）
sed 's|<你>|28690|g' \
  /mnt/d/Users/28690/Desktop/workbuddy-claude-bridge/references/config-wsl.json \
  > ~/wb-gateway/config.json
```

生成的 `accounts` 段应是：

```json
"accounts": {
  "dirs": [
    "/mnt/c/Users/28690/AppData/Local/CodeBuddyExtension/Data/Public/auth",
    "/mnt/c/Users/28690/AppData/Roaming/CodeBuddyExtension/Data/Public/auth"
  ],
  "extraFiles": [],
  "wbSwitchFiles": [
    "/mnt/c/Users/28690/.wb-switch/accounts.json"
  ]
}
```

**先确认这两个路径在 WSL 里真的可见**（默认 automount 应该都有）：

```bash
ls -l /mnt/c/Users/28690/.wb-switch/accounts.json
ls -l /mnt/c/Users/28690/AppData/Local/CodeBuddyExtension/Data/Public/auth/
```

**凭据不用重新登录** —— workbuddy-switch 的账号库在 `/mnt/c` 下可读。

### A4. 启动网关

```bash
cd ~/wb-gateway
node src/server.ts
```

正常应看到：

```
账号    1 个可用
        ✓ why not (4b626055) ← /mnt/c/Users/28690/.wb-switch/accounts.json
        ✗ .../workbuddy-desktop.info → accessToken 不可用（$wbEncrypted 加密包装或缺失）   ← 这行是正常的，忽略
```

`✗` 那行**不是错误**：桌面端 5.6+ 的令牌是加密的，网关读不了，跳过即可（pitfalls.md #5）。

### A5. 接 Claude Code

任选一种：

**① 环境变量（临时，当前 shell 有效）**

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8789"
export ANTHROPIC_AUTH_TOKEN="$(cat ~/wb-gateway/data/api-key.txt)"
export ANTHROPIC_MODEL="glm-5.3-flash"
export ANTHROPIC_DEFAULT_OPUS_MODEL="glm-5.3-flash"
export ANTHROPIC_DEFAULT_SONNET_MODEL="glm-5.3-flash"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="deepseek-v4.1-flash"
export API_TIMEOUT_MS="3000000"
claude
```

**② cc-switch（WSL 里也装了，`~/.local/bin/cc-switch`）**

这是最常被问到的：cc-switch 在 WSL 里是**独立一份**（自己的 `~/.cc-switch/cc-switch.db`），
和 Windows 那份互不相干。做法是在 Claude 分类里**新增一个供应商**（别改现有那个），
字段值、可粘贴的完整 JSON、以及 cc-switch v4 的 SQLite 存储位置，
见 **`cc-switch-env.md` 的方式 A**——那篇就是专门写这个的。

> 注意：cc-switch 不转发流量，它只是把选中供应商的 `env` 写进 `~/.claude/settings.json`。
> 所以"网关没跑"的时候，cc-switch 里配得再对也连不上。

**③ 写进 `~/.claude/settings.json`（永久）**

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8789",
    "ANTHROPIC_AUTH_TOKEN": "<~/wb-gateway/data/api-key.txt 的内容>",
    "ANTHROPIC_MODEL": "glm-5.3-flash",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.3-flash",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.3-flash",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4.1-flash",
    "API_TIMEOUT_MS": "3000000"
  }
}
```

### A6. 验收

```bash
curl -s http://127.0.0.1:8789/healthz                                   # "ok":true
curl -s -H "x-api-key: $(cat ~/wb-gateway/data/api-key.txt)" \
     http://127.0.0.1:8789/v1/models | head -c 200                       # 应列出 28 个模型
```

然后在 Claude Code 里 `/model` 选一个，发一句话。**通了就是完工。**

### A7.（建议）让网关常驻

网关不在 = Claude Code 整体不可用。WSL 重启后手起的进程就没了，做成 systemd 用户服务：

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/wb-gateway.service <<'EOF'
[Unit]
Description=WorkBuddy Anthropic Gateway
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/wb-gateway
ExecStart=/usr/bin/node src/server.ts
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

# 先确认 /usr/bin/node 就是 22.18+（用 nvm 装的要改成绝对路径）
/usr/bin/node --version

systemctl --user daemon-reload
systemctl --user enable --now wb-gateway
loginctl enable-linger "$USER"        # 不登录也常驻

systemctl --user status wb-gateway --no-pager
journalctl --user -u wb-gateway -n 20 --no-pager    # 看启动日志
```

> 本机 `/etc/wsl.conf` 已有 `[boot] systemd=true`，所以 systemd 可用。

常用操作：`systemctl --user restart wb-gateway` / `stop` / `disable`。
日志会一直追加，网关的 `console.log` 都在 `journalctl` 里。

---

## 方案 B：网关留在 Windows，WSL 开 mirrored 网络

适合"不想在 WSL 再装一套 Node"的情况。代价是要改 `.wslconfig` 并重启 WSL（**会中断当前所有 WSL 会话**）。

`C:\Users\28690\.wslconfig`（本机已有这个文件，加一行 `networkingMode=mirrored` 即可）：

```ini
[wsl2]
memory=4GB
processors=4
networkingMode=mirrored
```

然后 **PowerShell 执行 `wsl --shutdown`**，重开 WSL。

之后 Windows 上照常跑网关（`scripts\setup-gateway.ps1`，Node 22.22.2 已就绪），
WSL 里 `http://127.0.0.1:8789` 直接可达，第 A5 步的配置原样可用。

**mirrored 模式的已知影响**：WSL 的网络行为整体改变，部分端口绑定、容器网络、多播场景会受影响。
纯开发用途一般无感；如果 WSL 里还跑着 Docker / 需要特定端口转发的服务，先评估再开。

---

## 方案 C：网关留在 Windows，WSL 用宿主机 IP（零改动，但不推荐）

不改任何配置，代价是 IP 会变。

```bash
# WSL 里临时用
export ANTHROPIC_BASE_URL="http://$(ip route show default | awk '{print $3}'):8789"
```

`wsl --shutdown` 或 Windows 重启后 IP 可能变，配置就失效了。只适合临时验证。

---

## 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| `node src/server.ts` 报 `Unknown file extension ".ts"` / 语法错误 | Node < 22.18，没有类型剥离 | 升级 Node（A1） |
| `healthz` 通了但 `accounts` 是空数组 | `wbSwitchFiles` 路径写错，或账号库在别的盘 | `ls -l /mnt/c/Users/28690/.wb-switch/accounts.json` 确认；路径必须绝对 |
| 上游 401 / `API key 无效` | 用的是 Claude Code 里的 key，不是网关的 | `ANTHROPIC_AUTH_TOKEN` 取 `~/wb-gateway/data/api-key.txt` |
| 上游连接失败（status 0） | WSL 里 DNS 或出网被限 | `curl -I https://copilot.tencent.com` 试上游连通性 |
| 模型选择只有几个 / 时有时无 | cc-switch 缓存 | pitfalls.md #0：cc-switch「选用的模型」→「获取模型」 |
| WSL 里 `127.0.0.1:8789` 连不上，但 Windows 上正常 | NAT 模式下 WSL→Windows localhost 不通 | 用方案 A 或 B |
