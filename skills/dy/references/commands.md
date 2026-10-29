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
dy video digest [--frames 3 --limit 8]    # 标题 + 三帧 + 评论，判断这条在讲什么
dy video seek --at 120                    # 跳到第 120 秒
dy video observe --at 200 --seconds 4 --frames 2   # 在指定位置采样
dy video play [--video-id <id>]           # 播放
dy video pause [--video-id <id>]          # 暂停
dy video screenshot --output x.png
dy video audio --seconds 10 --output a.webm
```

**`video digest` 是判断内容的第一选择。** 一条命令、3–4 秒，返回标题、三个位置的画面（25%/50%/75%，避开开头封面语和结尾求关注）和评论区摘录。长视频只看开头等于没看。

`--frames 0` 跳过所有采样只读评论（最快）；短片自动不采样并说明原因。

`video.seek` 越界会**拒绝**而不是截断——传了超出时长的位置说明你猜错了时长，需要知道。

`video observe` 是采样，返回 `complete: false` 和实际采到的帧。它不做内容识别——看清实况要连续多次采样并对比。`--at` 可以指定起点，不用总从开头看。

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
dy comment voice [--limit 20 --save]             # 学这个区怎么写
dy comment voice --known                         # 看已经学过的区
dy comment phrases                               # 哪些句式还能用
dy comment phrases --use "下次一起唱"             # 记一次使用
dy comment close                                 # 关掉评论面板
```

发表评论必须带 `--request-id`（全局参数）。`comment list` 的每条都带 `stance`：`about_work` / `about_self` / `asking` / `spam` / `unknown`。回之前看它，对着「在说自己」的评论夸「唱得好」是错位的。

`comment list` 自己开的面板会自己关，所以读完能直接 `feed next`。如果面板是你手动开的、或者关不掉，用 `dy comment close`。**面板挡着翻页箭头时 `feed next` 会报「The feed did not move」**，不是页面坏了。

### 学这个区怎么写

```bash
dy comment voice --limit 20
```

返回这一条作品的评论区画像：中位长度、连续感叹号比例、反复出现的称呼、直呼作者的比例、第一人称比例、提问比例，每条都带计数。另有 `guidance` 把这些数字翻成人话。

**按作品算，不按全局算。** 实测两条视频，一条中位 11 字，另一条中位 46 字、p90 102 字——差四倍。用一套全局风格套所有区，两头都不像。

典型输出（长句区）：

> Comments here run long: median 46 characters. A one-line reply reads as a tourist.
> 40% use repeated exclamation marks. One is punctuation; two or three is how people here sound.
> 50% address the author directly. Writing about the work without addressing anyone is the minority style.

**写之前先跑一次。** 对着中位数写，比凭感觉写更接近本地口吻。但注意：模仿风格不等于评论有价值——那是两件事。

### 标点要像人

真人在评论区不写冒号和破折号。这两个符号一看就是写好的稿子。

| 别用 | 换成 |
| --- | --- |
| `我倒觉得那句才是重点——不是因为看到希望才坚持` | `我倒觉得那句才是重点 不是因为看到希望才坚持` |
| `有一个问题：他为什么这么写` | `有个问题 他为什么这么写` |

**空格就是停顿。** 短句之间空一格，比任何标点都自然。

其余习惯：

- 逗号可以有，但不密集。一句话里两三个就够。
- 句号经常省略。评论区里句子是连着说的。
- 问号、感叹号可以有，但别连用三个以上（除非那个区就这样，`comment voice` 会告诉你）。
- 不写书名号以外的引号做强调，那是文章的做法。

**判断标准很简单：把它念出声。** 念起来像在写报告的，就不是人话。

### 什么样的评论算有梗

`comment voice` 还会量每条评论的赞数和「作者赞过」，并按三个可判的维度给结论：

| 维度 | 是什么 | 例子 |
| --- | --- | --- |
| `echoes` | 接住主播或上一条的话头 | 「下次一起唱」「欧克」 |
| `specific` | 说出只有看过才说得出的话 | 「有点像王朝1982的《我本将心向明月》」 |
| `turns` | 反转、自嘲 | 「我就晚来几分钟」「不配」 |
| `generic_praise` | 堆砌术语，换个作品也成立 | 「唱腔开阔大气，强弱层次把控精妙…」 |

`verdict` 三档：`has-wit` / `flat` / `generic-praise`。

**实测一条区的数据：**

| 赞 | 内容 |
| --- | --- |
| 247 ★作者赞过 | 「下次一起唱」（4 字） |
| 120 | 「欧克」（2 字） |
| 63 | 「有点像王朝1982的《我本将心向明月》」 |
| **2** | 150 字堆术语的那条 |

长度和赞数的相关系数是 **-0.38**——这个区里越长越没人理。**别用长度冒充内容深度。**

### 让它越刷越懂

```bash
dy comment voice --save     # 量完存下来
dy comment voice --known    # 看已经学过的区
```

`--save` 把这次测量存成一条 `insight` 记忆（标签 `voice-profile`），`--known` 按**形状**把它们归并：

```
paragraph        x3  | median 40-52 | addresses the author, speaks in the first person
short-sentence   x7  | median 18-25 | asks questions
one-liner        x2  | median 6-11  |
```

形状由长度分位数决定（`p90 ≤ 25` 是一句话，`median ≤ 25` 是短句，其余是段落），不是拍脑袋的标签。

**为什么存而不是每次重算：**一条一条列出来没人看，累积下来有用的是「这条区的样子和我见过的那类像不像」。下次遇到相似的区，`--known` 告诉你之前那类区怎么写才像本地人。

存的是数字和结论，不是原文——记忆里没有别人的评论内容。

### 别变成复读机

```bash
dy comment phrases                       # 哪些句式还能用
dy comment phrases --use "下次一起唱"     # 记一次使用
```

学到的句式存进账本时带一个**使用次数**。用 3 次的句式自动标成 `spent`，不再推荐；静默 14 天后才回到 `usable`。

```
可用: 1 | 用完: 1
  usable: fresh 0次 "欧克"
  spent : 3次 "下次一起唱" | 还需静默 14 天
```

**为什么统计使用次数而不是只存句式：** 第一次让「下次一起唱」拿到 247 赞，第二次还行，第五次就是模板。人不会每次都用同一个笑点。

**`spent` 是报出来而不是藏起来。** 藏起来的话，重启之后同一条又会冒出来。

账本还查一件事：**最近写的评论是不是在趋同**。

```
sameness: varied | narrowing | template
```

判据是最近 20 条的首四字重复、开头重复、以及长度离散度——不同句式也可能凑出一条公式。`template` 的意思是该换角度了，不是换个词。

**候选句式的筛选：**赞数 ≥ 3、长度 ≤ 30 字、且必须有接话/反转/具体指认之一。指名道姓的（带《》、人名、账号）一律不收——它在这条视频下成立，下一条就是废话。

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
dy memory decision-status --request-id <id>   # 中断后查决策收据
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
dy persona evolve                    # 人格按自己写过的东西长一节
dy persona evolve --dry-run          # 只看会长成什么样
dy persona migrate                   # 老工作区的人格补上生长一节
dy persona snapshot                  # 手动存一版
dy persona history                   # 有哪几版
dy persona rollback <version>        # 回到某一版
```

## 人格自己长

`persona evolve` 读这个账号真正发出去的评论，量长度、标点、表情、问句、称呼、惯用开头，写进 `AGENTS.md` 的「长出来的声音」一节。每一条都带你自己的数字，比如「一两句就收（自己发的评论中位数 9 字，23 条样本）」。

那一节之外的文件内容工具不会碰。样本不到 5 条会拒绝，因为一条评论是事件不是习惯。同样的话就不重写，免得文件一直抖。

刷完一轮、评论过之后跑一次。人格该跟着经历走。

老版本创建的人格里有句「保留用户已固定的设定，不因一次任务改写人格」，和上面这套直接矛盾。`persona migrate` 把那一句换成生长一节，位置就在原来那句的位置，文件其余部分不动。如果那句你自己改过写过别的话，工具不会动它。

`evolve` 改之前会自己存一版，返回里的 `snapshot` 就是版本号。版本号只增不复用，`rollback 3` 永远指同一份。回滚本身也先存一版，所以回滚错了还能回滚回去。

## 学到的东西

```bash
dy learn keep                        # 从这轮活动里提炼该记住的
dy learn keep --note "…"             # 加上你自己得出结论的那一条
dy learn keep --dry-run              # 只看会记什么
dy learn findings                    # 已经记了哪些
```

能自动提炼的只有能量化的那几类：同一个命令反复失败（两次以上才算）、评论本身带了梗、一轮里划走的比看的多。这些是证据，不是判断。

判断要你自己写进 `--note`，工具原样记录并标记 `caller:note`，和它自己量出来的分得开。

写进 `lessons.md`，每条带来源。重复的不会再加。这个文件跟普通工作区文档一样能读能改——不同意的那条删掉就行，工具不会加回来。它不是 skill：skill 随版本更新会被替换，bot 自己的经验不能被更新冲掉。

## 文本像不像机器写的

```bash
dy voice check --text "…"
```

指出具体是哪个短语、为什么像，还会指出改过头的痕迹。改过头是另一种假：把所有 AI 味擦干净，句子被削成一样长，逗号串承担一切。

清单改编自 PenguinHarness 的中文 humanizer（Apache-2.0），那套是七轮盲评改出来的。这里是可执行的检查，不是建议。

它只指出，不改写。通过的时候它会告诉你别改了——为了让分数好看再改一遍，本身就是 AI 味。

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
dy update                # 怎么装的、是哪一版、要不要更新
dy update --check        # 问 GitHub 有没有更新的提交
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
