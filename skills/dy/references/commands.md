# 命令地图

`dy schema` 是唯一的权威清单（含全部参数、默认值和副作用）。这个文件解决的是另一个问题：**想做一件事，该用哪个命令**。106 个命令按意图分组，每条只写最容易用错的地方。

`effect` 分三类，决定了风险：

- **read** — 只读页面或本地状态。
- **navigation** — 会动页面（切视频、开面板、滚动），不改变账号数据。
- **account_write** — 会改变账号状态或对外发出内容，需要 request ID 和收据。

## 起步与检查

| 处境 | 命令 |
| --- | --- |
| 第一次用 | `dy init` |
| 看引导问什么 | `dy onboarding show`、`dy onboarding complete`、`dy onboarding skip` |
| 看工作区在哪 | `dy bot show` |
| 工作区文件丢了 | `dy bot init`（只补缺失的，不覆盖改动） |
| 从零重来 | `dy bot reset`（先备份）/ `--write` 执行 |
| 确认装对了 | `dy --version`、`dy skill status` |
| 创作者上传页 | `dy creator status` |

## 登录与浏览器

抖音必须先在有界面的 Chrome 里扫码。`dy` 用一个专用 profile（`~/.dy/chrome`），登录一次长期保留。

```bash
dy auth login      # 打开有头 Chrome，等扫码
dy auth status     # 读观察到的登录态和验证状态
dy browser start   # 之后复用这个 profile
dy browser status
dy browser stop
dy browser config
dy browser configure [--executable --display]
```

`browser.configure` 保存 Chrome 路径和默认显示模式，给没装标准路径的机器用。

**遇到人机验证（滑块）时 `auth login` 是有头窗口，需要真人完成。不要尝试绕过。**

浏览器命令只读页面；需要滚到评论区底部或展开回复时用：

```bash
dy page scroll --target comments --pixels 800
dy page scroll --pixels 1200
```

## 导航与读作品

| 想做什么 | 命令 |
| --- | --- |
| 刷推荐流 | `dy feed open` / `dy feed next` / `dy feed previous` |
| 打开一条指定作品 | `dy video open <id-or-url>` |
| 分享文本或链接转 ID | `dy link resolve <text>` |
| 读当前作品 | `dy video info` |
| 搜索 | `dy search <词>`、`dy user search <词>` |
| 当前标签页是什么 | `dy status` |

`feed.next` 会核实作品 ID 变了才算成功。读到「当前是直播」不代表命令坏了——见 `platform-facts.md` 的滑片过渡说明。

**一次读一批用 `feed sweep`：**

```bash
dy feed sweep --count 10            # 走 10 条，返回 id、作者 ID、标题、时长
```

只读：它翻页并读作品身份，不点赞、不评论、不关注。落在直播或读不到的滑片会计入 `skipped` 而不是悄悄丢掉，所以 `works.length` 小于 `count` 时要知道平台就是没给那么多。

`stopped` 说明为什么停下：

- `count_reached` — 拿够了
- `steps_exhausted` — 翻到步数上限还没拿够
- `feed_stuck` — 翻不动了，`error` 里有原因

**耗时预期：**推荐流每次翻页约 1.2 秒（页面本身要过渡），10 条约 12 秒。它不会比逐个 `feed next` 快多少——瓶颈是页面等待，不是命令启动。真正的收益是一次拿到完整数据，不用再逐条 `video info`。

**图文作品和视频作品是两套。** `video info` 会告诉你当前是哪一种。图文（笔记）用：

```bash
dy note next [--video-id <id>]        # 下一张
dy note previous [--video-id <id>]    # 上一张
dy note capture --index 0 --output x.png
```

图片和视频的点赞、收藏是同一套命令。

## 播放与取样

```bash
dy video play [--video-id <id>]  # 播放
dy video pause [--video-id <id>] # 暂停
dy video screenshot --output x.png
dy video observe --seconds 8 --frames 6   # 采样帧 + 播放状态
dy video audio --seconds 10 --output a.webm
```

`video.observe` 是采样，返回 `complete: false` 和实际采到的帧。它不做内容识别——看清实况要连续多次采样并对比。

## 互动

```bash
dy video like --value true|false
dy video favorite --value true|false
dy user follow --value true|false
```

这三个都是**设置目标状态**，不是切换。命令会核实新状态真的被观察到才报成功。传 `--value false` 取消。

`user.follow` 作用于当前打开的用户主页，所以先 `dy user get <id-or-url>`。

## 评论

```bash
dy comment list [--limit --scrolls]              # 读，带 stance
dy comment replies --comment-id <id>             # 展开某条评论的回复
dy comment post --text "…"                       # 发顶层评论
dy comment reply --comment-id <id> --text "…"    # 回复某条评论
dy comment image --image <路径>                  # 发图片评论
```

发表评论必须带 `--request-id`（全局参数）。`comment list` 的每条都带 `stance`：`about_work` / `about_self` / `asking` / `spam` / `unknown`。回之前看它，对着「在说自己」的评论夸「唱得好」是错位的。

## 私信

```bash
dy chat list                                     # 打开私信面板并列出会话
dy chat read --conversation-id <id>              # 读一个会话
dy chat send --conversation-id <id> --text "…"
dy chat reply --conversation-id <id> --message-index <n> --text "…"
dy chat image --conversation-id <id> --image <路径>
dy chat voice --conversation-id <id>             # 让页面转写语音
dy chat capture --message-id <id> --index 0      # 存消息里的图
dy chat history --conversation-id <id>           # 本地存过的历史
dy chat changes --conversation-id <id>           # 最近两次读到的差异
dy chat share --conversation-id <id> --video-id <id>   # 发文字链接
dy chat forward --recipient-id <id> --video-id <id>    # 发原生作品卡
dy forward list                                  # 当前作品分享面板能给谁
dy chat close                                    # 关面板（有草稿会拒绝）
```

`chat.share` 和 `chat.forward` 不是一回事：前者是一条带链接的消息，后者是平台的原生卡片。

## 人

```bash
dy user get <id-or-url>              # 主页元信息和作品链接
dy user followers [--user-id --limit --scrolls]   # 粉丝列表
dy user following [--user-id --limit --scrolls]   # 关注列表
dy user search <词>                  # 搜人，返回稳定 ID
```

## 直播

```bash
dy live info              # 主播、开播状态、能否评论
dy live chat [--limit]    # 读当前加载的弹幕
dy live say --text "…" --request-id <id>
dy live gifts             # 面板里已加载的礼物和价格
dy live gift --name 人气票 --price 1 --request-id <id>
```

细节见 `live.md`。礼物会花真钱，`--name` 和 `--price` 必须同时匹配。

## 浏览轮次

把一次浏览收成一束证据，而不是散落的命令。

```bash
dy browse start --budget 5 --minutes 15 --goal <目标>
dy browse watch --video-id <id>
dy browse skip --video-id <id> --reason "不相关"
dy browse end <round-id> --reason "看完"
dy browse round <round-id>
dy context browsing          # 之前看过、做过什么，避免重复
```

## 记忆

```bash
dy memory add --text "…" --source "user:…" --layer … --certainty …
dy memory search <词>
dy memory list [--layer --subject --profile-ref]
dy memory get <id>
dy memory update <id> --if-match <revision> …
dy memory delete <id> --if-match <revision>
dy memory history <id>
dy memory graph
dy memory status
dy memory usage
dy memory reindex            # 重建索引（Markdown 是唯一真源）
dy memory ingest             # 手工改过文件后同步
dy memory compact            # 合并正文完全相同、多余的重复条目
dy memory candidates / decide / decision-status
```

写记忆的取舍见 `memory-and-persona.md`。

## 人格与人物档案

```bash
dy workspace get AGENTS.md   # 或 PROFILES.md
dy workspace set AGENTS.md --text-file <文件> --if-match <revision>
dy workspace history AGENTS.md
dy workspace restore AGENTS.md --revision <revision>
dy context show --query "…" [--profile-ref user:<id>]
```

## 社交关系（获客方向）

```bash
dy social goal --text "…" --stages "…" --daily-limit 5
dy social signal [--sources …]        # 从已读文本里找明确的需求表达
dy social discover [--goal <id>]      # 变成候选，附理由
dy social stage <person> --stage …
dy social relation <person> / list
dy social followup <person> --topic … --due <日期>
dy social outcome <person> --outcome … --goal <id>
dy social outcomes                    # 每个目标：触达、推进、结束
dy social due                         # 今天该联系谁，为什么
dy social log
dy social pause --reason "…"
dy social resume
dy social forget <person> --reason "…"
dy social done <person>
dy social goalpause <goal-id>
```

目标定义自己的阶段词表，见 `social.md`。

## 成长事件

每轮浏览会留下事件。事件不是结论，它只是「发生过这件事」的素材。

```bash
dy growth review [--since --limit]   # 按顺序列出待处理的活动
dy growth event --event-id <id>      # 读某一条的来源
dy growth ack --event-id <id>        # 处理完再确认
```

`growth ack` 要在产物（记忆、人格修改、日报）都保存之后才调用。中断或失败时不要确认，下次还能接着处理。确认了就当作已经处理过。

## 报告与历史

```bash
dy report prepare <date> [--timezone …]     # 素材
dy report save <date> --text-file <文件>     # 保存 agent 写的日报
dy report get <date>
dy report list
dy history list          # 本地操作事实
dy share history         # 分享尝试和送达状态
dy receipt get <request-id>
```

## 诊断与自我修复

```bash
dy diagnostics           # 反复失败的命令、变慢的命令
dy diagnostics-ack <command> [--error-code …]
dy page facts            # 页面真实标记 vs 代码认识的标记
dy source                # 真正在跑这份 dy 的源码目录
```

先读 `self-improvement.md`。

## 看写操作进行到哪了

发评论、发私信这些写入要几秒。默认它们安静到最后才返回一条结果，调用方分不清「在发」和「卡住」。加 `--progress` 让每一步走到 stderr：

```bash
dy --progress --request-id <id> chat send --conversation-id <id> --text "…"
```

stderr 每行一条：

```json
{"progress":{"step":"connecting","at":"…","elapsed_ms":0}}
{"progress":{"step":"selecting_conversation","elapsed_ms":108}}
{"progress":{"step":"dispatching","elapsed_ms":200,"detail":{"request_id":"…"}}}
{"progress":{"step":"confirming","elapsed_ms":268}}
{"progress":{"step":"confirmed","elapsed_ms":1187}}
```

**`dispatching` 是分水岭。** 它之前失败，什么都没发出去（收据写 `not_sent`）；它之后就是不可逆的，之后的任何失败都是 `delivery_uncertain`，**不能重发**。

stdout 仍然只有一个 `{ok:...}` 信封——进度不会混进去。`--dry-run` 不产生进度行，因为它不碰页面。

**典型耗时：**私信约 1–2 秒（其中确认占大头），评论约 2–4 秒（多一步打开评论区）。时间基本花在等页面确认上，压不掉——那正是「确认发出去了」的证据。

## 让 agent 学会用

```bash
dy guide                 # 这份文档的完整内容（含所有参考文件）
dy skill status          # 已安装的 skill 副本有没有落后
dy skill install [--force]
```
