# workbuddy-claude-bridge

> ## ⚠️ 免责声明（请先读）
>
> - **本项目仅供个人学习、技术研究与互操作性探索**，不是腾讯或 Anthropic 的官方产品，与两家公司均无关联。
> - **不鼓励、不支持任何违反服务条款的行为**，包括但不限于：多账号刷额度、共享/出借账号、绕过付费墙、批量注册、将本项目用于商业用途或再包装为对外服务。
> - **本项目只服务"一个"你本人已登录的账号**，不含账号池、轮换、自动切换、额度监控等任何额度套利功能。
> - **使用本项目的风险由使用者自行承担**，包括但不限于账号被限制或封禁、服务失效、数据损坏。
> - **请优先使用官方 API 与官方集成。** 如果腾讯后续为 WorkBuddy / CodeBuddy 提供官方桥接或开放 API，请立即迁移到官方方案并停止使用本项目。
> - 本项目**不提供**任何账号购买、代充、分享链接或群组。

---

把 **WorkBuddy（腾讯 CodeBuddy）** 桌面端已登录的账号，变成本地一条 **Anthropic Messages API** 端点，供 **Claude Code / Claude 桌面端** 调用。

一个本地反代网关 + 一套可对话的安装向导，全部踩坑实录都内置好了。

```
Claude 桌面端 / Claude Code
      │  ANTHROPIC_BASE_URL = http://127.0.0.1:8789
      ▼
workbuddy-anthropic-gateway   ← 本项目（Node 直跑 TypeScript，零 npm 依赖）
      │  读本机单个账号的明文登录态 → 转发
      ▼
https://copilot.tencent.com   ← WorkBuddy 客户端同款接口（逆向适配，见下）
```

## 这是什么

WorkBuddy 桌面端背后有一套模型接口，但没有官方途径给 Claude Code 用。这个项目在本地起一个小网关，把 WorkBuddy 的登录态转成标准 **Anthropic Messages API**，于是 Claude Code 和 Claude 桌面端就能直接选用 WorkBuddy 里的模型（GLM、DeepSeek、Kimi、MiniMax、混元……）。

**合规设计（与早期版本的区别）：**

- **单账号**：只使用一个你本人已登录的 WorkBuddy 账号。没有账号池、没有请求间轮换、没有自动切换；换账号只能改 `accounts.select` 配置后重载。
- **单模型**：每个请求只用配置映射的那一个模型。没有多模型回退链、没有"失败自动换模型重试"。
- **无额度功能**：不监控、不刷取、不均衡任何积分/额度。
- **无密钥硬编码**：网关密钥首次运行自动生成在 `data/api-key.txt`（已 gitignore）；本机相关配置放 `config.local.json`（已 gitignore）。

## 逆向适配声明

上游接口（`copilot.tencent.com`）**没有公开文档、不属于任何公开 API**。网关对它的调用方式、请求头与请求体净化逻辑（如规避上游渠道校验 11128）均来自对客户端的观察，**可能随时变更或下线，本项目不对可用性与稳定性做任何保证**。代码中相关位置均有 `⚠️ 逆向适配` 注释标明。

## 伦理使用条款

使用本项目即表示你同意：

1. 仅将本项目用于**你本人**的账号与**个人**学习、研究场景；
2. 不利用本项目实施多账号刷额度、共享账号、绕过付费墙、批量注册等违反服务条款或平台规则的行为；
3. 不将本项目或其修改版用于商业用途、对外服务或再分发为"代充/代刷"工具；
4. 不提供、不索要任何账号购买、代充、分享链接或群组；
5. 自行承担因使用本项目导致的一切后果（含账号封禁、服务中断）；
6. 官方方案可用时，优先使用官方方案。

## 特点

- **零依赖**：网关是 6 个 TypeScript 源文件，只用 Node 内置模块，不需要 `npm install`，不需要打包构建
- **两种客户端都支持**：Claude 桌面端（3P gateway 模式，动态发现全部模型）+ 终端 Claude Code（经 cc-switch 接入）
- **1M 上下文如实申报**：上游真实支持 1M 的模型（GLM-5.3-Flash、DeepSeek-V4.1-Flash、Kimi-K3 等）会在桌面端出现 `[1m]` 变体，不再被压成 200K
- **自愈式常驻**：计划任务双触发器（登录 + 每 5 分钟自检），进程意外死掉最多 5 分钟自动复活，隐藏窗口无弹黑框
- **踩坑全内置**：从一台空白电脑到跑通的全过程，含 16 条真机排障记录（`references/pitfalls.md`）
- **一键部署**：`scripts/setup-gateway.ps1` 幂等执行——启动网关、写客户端配置、注册开机自启

## 快速开始

**前置**：Windows 10/11、已登录的 WorkBuddy 桌面端、Node.js（需能直接运行 `.ts`，即 22.18+ 或更新的 LTS）

```powershell
cd workbuddy-claude-bridge\scripts
powershell -ExecutionPolicy Bypass -File .\doctor.ps1
```

体检表会把缺的东西列出来。补齐后：

```powershell
powershell -ExecutionPolicy Bypass -File .\setup-gateway.ps1
```

脚本会自动找到同级文件夹里的网关。如果网关放在别处，再补 `-GatewayDir "路径"`。

然后**完全退出** Claude 桌面端（右键托盘图标 Quit）再打开——模型选择器里就会出现全部模型。

> 更详细的安装流程，见 [`SKILL.md`](SKILL.md)（按对话阶段走，一次只做一件事）。

## 只用单个账号（默认行为）

网关启动时按以下规则选出**唯一**账号，之后整个进程都用它：

1. `accounts.select`（config.json / config.local.json）命中 uid / uin / 备注名 → 固定用它；
2. 没配 select 且扫描到多个账号 → 选第一个带 refreshToken 的（能自动续期）；
3. 再否则 → 选第一个。

启动日志会打印选用了哪个、以及"如何固定用别的账号"。**换账号 = 改 `accounts.select` 后重启（或等配置热重载）**，运行中不会自动轮换。

## 如果你用 DSH / 或其他支持 skill 的 AI 助手

把整个 `workbuddy-claude-bridge/` 文件夹放进 skills 目录，对 AI 说一句「帮我接入 WorkBuddy 到 Claude」，它会自己照着 `SKILL.md` 的 4 阶段流程引导你，不用手动跑脚本。

## 文件结构

```
SKILL.md                    AI 操作手册：4 阶段对话式安装流程
EXPERIENCE.md               一手经验与踩坑心得（模型身份、档位、排障心法）
README.md                   你正在看的这份
references/
  pitfalls.md               16 条真机踩坑实录（症状 → 根因 → 修法）
  desktop-profile-schema.md Claude 桌面端 profile 校验规则（asar 逆向结论）
  config-template.json      网关 config.json 模板（映射已配好）
  config-wsl.json           WSL 内跑网关用的 config.json 模板（绝对 /mnt/c 路径）
  cc-switch-env.md          终端 CLI 在 cc-switch 里要填的 env
  wsl-claude-code.md        在 WSL 里跑网关 + 接 Claude Code 的完整指南
  download-links.md         各组件获取方式
scripts/
  doctor.ps1                环境体检（只读，先跑这个）
  setup-gateway.ps1         一键部署（幂等）
workbuddy-anthropic-gateway/  网关源码（零依赖，Node 直接运行）
```

`workbuddy-anthropic-gateway/config.local.json` 是**本地私有配置**（已 gitignore），覆盖 `config.json` 的同名字段——本机路径、`accounts.select` 等放这里，`config.json` 保持通用默认值即可入库。

## 已知会遇到的坑（都已有对策）

| 现象 | 一句话根因 |
|---|---|
| 全部请求 400，错误码 11128 | 上游识别客户端身份，system 里的计费标记/身份词被拦截（网关已内置净化） |
| 问 AI 是什么模型，答不对 | 网关为绕校验剥掉了身份信息（已改为注入真实模型名） |
| 模型选择器只有 3 个或 5 个 | 客户端缓存 / 模型假名没过桌面端三重校验 |
| 黄色横幅 "provider setup needs a fix" | profile 缺字段或被客户端自己重写剥掉 |
| 凭据全被跳过 | 桌面端 5.6+ 把令牌加密了，需用 workbuddy-switch 的账号库或 xdpool 扫码 |
| workbuddy-switch 装了却没凭据 | 它没有「同步」按钮，也不写 pool 文件；凭据在 `~/.wb-switch/accounts.json`（网关已直接读） |
| 重启后连不上，手动启动却正常 | 计划任务记录的旧路径失效（静默失败） |
| 上下文只有 200K（别处是 1M） | 客户端只认 `/v1/models` 的 `supports_1m` 声明，网关已按上游真实能力如实上报 |
| 拉起网关时闪黑窗 | 任务直跑 node.exe 自带控制台，已改为 VBS 隐藏启动 |
| DSH 里聊天全报错（UNKNOWN_MODEL / 密钥无效） | DSH 全局代理带偏上游拉取，插件退回 10 模型兜底表（NO_PROXY 加白即可） |

完整清单见 [`references/pitfalls.md`](references/pitfalls.md)。

## 免责声明

本项目仅供个人学习与技术研究使用。WorkBuddy / CodeBuddy / Claude 的相关服务条款请自行遵守，**使用风险自负**（包括账号被封禁、服务失效）。项目不包含任何账号、凭据或密钥，也不提供账号购买、代充、分享链接或群组。**如官方提供 API 或桥接，请优先使用官方方案。**

## License

MIT，见 [LICENSE](LICENSE)。
