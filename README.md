# dsh-plugin

DeepSeek Harness（dsh）的插件集合：一组 host / client 侧的 web 优化插件、一个按会话的
烧录设备授权插件（附沙箱补丁脚本）、一个用于救活坏插件的 recovery bundle，以及若干
git 子模块（集成终端、移动端 PWA、ThreadTrail 操作日志）。

## 目录总览

| 路径 | 类型 | 作用 |
|---|---|---|
| [`chunk-trim/`](chunk-trim/README.md) | host web 插件 | 剪掉历史页里的 `assistant/chunk` token-delta 洪峰 |
| [`msg-collapse/`](msg-collapse/README.md) | client web 插件 | 折叠会话视图里的超长用户消息 |
| [`page-lazy/`](page-lazy/README.md) | client web 插件 | 会话窗口自适应分页 + 空闲预取 |
| [`flash-device-auth/`](flash-device-auth/README.md) | host 插件 | 按会话授权烧录设备（`/flashdev`） |
| [`folder-auth/`](folder-auth/README.md) | host 插件（独立仓库） | 按会话授权任意目录（`/fsauth`） |
| [`recovery/`](recovery/README.md) | host bundle | `dsh --profile recovery` 极简救活会话 |
| [`scripts/`](scripts/patch-probe-roots.mjs) | 工具 | 沙箱补丁（flash-device-auth 的依赖） |
| [`ThreadTrail/`](ThreadTrail/README.md) | 子模块 | 提交间操作日志 / 代码↔会话回放 / rewind |
| [`dsh-terminal/`](dsh-terminal/README.md) | 子模块 | VSCode 风格集成终端面板 |
| [`dsh-mobile/`](dsh-mobile/README.md) | 子模块 | 移动端 PWA 适配（`@dsh-external/dsh-mobile`） |

## 插件

### chunk-trim（host）

打开会话时 `session.history {maxMessages: 50}` 会返回整段原始事件窗口，其中 ~94% 是
token 粒度的流式 `assistant/chunk`（`reasoning-delta` / `text-delta` /
`tool-call-delta`），单页可达 1.5–4.1 万事件 / 3.5–7.8 MB。本插件包装
`ctx.apiProxy.sessions.history` 与 `subagents.history`，去掉这些 delta 事件（保留页首
/页尾边界与稀疏的非 delta chunk），单页降到几百事件。轨迹面板对**未完成步骤**会失去
逐 token 细节，实时流式不受影响。

### msg-collapse（client）

通过 `conversation.chat.node` 槽（`priority: -100`）包装内置用户气泡：不复制气泡本身，
只对超过 500 字符的消息加一个 `max-height: 12em` 折叠层 + 「展开全文 / Expand」按钮。
点击展开/收起；点击链接、按钮、图片等交互目标时透传，不误触折叠。

### page-lazy（client）

在 chunk-trim 之上设计会话窗口的**分页大小**与**懒加载时机**：首次打开只拉 30 条消息
（快速首屏），后续页面 50 条；打开后在空闲时（`requestIdleCallback`）预取一页，且
自限只在 `events.length < 30 + 50` 时触发一次，不级联。手动「load earlier」按钮保留。

### flash-device-auth（host）

按会话授权烧录设备（调试探头 / USB 串口 / 任意设备节点），让 probe-rs、cargo-flash、
esptool 等在 `workspace-write` 沙箱下免审批直接烧录。用 `/flashdev` 命令管理：
`list` / `scan` / `add <vid:pid[:serial]|/dev/...>` / `remove` / `clear`，授权按会话生效、
子会话继承、可撤销。

> 依赖沙箱补丁：先 `node scripts/patch-probe-roots.mjs`（幂等，可 `--revert` 回退），
> 再重启 `dsh web`。

### folder-auth（host）

按会话授权任意目录，让 agent 在 `workspace-write` 沙箱下写工作空间之外的指定文件夹免审批。
用 `/fsauth` 命令管理：`add <绝对路径>` / `remove` / `list` / `clear`，授权按会话生效、
子会话继承、可撤销。与 flash-device-auth 共用同一沙箱补丁（`extraWritableRoots` 对目录
同样经 `--dev-bind` 生效，零补丁改动）。

> ⚠️ 安全模型：`/fsauth add` 只校验「绝对路径且非空」，**不拦截任何敏感路径**——授权是
> 人做的决定，详见 [`folder-auth/README.md`](folder-auth/README.md)。

### recovery（bundle）

一个只挂 `dsh-base` 的一次性救活会话：当某个插件把 `dsh web` 搞到起不来时，
`dsh --profile recovery` 在最小树上起一个新 agent，复现启动错误、定位坏插件、只改
workspace 下的源码、`node --check` + 再启动验证。无 Host / HTTP / Web / 浏览器层挂载，
坏插件影响不到它。

## 子模块

`ThreadTrail/`、`dsh-terminal/`、`dsh-mobile/`、`dsh-rerun/` 是各自独立的 git 仓库（见
[`.gitmodules`](.gitmodules)）。首次克隆本仓库后需 `git submodule update --init`。
升级某个子模块时，在其目录内提交并推送，再回到本仓库 `git add <path>` 记录新指针。

> `folder-auth/` 也是一个独立 git 仓库，**当前只在本地建仓（暂无远程、尚未注册为
> submodule）**。远程就绪后 `git submodule add <url> folder-auth` 注册即可。

## 构建（重要）

以下插件**只跟踪 `src/`**，`lib/` 是 gitignore 的构建产物——clone / pull 之后
`lib/` 要么缺失、要么过期。**过期/占位的 lib 会静默失效**：dsh-mobile 曾带一个
5 行的占位 `apply() {}`，manifest / 图标路由全部 404、PWA 图标退回模糊的 50px
SVG favicon，全程无任何报错。因此每次更新代码后必须重建：

```bash
node scripts/build-plugins.mjs   # 统一驱动：逐个执行各插件自己声明的 build 脚本
```

构建命令**以各插件 `package.json` 里的 `build` 脚本为准**（插件自己负责构建），
统一脚本只是按下面清单逐个调用，不硬编码任何构建细节：

| 插件 | build 脚本（插件自声明） | 产物 |
|---|---|---|
| `caddy-https/` | `node build.mjs` | `lib/index.js`, `lib/client.js` |
| `dsh-terminal/` | `node build.mjs` | `lib/index.js`, `lib/client.js` |
| `dsh-mobile/` | `tsdown`（`pnpm build`） | `lib/index.js`, `lib/client.js`, `lib/index.d.ts` |
| `dsh-rerun/` | `node build.mjs` | `lib/index.js`, `lib/client.js` |
| `folder-auth/` | `node build.mjs` | `lib/index.js` |

> 无 build 脚本、`lib/` 直接提交的插件（`chunk-trim` / `msg-collapse` /
> `page-lazy` / `flash-device-auth`）不需要构建。

## 安装

每个插件的 README 都写了自己的安装方式，通用模式是 `$DSH_HOME/plugins` 约定
（profile 配置里不放绝对路径，symlink 是唯一的机器专属步骤）：

```bash
PLUGIN_SRC=/path/to/dsh-plugin
mkdir -p "$HOME/.dsh/plugins/@dsh-external"
ln -s "$PLUGIN_SRC/chunk-trim" "$HOME/.dsh/plugins/chunk-trim"
# 其它插件同理……
```

然后在 `~/.dsh/profiles/web/package.json` 里以 `link:../../plugins/<name>` 加入依赖，
在 `cordis.patch.yml` 里 `insert` 对应 id，`pnpm install` 后**重启 `dsh web`**。

- **web 优化插件**（chunk-trim / msg-collapse / page-lazy）走上面的标准流程。
- **flash-device-auth** 需先打沙箱补丁（见上文），再照常挂进 profile。
- **recovery** 用 `dsh plugin --profile recovery add link:<src>/recovery` 安装，然后
  `dsh --profile recovery` 使用。
- **dsh-mobile** 声明了 `dsh.bundle.patch`，装进 profile 后会自动加入 `dsh.profile.bundles`。
