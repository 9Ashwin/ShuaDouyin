# 安装与更新

只在需要的时候读这个文件。日常使用看 `SKILL.md`。

## 装 dy

```bash
npm install -g shuadouyin
```

包叫 `shuadouyin`，命令叫 `dy`。发布包里带的是构建好的 `dist/`，装上就能跑，不需要本地编译。

**唯一需要的是本机已有的 Chrome**，不下载浏览器。

装完：

```bash
dy init          # 建工作区
dy auth login    # 扫码登录抖音（有头 Chrome）
```

从源码装也行，会构建一次，几秒：

```bash
npm install -g github:9Ashwin/ShuaDouyin
```

源码安装需要 `esbuild` 的平台二进制，而它是通过 esbuild 自己的安装脚本下载的。如果 npm 被配置成跳过生命周期脚本（本仓库的 `.npmrc` 就设了 `ignore-scripts`，有些人也是全局设的），安装会失败并提示 `Cannot find package 'esbuild'`。加 `--ignore-scripts=false` 重装即可。

## 装 skill 到 agent 目录

这样别的 agent 也能读到：

```bash
npx skills add https://github.com/9Ashwin/ShuaDouyin --skill dy
```

或者用 CLI 自己装：

```bash
dy skill install
```

`dy skill status` 检查已装的副本和仓库是否一致。

## 更新

```bash
dy update --check
```

告诉你四件事：

- 这份是怎么装的（`checkout` / `npm-global` / `npm-local` / `managed-release`）
- 版本号
- 是哪个 commit 构建的
- 有没有更新的

**判断新旧用 `behind` 和 commit。** 版本号说明跨了几层功能，但一层里可能有几十个提交，所以只有 commit 能回答「我是不是最新的」。

按 `update` 字段给的命令更新。从 npm 装的：

```bash
npm install -g shuadouyin@latest
```

从源码装的：

```bash
npm install -g github:9Ashwin/ShuaDouyin@latest
```

**从源码装的话，不加 `@latest` 或 `--force` 会显示 up to date 而不更新**——npm 记录的是 commit，不是分支，它认为已经满足要求了。npm 包按版本号，没这个问题。

更新完 skill 也要重装一次，否则 agent 读到的是旧说明：

```bash
npx skills add https://github.com/9Ashwin/ShuaDouyin --skill dy
```

## 卸载

```bash
npm uninstall -g shuadouyin
```

卸载保留 `~/.dy` 里的 bot、记忆和账号登录状态。

要连状态一起清掉，手动删 `~/.dy`。删之前可以跑 `dy browser clean` 先回收缓存和截图——那部分通常占绝大部分空间，而登录和记忆都在别的文件里。

## 磁盘

`~/.dy` 会持续增长，但增长的几乎都不是 dy 自己的数据。实测一台用了几天的是 1.5G，其中 1.2G 是 Chrome 的 HTTP 缓存、104M 是截图，dy 的事件、记忆和人格一共 2.5M。

```bash
dy browser clean          # 看能回收多少
dy browser clean --apply  # 真的删
```

缓存和截图超过 512MB 时，Chrome 启动前会自动清一次。Cookie、登录数据、事件日志、收据、记忆、人格、快照永远不动。
