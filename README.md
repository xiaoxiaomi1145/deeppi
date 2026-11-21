# Deeppi

这是我闲着无聊时想出来的一个项目。感觉 Pi 的风格和 DeepSeek chat-demo 挺搭，就把它们接到了一块儿，顺手加了点自己的神秘小创意。

这个项目可能不会维护得太频繁。大部分功能都是按我自己的需求做的，也许没那么实用，不一定适合每个人。

Deeppi 是 [Pi](https://github.com/earendil-works/pi) 的本机 Web 插件，界面基于 [DeepSeek chat-demo](https://github.com/deepseek-ai/chat-demo)。Web 与 TUI 共用同一个 Pi 会话、模型、工具和原生记录，不另起一份聊天。可选的 Deeppi 增强压缩、Bash 工具库以及 QQ 桥接默认关闭。

## 安装和打开

需要 Node.js 22.19.0 或更新版本，已验证 Pi **1.6.0**。在 Deeppi 源码目录运行：

```sh
npm ci
npm run build
pi install "$PWD"
```

本地安装引用源码目录，不会复制它。只试用一次可运行 `pi -e "$PWD/extensions/deeppi.ts"`，不修改 Pi 的包列表。也可用 `./node_modules/.bin/pi` 启动开发依赖中的 Pi，不必全局安装。在 Pi TUI 输入 `/deeppi`，然后在**同一台机器**的浏览器打开终端打印的完整链接。`/deeppi close` 关闭 Web；它不会关闭已经单独启用的 QQ 监听。退出 Pi 会关闭两者。`DEEPPI_PI_PORT` 可指定 Web 端口，默认由系统分配。

## Pi 原生聊天与设置

- 默认打开 Pi **当前会话**。侧栏显示 Pi 已知工作区及其中的会话，包括当前未写入磁盘的会话和当前配置的自定义会话目录。预览历史只读；点「切换到此会话」才同步切换 Pi。若在 TUI 中先换了会话，网页提示需要重新授权切换时，在当前 TUI 再执行 `/deeppi`。
- 可从 Web 发送、停止、在生成期间追加引导或排到下一轮；模型和思考滑块采用 Pi 当前所选模型确实支持的档位。设置可修改标题、添加会话系统提示词、切换原生工具，并发送一次不带会话或工具的连接探测。
- 原生 MCP 从 Pi 读取。Web 可临时注册 Streamable HTTP 或 stdio MCP，使用 Pi 的 `codemode`、`deferred`、`direct`、`hidden` 暴露方式；持久配置仍通过 Pi 原生 MCP 配置维护。HTTP 凭据可引用 `MCP_` 开头的环境变量，不回显其值。导入信任的 `SKILL.md` 后，在 TUI 执行 `/reload`；之后可通过 Web 或 TUI 调用同一 Pi Skill。
- 前端默认折叠连续工具调用和较早轮次，旧轮次可加载。历史导航支持 WebGPU，不可用时回退到 Canvas 2D；正文始终可选择和复制。

## 配置模型和环境端点

通常只需使用 Pi 的 `/login`、原生模型配置或其 API Key 环境变量。Deeppi 额外把成对的环境 Key 和 URL 接入 Pi：没有 URL 时使用服务商默认地址；配置有效 URL 后，在模型选择器中选对应的 `deeppi-env-*` 模型。独立的服务商 ID 不会将 Pi 已保存的登录凭据转给另一地址。无法匹配的网关模型请用 Pi 自己的模型配置。

| 服务商 | 环境 Key | Base URL 前缀 / 说明 |
| --- | --- | --- |
| DeepSeek | `DEEPSEEK_API_KEY` | `DEEPSEEK_`；Chat Completions |
| OpenAI / 兼容网关 | `OPENAI_API_KEY` | `OPENAI_`；环境网关用 Chat Completions，原生官方模型保留 Pi 的协议 |
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_`；Messages |
| Google Gemini | `GEMINI_API_KEY` 或 `GOOGLE_API_KEY` | `GEMINI_` 或 `GOOGLE_`，与 Key 同前缀；Developer API，非 Vertex，地址须带版本路径 |
| Mistral | `MISTRAL_API_KEY` | `MISTRAL_`；Mistral Chat Completions |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` | `AZURE_OPENAI_`；Responses，优先指定 HTTPS 资源地址，部署名称以 Pi 配置为准 |

各前缀下按 `BASE_URL`、`API_BASE_URL`、`API_URL`、`API_BASE` 查找第一个非空值。例如：`DEEPSEEK_BASE_URL=https://gateway.example/v1`。Azure 另识别 `AZURE_OPENAI_ENDPOINT` 和 `AZURE_OPENAI_RESOURCE_NAME`；自定义 Azure 端点使用 HTTPS。其他网关允许 HTTPS 或本机 HTTP，无效环境地址不会意外回落到官方域名。Pi 自带其他服务商无需 Deeppi 另外适配；旧独立版的服务商范围以上表为限。

## 可选附加功能

| 功能 | Web | Pi TUI |
| --- | --- | --- |
| 原生 Pi 压缩 | 上下文 → Pi 压缩 | `/compact` |
| Deeppi 增强压缩 | 设置 → 工具 → Deeppi 附加能力，启用后在上下文面板选择并填写重点 | `/deeppi-addons enable compact`，然后 `/deeppi-compact [重点]` |
| Deeppi Bash 工具库 | 设置 → 工具 → Deeppi 附加能力，需确认本机执行权限 | `/deeppi-addons enable bash`（确认后开启） |

两端同步开关，可以用 `/deeppi-addons disable compact` 或 `/deeppi-addons disable bash` 关闭。增强压缩用 Pi 原生压缩，只额外提供保留任务状态、决策和约束的指导。Bash 工具库注册 `deeppi_define_tool`、`deeppi_list_tools`、`deeppi_run_tool`，在会话分支内保存脚本，可以传命名参数；它不改变 Pi 原有 Bash。**这不是沙箱**，脚本以 Pi 进程用户的权限运行。

## QQ / OneBot v11

在 Web 中打开「Pi 会话设置 → QQ」。支持反向 WebSocket，或带签名的反向 HTTP 加 OneBot 出站 HTTP API。**保存配置 → 开始监听 → 测试连接 → 开启自动回复**。私聊、群聊、用户准入、工具权限、QQ 模型、思考滑块、压缩、缓存和表情可独立配置。详见[连接与权限指南](<docs/onebot-qq.md>)。

## 保留独立模式

已有数据无需迁移。源码目录仍提供 `npm start`（独立真实模型模式，默认本机端口 `3210`）和 `npm run demo`（无密钥离线演示）；它们不读取或覆盖 Pi 原生记录。独立版默认数据在启动目录的 `.deeppi/`，可以用 `DEEPPI_DATA_DIR` 指定。独立版的 Bash 同样默认关闭，需 `npm start -- --allow-bash` 并在会话内打开；独立版自己的子代理、工作区设置和会话压缩保留。旧会话不会自动导入 Pi。

## 开发和发布

```sh
npm run check
npm run build
npm test
python scripts/smoke-pi.py  # POSIX；真实 Pi CLI + 本机模型/OneBot 测试端
npm pack --dry-run
```

`npm test` 不需要模型密钥。`npm pack` 会预构建两个 Web 入口，只打包发布所需文件；此仓库未在这里发布到 npm。执行真实模型请求时，Pi 或 QQ 会把各自需要的对话上下文发给所选模型服务商。访问链接只供自己使用，Web 和 OneBot 接收端只监听本机，不要暴露到公网。详见[安全与隐私](<SECURITY.md>)。

Deeppi 采用 [MIT 许可证](<LICENSE>)。DeepSeek 界面复用见[来源清单](<web/UPSTREAM.md>)；Pi、WebSocket 依赖和其他上游声明见[第三方声明](<THIRD_PARTY_NOTICES>)。项目不是 DeepSeek、Pi、腾讯 QQ 或 OneBot 的官方发行版。

本项目只推荐用于在 Pi Agent 进行 AI 编码时使用。不推荐用于领养赛博老公、老婆、宠物等方案。如果准备使用此项目进行以上方案，推荐更换项目。
