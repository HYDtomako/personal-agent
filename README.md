# pi-agent

住在你电脑上的个人 agent：浏览器打开一个本地页面就能跟它说话，它能查资料、记事、定任务，也能在你的工作目录里真的动手改文件、跑命令。

大脑是 [pi](https://github.com/earendil-works/pi)（coding agent），界面是本机 HTTP 服务 + 一个单页（无构建、无前端依赖）。除 pi 本身外没有第三方依赖，Node 24 直接跑 TypeScript。

> 这是作者自用项目的公开版（内部昵称「咕嘎一号」）。QQ bot、Telegram、Notion 长期记忆都是可选集成，不配也能用。

```
桌面窗口 / 浏览器 (127.0.0.1:8787)
    │  POST /api/send       发消息
    │  GET  /api/events     SSE：文字增量、工具调用、用量
    ▼
主程序 src/main.ts
    │  每条消息 spawn 一个 `pi --mode json` 子进程
    ▼
pi coding agent（cwd = workspace/）
```

## 概览

独立构建的本地个人 Agent 系统：以 pi 为推理内核，自研运行时与交互层，整合长期记忆、多渠道通信、浏览器与桌面自动化及外部编码能力，目标是具备持续交互、记忆复用与本机执行能力的个人 agent。

**技术栈**

- 推理内核：[pi](https://github.com/earendil-works/pi)（coding agent）
- 外部编码调度：herdr
- 长期记忆：Notion（Memory 数据库）
- 外部能力接入：MCP
- 桌面自动化：CUA driver
- 浏览器自动化：ego lite

**长期记忆**：集成 Notion 构建外部长期记忆系统，分离会话上下文、长期记忆与对话流水，通过相关性检索与动态注入实现跨会话信息复用。

**编码任务交付**：基于 herdr 调度外部 Coding Agent，结合独立执行、任务验收、Review 与结果回写，实现编码任务的后台执行及交付闭环。

**跨渠道与自动化操作**：以 Telegram 为主要交互入口，可通过 QQ Bot 桥接实现跨渠道消息互通；集成 ego lite 浏览器自动化与 CUA 桌面操作，并接入邮箱能力，结合浏览器工具实现邮件收发、账号注册等事务性操作，拓展 agent 的实际执行能力。

## 快速开始

需要 Node 24+。先装好 [pi](https://github.com/earendil-works/pi)，把 `config.example.json` 里的 `pi.args` 指到它的 `dist/bundle/cli.js`。

```bash
npm i
cp config.example.json config.json                            # 填 pi 路径、模型、Tavily key
cp workspace/.pi/SYSTEM.example.md workspace/.pi/SYSTEM.md    # 人格与行为准则，按需改
cp workspace/.pi/mcp.example.json workspace/.pi/mcp.json      # 可选：MCP 服务（浏览器、Notion、桌面操作）
npm run app:install                                          # 可选：装桌面图标
```

`config.json` 含密钥，`.gitignore` 已排除。`workspace/.pi/SYSTEM.md` 建议按自己的习惯改写，同样不要提交个人内容。

双击桌面上的「咕嘎一号」即可：同时确保 PA 主服务和 Telegram 桥接都在运行，重复点击不会另起实例。项目目录里的 `start-pa.bat` 用于正常启动，`restart-pa.bat` 用于只重启本项目的这两个进程，不操作 QQbot；不另外创建桌面重启图标。也可以 `npm start` 只起主服务、自己开页面。`config.json` 里的 `agent.userId` 是记忆归档用的键，随便起个名字（默认 `me`）。

## 桌面图标

```bash
npm run app:install      # 桌面 + 开始菜单各放一个（名字取自页面标题）
npm run app              # 启动 PA + Telegram 并开窗口，已有进程则复用
node app/launch.ts --no-window  # 只确保 PA + Telegram 在后台运行
npm run app:restart      # 仅重启 PA + Telegram 并开窗口
npm run app:stop         # 仅停止 PA + Telegram
npm run app:uninstall    # 卸掉快捷方式
```

双击图标会依次：

1. 串行执行启动操作，检查主服务的进程入口、PID 和工作目录；服务没起就后台启动，输出写进 `memory/server.log`。
2. 等主服务真正就绪，再检查并补启动 Telegram 桥接（配置未启用时跳过）；桥接输出写进 `memory/telegram.log`。
3. 用系统自带的 Edge/Chrome 的 `--app` 模式开一个**没有标签栏、没有地址栏**的窗口。

主服务和 Telegram 桥接各自持有操作系统级单实例锁，直接运行脚本也不能重复启动；崩溃后锁自动释放。停止/重启只处理命令行入口精确属于当前项目的进程，并再次核验创建时间，不按 `node.exe`、`main.ts` 子串或端口批量杀进程。端口被其他项目占用时会报错，保留占用者。旧 Telegram 登录启动快捷方式会迁移到统一启动器，先起主服务再起桥接。

所以不再经过默认浏览器（不再冷启动别的浏览器），也不会留一个必须一直开着的 cmd 窗口。服务已经在跑时再双击，只开一个新窗口，不会起第二个。

关窗口**不停服务**（定时任务继续跑，下次双击也就秒开）。要停用 `npm run app:stop`。开机自启加 `--autostart`，例如 `node app/install.ts --autostart`。

没引 Electron：服务自己冷启动只要 ~170ms，慢的从来不是它。代价是双击时任务栏会闪一下（启动器自己的控制台，最小化运行，起完就退）。

## 后台编码任务与时限

PA 的对话轮次与 CA 编码任务现在分开运行。`agent_dispatch` 只提交持久任务并返回编号，PA 随即结束当前轮，聊天可以继续；`agent_wait` 是兼容名称，只读一次状态快照，不再长时间等待。CA 不绑定具体执行器：任何能在终端里非交互跑起来的 coding CLI 都可以，由 herdr 起在独立工作区中，以完全自动（Never Ask）参数启动，仍须遵守原任务范围和用户授权。

| 设置 | 默认值 | 含义 |
|---|---:|---|
| `agent.timeoutMs` | 180000（3 分钟） | PA 单轮理解、派发和短处理，不包含 CA 执行 |
| `delegations.timeoutMs` | 3600000（60 分钟） | CA 开始执行后的总体时限，排队时间不计入 |
| `delegations.maxTimeoutMs` | 14400000（4 小时） | 单个任务可指定的时限上限 |
| `delegations.idleWarningMs` | 900000（15 分钟） | 无可观察进展时提醒，不立即杀掉 CA |
| `delegations.startupTimeoutMs` | 120000（2 分钟） | 启动阶段的保护时限 |
| `delegations.reviewTimeoutMs` | 180000（3 分钟） | 独立验收时限，不占普通聊天执行器 |
| `delegations.maxConcurrent` | 2 | CA 并发上限，同一真实工作目录串行 |

执行器自身的首次目录 Trust 门独立于自动参数。PA 仅在实际弹框目录与本任务 cwd 精确相符、且启动前及确认前都未发现项目 MCP 配置文件时自动确认；每次后续启动仍会重新检查。有项目 MCP 文件、Git 根无法确认或配置不可读时拒绝自动启用并明确报告。这个原生目录信任会持久化，不绑定 MCP 内容；在终端里手工启动执行器不经过 PA 的前置检查，仍遵循该执行器自己的信任语义。用户级 MCP 配置未修改。

后台任务记录在 `memory/delegations.json`，CA 结果报告在 `memory/delegation-results/`，独立验收记录在 `memory/delegation-reviews/`。`completed` 只代表 CA 提交了完成报告；系统再核对实际文件与测试，无法核实会明确显示尚未验收，不能把接收或执行结束当成成功。

所有聊天入口共用短轮次队列，避免并发写同一个模型会话。请求存于 `memory/requests.json`；重启时原 running 对话标记中断而不是盲目重跑，已派发的 CA 独立恢复监管。后台会核对 herdr terminal/session 身份；如果 herdr 自身重启导致终端替换，报告中断，不假装原任务仍在运行，也不自动重复编码。

Telegram 使用 `POST /api/requests` 立即入队，接收和通知投递循环独立运行；不再把一个 HTTP 请求挂到任务结束。通知 outbox 在 `memory/notifications.json`，经 `GET /api/notifications?channel=telegram` 读取并在发送成功后 ACK。发送与 ACK 的网络异常分别处理；仅承诺至少一次投递，不能保证 Telegram 响应丢失等窗口绝不重复。QQ 沿用现有 bot 文件信箱自动回原目标，写入信箱代表已交给 bot，不等同于 QQ 平台确认送达。

页面的“后台任务”面板可查看缓存输出和取消指定任务；聊天的“停止”和“新对话”不取消 CA。超时/取消只关闭该任务自己的 herdr 工作区，不停止整个 herdr；已脱离终端的外部子进程不保证被终止。任务和通知记录保留以便排查，未确认通知不丢弃。

升级运行中的服务需要 `node app/launch.ts --restart --no-window`，修改 `.pi/SYSTEM.md` 则下一轮生效。正常重启 PA 不重新派发已有 CA；先确认没有正在处理的 PA 对话，避免中断短轮次。

## 委派执行模式

默认 `delegations.mode = "direct"`：`agent_dispatch` 把原项目目录直接交给 CA，CA 在原项目里修改；不创建隔离树、不做回写、不产生交付 hold。完成后主服务仍会独立验收并回传结果，但改动从 CA 动手那一刻起就已经在原项目里。这条路径适合个人项目和大多数日常修复；代价是 CA 的错误会直接落在原项目，回滚需要你自己用 Git/备份处理。

需要隔离时，把 `delegations.mode` 改成 `"worktree"`，或在单次 `agent_dispatch` 里传 `isolation: "worktree"`。worktree 模式会记录目标仓库、分支、HEAD 和用户现有修改，在 `memory/worktrees/<任务id>` 创建 detached worktree；CA 在工作树实现，PA 先验收工作树，再将相对基线的增量回写原目录，并在原目录复验。通过后才清理该任务自己的工作树，基线、增量和事务记录保留在 `memory/project-deliveries/`。

worktree 模式下，原目录的 staged/unstaged/untracked 内容进入基线，不会被当作 CA 新成果。回写不操作原 index，不自动 stash/reset/checkout。目标分支、HEAD、index 或相关文件不符合基线时，保留隔离成果并报告；已包含同样结果的文件不重复覆盖。回写失败或目标复验失败，仅在目标仍是本次写入时安全回滚；无法安全还原则保持项目 hold，不覆盖新的用户内容。direct 模式没有这层保护和回写步骤。

CA 结束不等于验收通过。以上回写、原目录复验和清理只适用于 worktree 模式；direct 模式的改动已经在原项目里，只会做独立验收，没有 delivery 记录，也不能 `agent_integrate`。面板与回执会显示任务未提交、未推送、未部署。`agent_integrate` 或“重试交付”只重试 worktree 的验收和文件交付，不重跑 CA；在途回调或其他同仓库任务占用时会拒绝。旧版任务没有基线，不会自动接管和猜测合并。

非 Git 项目采用有界备份后原地修改，不创建假的 Git 仓库。依赖、运行数据、备份目录与嵌套 Git 项目不会递归复制；排除项保存在交付记录。失败时保留备份，不盲目回滚可能混入的用户修改。工作树不是操作系统沙箱；默认不支持符号链接、子模块、特殊 index 布局和超过上限的大批回写，遇到这些情况明确阻断，不擅自展平或覆盖。

默认不自动安装依赖或建立指回原目录的可写链接；CA 可按任务范围把已有依赖复制进自己的执行目录。若缺少依赖导致无法测试，会保留工作树并报告，不能把未验收说成完成。提交、推送、部署和业务服务重启仍需单独明确授权。

```bash
npm run selftest:project-delivery   # 临时真实 Git 仓库：基线、回写、冲突、恢复、清理
npm run selftest:delivery-pipeline  # 两阶段验收、回滚与重试
npm run selftest:review-result     # 必要测试及实际核查证据必须满足，才放行交付
npm run selftest:delivery-live      # 默认 dry-run，零网络发送
npm run selftest:project-delivery-live # 默认 dry-run，不启动真实 CA
# 仅明确授权真实编码自检后（新建专用测试仓库，不修改业务仓库）：
node scripts/project-delivery-livecheck.mjs --run
# 仅明确授权本人私聊测试后：
node scripts/delivery-live-selftest.mjs --send
```

真实投递测试固定使用已配置本人目标，不往默认群发送。Telegram 的平台回执保存在有界 `memory/telegram-deliveries.jsonl`；QQ 在本人会话范围核对 history/get_msg。取得 message_id 不代表对方已读；信箱被消费或本地 ACK 不能替代平台发送证据。

## 一套工具，不分档

不再有问答/动手的切换，每条消息都给完整工具集：

| 能力 | 工具 |
|---|---|
| 本地 | `read` `bash` `edit` `write`（工作目录 `workspace/`） |
| 联网 | `web_search` `web_read` |
| 其他 | `current_time` 记忆 / 任务 / 模型管理 / `qq_send` |

（早期版本把"读不可信内容"和"能执行命令"拆在两个进程里防注入；合并后这层隔离没了，如需长期挂着跑，建议整体放进容器或 WSL，只挂需要的工作目录。）

## 权限从哪来

没有身份判断，谁能打开这个页面谁就能指挥它。因此：

- **使用者身份经环境变量注入**（`PI_USER_ID`）。旧做法是让模型从消息里抄一个"我是谁"，那是个能被注入骗过的字段；现在模型改不了自己是谁。
- **页面只监听 127.0.0.1**。要让手机也能连，`gui.host` 改 `0.0.0.0` 时必须设 `gui.token`——不设会被启动检查直接拦下，因为那等于把有 shell 权限的 agent 开放给整个网段。
- **图片/文件只从 workspace 里读**：`/api/file` 做了路径穿越检查（`../config.json` 一律 404）。
- **输出统一脱敏**：配置里的密钥值、`sk-`/`tvly-`/`Bearer` 形态、百炼实例域名都不会出现在页面上。

## 目录

```
src/
  main.ts    启动、消息处理、定时任务、脱敏
  server.ts  HTTP + SSE + 上传 + 文件服务（无依赖）
  runner.ts  pi 执行器：身份/请求上下文注入 + 事件流解析 + 中止
  requests.ts 持久聊天队列与幂等请求（只串行短轮次）
  delegations.ts 独立编码队列、时限、恢复、状态和通知
  herdr.ts   有限时 CLI 适配器与独立 server 启动
  notifications.ts 持久回执 outbox
  protocol.ts 回复渠道的共享类型与校验
  memory.ts  会话窗口（短期）+ 本地归档读取兜底
  notion-memory.ts  Notion Memory 读取、相关性选择与注入
  store.ts   对话记录（页面显示用）
  tasks.ts   定时任务调度（交互任务优先）
  uploads.ts 上传文件落地：图片直传、文档先取文
  docparse.ts PDF/Word/Excel/PPT 取文
  video.ts   B 站/YouTube 链接下载、字幕/语音转写、关键帧准备
  config.ts  配置类型与校验
public/
  index.html 整个界面（单文件，无构建）
app/         桌面启动器（零依赖，没引任何第三方包）
  launch.ts  起服务 → 等就绪 → 开无边框窗口（--console 则前台跑、带日志）
  install.ts 写快捷方式；--autostart 开机自启，--remove 卸掉
  stop.ts    精确核验入口与创建时间，只停本项目主服务和 Telegram
  runtime.mjs 单实例锁、项目进程身份核验与停止保护
  icon.ts    手写 PNG + ICO 生成图标（4x4 超采样抗锯齿）
  name.ts    应用名取自页面 <title>，改名后重跑 install 即可
workspace/   ← pi 的工作目录，也是它唯一该写东西的地方
  .pi/SYSTEM.md   人格与行为准则（改动下一条消息生效）
  .pi/extensions/ 扩展：时间、联网、记忆（Notion）、Notion 检索、模型、定时任务、百炼 provider
memory/      会话文件、长期记忆只读归档、对话记录（不进 git）
config.json  配置（不进 git）
```

## 视频链接总结

Telegram 或网页里直接发送公开视频链接，并要求总结内容即可，例如：

```text
请总结这个视频：https://www.bilibili.com/video/BV...
```

pa 会自行调用 `video_subtitle` 读取平台已有字幕，再在当前对话里基于字幕总结。其他平台只要 `yt-dlp` 支持且视频有字幕，也可以尝试。

当前只读取平台已有字幕，不下载视频、音频或 Whisper 模型；字幕抓取不消耗模型 Token，后续总结才消耗模型 Token。平台没有可读字幕时，pa 会直接说明。视频只依赖可选的 `yt-dlp`，可以装进项目下的 `video-runtime/` 虚拟环境。

## 长期记忆（Notion）

2026-10-22 起，长期记忆的唯一 active 源是 Notion 的 Memory 数据库（`config.json` 的 `notion.dataSourceId` / `databaseId`）。

- `remember` / `recall` / `forget` 直接读写 Notion；`forget` 只把状态改为 archived，页面保留可恢复。
- `remember` 会跨类型查重：同类型高度相似自动更新；跨类型相似会返回候选，按情况用 `merge_with` 合并/改类型，或用 `link_to` 新建并在 `依据` 字段关联，不再 memory/taste 各存一份。
- taste/project 条目的原则保持短，项目细节放在页面正文；`关键词` 字段放 2–5 个检索词（项目名、主题、同义说法），按项目名也能找回。
- 每轮对话由主程序从 Notion 取 active 条目，按相关性注入；profile 类型始终注入。
- 本地 `memory/long-term/me.jsonl` 和 `taste.jsonl` 已冻结为 2026-10-22 前的只读归档，默认不读、不再写入。只有 Notion 读取失败，或用户问更早的旧事时，才用 `recall(source=archive)` 查本地。
- `notion_search` / `notion_read` 用于读资料页；长期事实优先用 `recall`。

## 自检

后台任务相关回归均使用隔离目录、fake worker/adapter，不调用真实模型、不发 QQ/TG 消息：

```bash
npm run selftest:delegate
npm run selftest:delegations
npm run selftest:requests
npm run selftest:telegram
npm run selftest:runner-background
npm run selftest:background  # 真实本地 HTTP + 隔离主程序，模型与 CA 为 fixture
npm run selftest:app         # 隔离的单实例、重启、端口冲突与项目停止保护
```

旧 `npm run smoke` 覆盖记忆、上传与执行器；记忆部分已改为只读检查（扩展注册 + 本地归档不被写入 + 未配置 Notion 时拒绝写入），不会再写实际长期记忆。

覆盖：配置校验（含"对外监听必须带口令"这条）、对话记录读写、上传取文（文本/图片/压缩包各走一条路）、**记忆往返**（扩展进程写入 → 主程序读取，两边靠路径与文件格式的隐式约定协作）、执行器的事件解析、GUI 接口与路径穿越防护。

文档取文另有回归：

```bash
node scripts/docparse-selftest.ts [-v] 文件1 文件2 ...
```

## 一些取舍

- **定时任务与普通对话用同一套工具**：交互消息优先执行，没排队的交互任务时才轮到定时任务。
- **一张图片也别指望它自己贴上来**：让它把生成的图显示到页面上，需要它在回复里写一行 `[[IMG:workspace 下的相对路径]]`，页面会渲染成图片（只允许 workspace 内的路径）。
- **两个"记忆"不是一回事**：`memory/user-<id>.jsonl` 是给模型看的会话上下文（pi 的事件流），`memory/chat.jsonl` 是给你看的对话记录。想从头开始，删掉这两个文件即可。长期记忆不在这里：它在 Notion 的 Memory 数据库，本地 `memory/long-term/` 只是只读归档。
- **PA 单轮与 CA 时限分离**：`agent.timeoutMs` 默认 300 秒（5 分钟），只约束对话轮次；CA 默认独立执行 60 分钟。PA 超时或界面「停止」不取消已派发 CA；取消编码任务要用任务面板或 `agent_cancel`。
- **`workspace/` 不是沙箱**。给的是你账户的完整权限，`cd ..` 就能出去。人格里写了"别碰 config.json / memory / src"，但那是纪律，不是墙。要长期挂着跑又不想盯着，正确做法是把它整个放进容器或 WSL 里，只挂需要的工作目录（pi 官方文档 `docs/security.md`、`docs/containerization.md` 也是这个建议）。

## 排障

- **双击图标没反应**：主服务日志在 `memory/server.log`，Telegram 日志在 `memory/telegram.log`；启动失败会弹窗说明原因。
- **Telegram 不回复、网页正常**：再次点击「咕嘎一号」会补启动缺失的桥接，不会重复启动主服务。若桥接仍在运行但网络卡住，可双击项目目录里的 `restart-pa.bat`。Telegram 仍依赖配置的代理可用；单实例保护不能替代网络连接。重启会中断 PA 正在执行的任务，但不会清空对话或记忆。
- **页面打不开**：看 `memory/server.log` 里有没有 `[gui] 已启动`；端口被占就改 `gui.port`。
- **想留个黑窗口看日志**：`start.bat`，或者 `node app/launch.ts --console`（前台跑，Ctrl+C 一起退）。
- **回复很慢或超时**：`pi.thinking` 越低越快（默认 `minimal`）；重活会跑满整个流程，正常。
- **模型报错**：先在命令行手动跑一次 pi 确认 key 与模型名可用；`model_manage` 工具或界面右上角都能看到当前模型。
- **PDF 读不出来**：需要 `pdftotext`（Git for Windows 自带），找不到时在 `files.pdftotext` 里填完整路径。
