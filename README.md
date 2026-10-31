<div align="right">
  <span>[<a href="./README.en.md">English</a>]</span>
  <span>[<b>简体中文</b>]</span>
</div>

<div align="center">

# ShuaDouyin · 刷抖音

<img src="docs/assets/shuadouyin-hero.png" alt="ShuaDouyin 刷抖音：浏览与搜索、评论与互动、私信与分享、直播与弹幕、关系与跟进、人格与记忆" width="100%" />

**让你的 AI Agent，带着人格和记忆使用抖音。**

一个本地命令行工具，连接 Agent、抖音页面和持续积累的上下文。

<img src="https://img.shields.io/badge/node-%E2%89%A522.19-339933?logo=node.js&logoColor=white" alt="Node.js 22.19+" />
<img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" />
<img src="https://img.shields.io/github/stars/9Ashwin/ShuaDouyin?style=social" alt="GitHub Stars" />

[快速开始](#快速开始) · [功能一览](#功能一览) · [Agent 接入](#给-agent-接入) · [开发与参与](#开发与参与)

</div>

## 这是什么

ShuaDouyin 的命令叫 `dy`。把它交给能执行 shell 的 AI Agent，就能搜索内容、浏览作品与评论、按授权互动、处理私信与分享、进入直播间，并保存有来源的记忆和关系记录。

**你定义名字、语气和边界，Agent 负责理解与判断，`dy` 提供操作和证据。** 项目不内建模型，也不运行定时任务；使用你已有的 Agent 和本机 Chrome。人设与记忆保存在本地，可以跨会话继续使用。

## 快速开始

准备好 **Node.js 22.19+、Chrome，以及一个能执行 shell 的 Agent**。

### 1. 安装工具与 skill

```bash
npm install -g shuadouyin
dy --version
dy skill install
```

npm 包叫 `shuadouyin`，可执行命令叫 `dy`。发布包已包含构建产物；使用本机 Chrome，不额外下载浏览器。`dy skill install` 会为已检测到的 Agent 安装技能，已有的非托管副本会保留。

### 2. 建立工作区并登录

```bash
dy init
dy auth login
```

在打开的专用 Chrome 窗口里扫码登录。工作区默认位于 `~/.dy`，浏览器登录保存在 `~/.dy/chrome`，后续继续使用。

### 3. 在你的 Agent 里开始聊

> 用 dy 带我完成设置，先问我名字、语气和边界。然后刷 5 条，挑 1 条读画面和评论，告诉我看到了什么。这轮只看，不互动。

也可以从具体任务开始：

- **带着问题找内容：**“搜一下 AI 编程，挑两条展开读，区分标题、画面和评论提供的信息。”
- **继续已有对话：**“看看我指定会话的新消息，结合之前的上下文拟一条回复。”
- **跟进关系：**“整理我已记录的人，看看今天有哪些到期的跟进事项。”
- **回顾一天：**“根据今天的本地记录和收据写个摘要，结果不明的操作单独说明。”

想自己操作终端界面，可以运行 `dy tui`；它需要真实终端，和 CLI 共用同一套操作与状态。

## 功能一览

![ShuaDouyin 六格漫画：设定人格、搜索与浏览、读作品与评论、互动与分享、直播与弹幕、记忆与关系](docs/assets/shuadouyin-workflow.png)

图中角色代表可配置的 Agent，名字、语气和边界由你定义。四个采样点和五条评论来自一次实际浏览，画面为重绘；其他场景是功能示意，不代表本次执行了发送或送礼。

| 能力 | 常用入口 |
| --- | --- |
| 搜索作品、找人、批量浏览推荐流 | `dy search` · `dy user search` · `dy feed sweep` |
| 读取作品、采样画面、查看评论与回复 | `dy video digest` · `dy comment list` · `dy comment replies` |
| 点赞、收藏、关注、发布文字或图片评论 | `dy video like` · `dy video favorite` · `dy user follow` · `dy comment post` · `dy comment image` |
| 读取私信、发送文字和图片、引用回复 | `dy chat read` · `dy chat send` · `dy chat image` · `dy chat reply` |
| 分享作品链接或原生卡片 | `dy chat share` · `dy chat forward` |
| 读取直播信息与弹幕、发言、按名称和价格送礼 | `dy live info` · `dy live chat` · `dy live say` · `dy live gift` |
| 读取人格、召回记忆、保存带来源的事实 | `dy persona show` · `dy context show` · `dy memory add` |
| 从实际表达中更新声音、积累经验、自查文风 | `dy persona evolve` · `dy learn keep` · `dy voice check` |
| 管理浏览轮次、目标、关系与跟进事项 | `dy browse start` · `dy social goal` · `dy social due` |
| 查询操作收据、准备和保存日报 | `dy receipt get` · `dy report prepare` · `dy report save` |

表中是命令入口，必填参数见 `dy <命令> --help`；完整命令与字段见 `dy schema`。

## 人格和记忆如何延续

默认工作区 `~/.dy` 将人格、人物资料、记忆和账号登录分开保存：

- **`AGENTS.md`** 定义这个 Agent 的身份、语气和边界，设定可以修改。
- **`PROFILES.md` 与 `memory/`** 保存人物资料和带来源的记忆。用户明确表达的事实、页面观察和推测分开记录；Markdown 是记忆正文的来源。
- **`growth review`、`learn keep` 与 `persona evolve`** 为回顾、经验和表达变化提供依据。是否值得保存由调用方判断，浏览不等于自动形成长期偏好。

更新或重新安装 CLI 会继续使用原工作区。需要重新开始时，使用下方的重置命令。

## 给 Agent 接入

[dy skill](skills/dy/SKILL.md) 负责教 Agent 如何使用工具，主题流程放在 [references](skills/dy/references/) 中。除了 `dy skill install`，也可以使用技能安装器：

```bash
npx skills add https://github.com/9Ashwin/ShuaDouyin --skill dy
```

每次任务先读人格和相关上下文，再读页面：

```bash
dy persona show
dy context show --query "这次要解决的问题"
dy feed sweep --count 5
```

从结果中选出作品 ID 后，先打开对应详情页，再采样：

```bash
dy video open <video-id>
dy video digest --video-id <video-id> --limit 5
```

`dy guide` 提供与当前安装版本一致的使用说明；`dy schema` 提供命令、参数和副作用类型。一次只运行一个工作区操作，避免账号锁冲突。

成功输出 `{ok:true,data}` 到 stdout；失败输出 `{ok:false,error}` 到 stderr，并返回非零退出码。写入使用唯一的 `--request-id`；`--dry-run` 只验证参数和计划，不连接 Chrome、不填表、不发送。完整契约见 [docs/contracts.md](docs/contracts.md)。

## 操作与证据边界

- **写之前先留收据。** 已确认的 request ID 重放时返回原收据；遇到 `delivery_uncertain` 先核对，不自动重发。原生卡片分享目前无法验证送达，发出后会保留不确定状态。
- **用稳定 ID 定位。** 作品、用户和会话以 CLI 返回的稳定 ID 为准；昵称只用于展示。
- **采样不等于完整观看。** 列表只包含已加载内容，通常标记 `complete: false`；直播画面不作为可读内容返回。判断由 Agent 根据实际证据作出。
- **对外动作需要授权。** 评论、私信、关注和直播发言作用于真实账号；礼物会花真钱，必须明确同意并核对名称和价格。删除或撤回受平台条件限制，不能保证收回已被看到的内容。
- **登录和数据留在本机。** 自动化可能触发验证、限流或账号处罚；验证需要真人完成，项目不提供绕过手段。`~/.dy` 含登录态、消息和记忆，不应提交或共享。详见 [SECURITY.md](SECURITY.md)。

## 安装方式与工作区管理

<details>
<summary><strong>其他安装方式、卸载与重置</strong></summary>

从 GitHub 源码安装，会执行构建：

```bash
npm install -g github:9Ashwin/ShuaDouyin
```

macOS / Linux 也可以使用独立目录安装器：

```bash
curl -fsSL https://raw.githubusercontent.com/9Ashwin/ShuaDouyin/main/scripts/install.sh | sh
```

检查 skill 副本与当前版本是否一致：

```bash
dy skill status
```

卸载 npm 全局安装的命令，保留 `~/.dy`：

```bash
npm uninstall -g shuadouyin
```

重置人格、记忆及活动状态，会先备份；Chrome 登录保留：

```bash
dy bot reset           # 只预览范围
dy bot reset --write   # 备份后重置，以返回的备份路径为准
dy init                # 重新建立工作区
```

</details>

## 开发与参与

需要 Node.js 22.19+、pnpm 和本机 Chrome。

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm check           # Biome + TypeScript
pnpm test            # 单元测试
pnpm test:browser    # 临时 Chrome profile + fixture 页面
```

浏览器测试不使用账号凭据，通过测试不等于通过真实抖音页面验证。项目仍处于早期阶段，页面变化可能影响操作；错误码、参数和返回字段按公开契约维护。

开发规则见 [AGENTS.md](AGENTS.md)，架构见 [docs/architecture.md](docs/architecture.md)，贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)。

## 许可

[MIT](LICENSE)
