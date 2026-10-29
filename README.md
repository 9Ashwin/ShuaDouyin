<div align="right">
  <span>[<a href="./README.en.md">English</a>]</span>
  <span>[<b>简体中文</b>]</span>
</div>

<div align="center">

# 刷抖音 · ShuaDouyin

**让 agent 带着人格和记忆使用抖音。开源。**

浏览、评论、私信、直播、记忆——一个本地 CLI，判断权留给调用它的 agent。

<img src="https://img.shields.io/badge/node-%E2%89%A522.19-339933?logo=node.js&logoColor=white" alt="Node" />
<img src="https://img.shields.io/badge/license-MIT-blue" alt="License" />
<img src="https://img.shields.io/github/stars/9Ashwin/ShuaDouyin?style=social" alt="Stars" />

</div>

---

## 这是什么

`dy` 是一个本地命令行工具。它不内建模型、不调度、不做内容判断——它提供**一轮浏览所需的状态、上下文和操作原语**，判断由调用它的 agent 做。

它替你记住的：这个账号喜欢什么、跟谁聊过、哪句话有回应。它不替你决定的：该不该发、发什么、这个人值不值得认识。

## 安装

```bash
npm install -g github:9Ashwin/ShuaDouyin
```

`dy` 随即可用。安装时会从源码构建一次（几秒），**不下载浏览器**——用你本机已有的 Chrome。

这个包从 GitHub 分发，不在 npm registry 上。

<details>
<summary><strong>其他</strong></summary>

装到独立目录，不需要全局 npm：

```bash
curl -fsSL https://raw.githubusercontent.com/9Ashwin/ShuaDouyin/main/scripts/install.sh | sh
```

卸载：

```bash
npm uninstall -g github:9Ashwin/ShuaDouyin
```

卸载保留 `~/.dy` 里的 bot、记忆和账号登录状态。

</details>

装 skill 给 agent 用（可选）：

```bash
dy skill install
```

## 开始使用

```bash
dy init                      # 建工作区，开始引导
dy onboarding show           # 回答四个问题：名字、性格、关于你的事实、界限
dy auth login                # 打开 Chrome 扫码登录抖音
dy feed next                 # 刷下一条
dy video info                # 读当前作品
```

第一次登录会打开一个专用的 Chrome 窗口（profile 在 `~/.dy/chrome`），扫码后这个登录会一直保留。

想手动刷、手动点赞时用 `dy tui`——一个覆盖同样操作的终端界面。它和 CLI 走同一套实现，所以两边看到的状态一致。需要在真实终端里运行（不接受管道输入），也不能和 `--dry-run` 一起用。

## 它能做什么

| 做什么 | 命令 |
| --- | --- |
| 刷推荐流 | `dy feed open` / `dy feed next` / `dy video info` |
| 读作品与评论 | `dy video info` / `dy comment list` / `dy comment replies` |
| 互动 | `dy video like` / `dy video favorite` / `dy comment post` / `dy comment reply` |
| 私信 | `dy chat list` / `dy chat read` / `dy chat send` / `dy chat image` |
| 人 | `dy user get` / `dy user search` / `dy user followers` / `dy user follow` |
| 直播 | `dy live info` / `dy live chat` / `dy live say` / `dy live gift` |
| 搜索 | `dy search` / `dy user search` |
| 记忆与人格 | `dy memory add` / `dy memory search` / `dy context show` |
| 人格自己长 | `dy persona evolve` / `dy persona history` / `dy persona rollback` |
| 沉淀经验 | `dy learn keep` / `dy learn findings` |
| 文风自查 | `dy voice check --text "…"` |
| 浏览轮次 | `dy browse start` / `dy browse watch` / `dy browse end` |
| 社交关系 | `dy social goal` / `dy social list` / `dy social due` / `dy social log` |
| 让 agent 会用 | `dy guide` |

完整命令见 `dy schema`，或 `dy <命令> --help`。

## 给 agent 用

`dy` 是为 agent 设计的。把它交给任何能跑 shell 的 agent：

```bash
dy guide      # 返回完整的使用说明（约 3 万字），agent 读这个
```

或者把 `skills/dy` 装进你的 agent 技能目录。里面按主题分成八个参考文件：浏览与成长、记忆与人格、社交、直播、日报、自我改进、命令全表，以及**平台事实**——最后一个是踩过的坑，读它能省掉一次重来。

## 设计原则

- **不做判断。** `dy` 不内建模型。它返回事实和候选，判断留给调用方。它对着一个真实账号操作，所以代码的职责是让每个动作可审计、可回滚，而不是替你决定这个动作该不该做。
- **写之前先落收据。** 每条写入在可能发出之前就已落盘，重放同一个 request ID 返回原收据。`delivery_uncertain` 永远不自动重试——那条可能已经发出去了，再发就是两条。
- **身份用稳定 ID。** 昵称会重名会改，`sec_uid` 不会。
- **读到什么说什么。** 直播画面是 canvas，读不到就不报内容；评论是抽样，标 `complete: false`。
- **记忆跟账号走。** 换一个安装就是新的 bot，不继承别人的判断。

## 重置

```bash
dy bot reset           # 看会清掉什么（不改动）
dy bot reset --write   # 备份到 ~/.dy-backup-<时间> 后清空
dy init                # 建新的 bot
```

Chrome 登录会保留，不用重新扫码。

## 开发

需要 Node.js 22.19+、pnpm 和本机 Chrome。

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm test            # 单元测试
pnpm test:browser    # 隔离 Chrome 的浏览器测试
pnpm check           # Biome + tsc
```

输出契约、收据状态和存储语义见 [docs/contracts.md](docs/contracts.md)。源码结构、模块归属和检查流程见 [AGENTS.md](AGENTS.md)。

## 风险与边界

这是一个操作真实抖音账号的工具。用它意味着接受下面几件事：

- **账号风险由你承担。** 自动化使用抖音可能触发平台的人机验证、限流或处罚。项目不提供任何绕过手段，也不会帮你规避风控。验证弹出来时，需要真人在有头的 Chrome 里完成。
- **发出去的东西撤不回来。** 评论、私信、弹幕、礼物都是对外且不可逆的。送礼花的是真钱。发之前先确认对象和内容，`--dry-run` 可以先看计划。
- **本地状态含敏感信息。** `~/.dy` 里有登录态、读过的消息和长期记忆。不要提交、不要截图、不要放进共享目录。详见 [SECURITY.md](SECURITY.md)。
- **读到的不是全部。** 列表是抽样并标 `complete: false`，直播画面是 canvas 读不到字。基于抽样下结论是你自己的判断，不是工具的结论。
- **它不做判断。** 该不该发、发给谁、这个人值不值得认识，命令不会替你决定，也不会因为调用方是 agent 就降低门槛。

## 状态

早期阶段。命令、错误码和返回字段是公开契约，会尽量保持稳定；数据库结构随版本迁移。CI 在 Ubuntu、macOS 和 Windows 上跑单元测试与隔离 Chrome 测试。

## 参与

见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题走私密报告渠道，见 [SECURITY.md](SECURITY.md)。

## 许可

MIT
