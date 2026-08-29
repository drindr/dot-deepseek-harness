# 本机配置指南（不进 git 的部分）

本仓库只跟踪**插件源码与补丁脚本**。以下配置因包含机器专属值（主机名、绝对路径、
API Key 环境变量、探头序列号）而**留在 `~/.dsh` 本地，不提交进 git**。本文件提供每
一项的配置方法与模板；把 `<...>` 占位符换成你自己的值即可。

> 通用原则：profile 配置里不放绝对路径（README 的 symlink 约定例外处理插件安装），
> 秘密值一律用环境变量引用（`apiKeyEnv`），主机名/端口按自己的网络改。

## 1. 沙箱补丁（flash-device-auth 的前置）

升级 dsh 后必须重打，幂等、可回退、自检：

```bash
node scripts/patch-probe-roots.mjs           # 应用（自动定位 npx 缓存树 + ~/.dsh/profiles 树）
node scripts/patch-probe-roots.mjs --revert  # 回退到上游原版
# 之后重启 dsh web
```

补丁清单（为什么不能做成纯插件，见末节）：

| # | 目标包 | 内容 |
|---|---|---|
| 1 | `dsh-sandbox` | `writableRoots()` 合并 `policy.extraWritableRoots`（seatbelt + fs fence） |
| 2 | `dsh-sandbox-local` | bwrap 参数：`--dev-bind` 挂入授权设备节点 |
| 3 | `dsh-sandbox-local` | Landlock：授权节点加入 readWrite |
| 4 | `dsh-session` | `KNOWN_SESSION_EVENT_TYPES` 注册 `sandbox/device-root`（两个副本文件） |
| 5 | `dsh-tool-bash-persistent` | 授权变化时重生持久 shell，下次 bash 用新沙箱参数 |

## 2. `~/.dsh/settings.yaml` — 模型与 UI 偏好

```yaml
llm-pi-ai:
  providers:
    <provider-name>:            # 如 kimi-coding
      apiKeyEnv: <ENV_VAR>      # 只写环境变量名，Key 本身放 shell 环境
agent-default-model:
  provider: <provider-name>
  model: <model-id>             # 如 k3-256k
agent-presets:
  default: minimal
ui-theme:
  preference: system            # system | light | dark
ui-conversation:
  busyEnter: steer
```

### provider-proxy 配置（可选）

```yaml
provider-proxy:
  providers:
    openai:
      enabled: true
      proxyUrl: http://127.0.0.1:7890
      hosts:
        - api.openai.com
```

也可以通过 dsh 设置的 **Provider Proxy** 页面编辑。

## 3. `~/.dsh/profiles/web/package.json` — 插件装载

用 `link:` 指向本仓库各插件目录（绝对路径是唯一的机器专属部分）：

```jsonc
{
  "name": "dsh-profile-web",
  "private": true,
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "@dsh-external/dsh-mobile"        // 声明了 dsh.bundle.patch，装入即生效
  ] } },
  "dependencies": {
    "chunk-trim":         "link:<REPO>/chunk-trim",
    "msg-collapse":       "link:<REPO>/msg-collapse",
    "page-lazy":          "link:<REPO>/page-lazy",
    "flash-device-auth":  "link:<REPO>/flash-device-auth",
    "provider-proxy":    "link:<REPO>/provider-proxy",
    "dsh-terminal":       "link:<REPO>/dsh-terminal",
    "dsh-mobile":         "link:<REPO>/dsh-mobile",
    "tailscale-patch":    "link:<REPO>/tailscale-patch",
    "caddy-https":        "link:<REPO>/caddy-https",
    "threadtrail-client": "file:<REPO>/ThreadTrail/threadtrail-client",
    "threadtrail-server": "file:<REPO>/ThreadTrail/threadtrail-server"
  }
}
```

改完后在 profile 目录 `pnpm install` 并重启 `dsh web`。

## 4. `~/.dsh/profiles/web/cordis.patch.yml` — 插件启用与参数

骨架（每个插件一段 `insert`；**config 段按需填写**）：

```yaml
# ThreadTrail（server 捕获 + client 面板）
- insert:
    - id: threadtrail-server
      name: threadtrail-server
    - id: threadtrail-client
      name: threadtrail-client

# dsh-terminal
- insert:
    - id: terminal
      name: dsh-terminal

# web 优化三件套（无配置）
- insert:
    - id: chunk-trim
      name: chunk-trim
- insert:
    - id: page-lazy
      name: page-lazy
- insert:
    - id: msg-collapse
      name: msg-collapse

# flash-device-auth：catalog 是「已知探头」清单（label 快捷名），不是授权；
# 授权永远按会话走 /flashdev add。序列号等硬件信息不必提交。
- insert:
    - id: flash-device-auth
      name: flash-device-auth
      # config:
      #   catalog:
      #     - { label: <my-probe>, vid: "<vid>", pid: "<pid>", serial: "<serial>" }

# provider-proxy：per-provider HTTP(S) 代理（Settings UI 里配置，默认 openai 官方规则）
- insert:
    - id: provider-proxy
      name: provider-proxy
      # config 一般不需要；默认内置 openai -> api.openai.com（禁用）

# tailscale-patch：浏览器信任围栏放行的主机名（自建 Headscale 无法签 TLS）
- insert:
    - id: tailscale-patch
      name: tailscale-patch
      config:
        trustedHosts:
          - <your-host>.<your-tailnet>.ts.net   # 或自建域，如 host.inside.example.com

# caddy-https：iOS PWA 的 HTTPS 前端（Web Push 需要安全上下文）
- insert:
    - id: caddy-https
      name: caddy-https
      config:
        host: <your-host>       # 与 trustedHosts 一致
        port: 8443              # >1024 免 root
        targetPort: 3080        # dsh web 监听端口
# 首次激活自动下载 caddy 到 ~/.dsh/caddy-https/；各设备信任根证书：
#   https://<host>:8443/plugins/caddy-https/root.crt
#   iPhone 还需 设置 → 通用 → 关于本机 → 证书信任设置 里打开完全信任。

# 开发期：link: 安装的插件 rebuild 后要能被 HMR 看到。
# web-app 默认禁用共享 hmr 行，这里重新启用并把各插件真实路径加入 watch root
# （node_modules 里的 link 解析路径默认被 ignored 跳过）。
- id: hmr
  disabled: false
  config:
    root:
      - '.'
      - <REPO>/chunk-trim
      - <REPO>/msg-collapse
      - <REPO>/page-lazy
      - <REPO>/flash-device-auth
      - <REPO>/provider-proxy
      - <REPO>/dsh-terminal
      - <REPO>/dsh-mobile
      - <REPO>/tailscale-patch
      - <REPO>/caddy-https
```

客户端一半无需配置：`dsh-client-hmr` 轮询 `lib/client.js` 并经 SSE 热替换。
**改任何 `src/` 后先 `node scripts/build-plugins.mjs` 重建 `lib/`**（gitignore 的构建
产物会静默过期）。

## 5. headless profile（可选）

`~/.dsh/profiles/headless/` 只挂 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless`，
需要 ThreadTrail 时再加 `threadtrail-server` 依赖并在 `cordis.patch.yml` insert。

## 为什么补丁 1–5 不能做成纯插件

补丁目标全是 ESM 模块内部绑定（`writableRoots` 被 `dsh-fs-sandbox` /
`dsh-sandbox-local` 以 live binding 直接 import；`reset` 是闭包私有），cordis 插件
在运行时无法替换：

- **1–3（沙箱执行层）**：无扩展点，必须文件补丁。flash-device-auth 已在运行时
  包装 `ctx.sandboxPolicy.resolve` 注入 `extraWritableRoots`，但执行层不认这个字段
  就无效——补丁正是让执行层认它。
- **5（持久 shell 重生）**：`reset` 在模块闭包内。无补丁的替代路径（枚举
  `ctx.terminals.sessions` 强杀终端）会让下一次 bash 调用先报一次
  "persistent bash send failed" 再自愈，体验差。
- **4（事件类型注册）**：`session.append()` 不接受 `ignorable` 标记，自定义事件
  类型不注册就会导致**重启后整段会话日志被拒载**。想完全去掉此补丁需把授权状态
  从会话日志搬到插件自有 storage——但那样补丁 5 的事件触发链也断了，收益不抵
  复杂度。

结论：保持「文件补丁 + 幂等脚本」是上游提供注册/钩子之前的最优解；脚本会在上游
升级导致文本漂移时拒绝打补丁并报错，提醒更新。

### rc.7（2026-08-17）核查记录

升级到 `0.1.0-rc.7` 后重跑 `patch-probe-roots.mjs`：6 个锚点全部与 rc.7 源码精确
匹配（`dsh-sandbox` / `dsh-sandbox-local` / `dsh-session` 源码零改动，
`dsh-tool-bash-persistent` 仅改提示符/截断逻辑，`reset` 闭包结构未动），自测通过
（`writableRoots({extraWritableRoots})` 正确返回）。同时逐项核查了 rc.7 是否新提供
了插件侧 API 以取代文件补丁——结论：**没有**。

- 1–3：rc.7 全树无 `extraWritableRoots` 字段、无 writable-root 注册钩子；
  `dsh-fs-sandbox` 仍以 ESM live binding 直接 import `writableRoots`。
- 4：`Session.append(type, data, ...opts)` 的 opts 仍只有 `sourceEventSeqs` /
  `surfaceOp`，不接受 `ignorable`；`dsh-session-persistence` 仍对未知非 ignorable
  事件类型整体拒载。
- 5：`dsh-tool-bash-persistent` 仍只导出 `{Config, apply, inject, name}`，`reset`
  闭包私有；插件侧强杀终端的路径在 rc.7 仍是「下一次 bash 报一次 send failed 再
  自愈」。

插件兼容性抽查（rc.6→rc.7 的实质代码差异）：`dsh-host-apiproxy`（设置命名空间与
附件批量保存，`sessions/subagents.history` 签名不变）、`dsh-tools`（仅 code-mode
提示文案）、`dsh-client-runtime`（删了一个错误字面量）、`dsh-client-ui-conversation`
（仅 Safari 输入框修复 + CSS 哈希）、`dsh-client-ui-layout`（仅 CSS 哈希）。仓库内
全部插件无需改动即可在 rc.7 下运行。
