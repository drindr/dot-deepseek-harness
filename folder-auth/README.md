# folder-auth

dsh 主机插件：**按会话授权任意目录**，让 agent 在 `workspace-write` 沙箱下写工作空间之外的
指定文件夹，免审批直接工作。与 `flash-device-auth` 同一套 `extraWritableRoots` 机制，只是
授权对象从设备节点换成**目录绝对路径**。

## 为什么需要它

`workspace-write` 沙箱只放行工作空间根 + 平台临时目录。要写外部目录（另一个仓库、挂载盘、
共享目录……）就只能升级 `danger-full-access`（每次一次审批弹窗）。本插件按会话授权具体目录，
沙箱补丁把这些目录 bind 进容器，此后 workspace-write 下直接可写，零弹窗。

## 语义

- **按会话**：授权写为该会话日志的 `sandbox/folder-root` 事件；新会话零授权，会话结束即失效。
- **子会话继承**：沿 `parentSession` 链向上并集（子 agent 也免确认）。
- **授权形态**：目录绝对路径 `{ path }`。**不做存在性校验、不做黑名单/白名单**（见下）。
- **可撤销**：`/fsauth remove|clear`，或会话结束。
- **审计**：授权/撤销事件入会话日志。

## 使用

在会话里执行（这是用户命令，不是给 agent 的）：

```
/fsauth list                      # 本会话已授权目录 + 解析出的根
/fsauth add <绝对路径>            # 授权该目录（本次会话）
/fsauth remove <绝对路径>         # 撤销
/fsauth clear                     # 清空本会话全部授权
```

授权后，该会话内对授权目录的写入不再需要审批；未授权目录照旧 deny → 人工流程。

## ⚠️ 安全模型（有意为之）

`/fsauth add` 只做一条**正确性**校验：路径必须以 `/` 开头且非空（bwrap 挂载的形式要求；
`/` 本身会被拒绝，因为不能 bind 覆盖沙箱根）。

**除此之外零过滤**：不存在、`/etc`、`~/.ssh`、DSH 安装树等路径一律照收。授权是**人来做决定**
的命令，agent 不能自行授权；prompt 注入会提醒 agent 不要诱导用户授权敏感位置。若你希望收紧
范围，应改用更严格的策略或白名单，本插件刻意不内置。

## 前置：沙箱补丁（必须）

依赖 `extraWritableRoots` 的扩展钩子，与 `flash-device-auth` 共用一个补丁脚本：

```bash
node scripts/patch-probe-roots.mjs            # 应用（幂等）
node scripts/patch-probe-roots.mjs --revert   # 回退
```

打补丁后**必须重启 `dsh web`**。

> 补丁对每个 `extraWritableRoots` 用 `--dev-bind` 挂进容器。实测 `--dev-bind` 对**目录**同样
> 生效（目录经 `--ro-bind / /` 已存在于容器内，`--dev-bind` 等价于 writable bind），所以
> 目录授权**无需改动补丁**——`flash-device-auth` 的补丁原样即可同时服务设备与目录。

## 构建（TypeScript）

`src/` 是源码，`lib/` 是 esbuild 构建产物（gitignore）：

```bash
pnpm install      # 装 devDeps（typescript / esbuild / @types/node）
pnpm build        # node build.mjs → lib/index.js
pnpm typecheck    # tsc -p tsconfig.json
pnpm test         # node --test（node:test 原生跑 .ts，无需 vitest）
```

## 配置（web profile patch）

```yaml
- insert:
    - id: folder-auth
      name: folder-auth
```

无其它配置项——授权一律按会话经 `/fsauth add` 发生。
