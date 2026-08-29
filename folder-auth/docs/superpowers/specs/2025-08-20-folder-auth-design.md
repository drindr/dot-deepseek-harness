# folder-auth 设计文档

日期：2025-08-20
状态：已评审待实现

## 1. 背景与目标

`flash-device-auth` 插件按会话授权**设备节点**（调试探头 / USB 串口），让烧录在
`workspace-write` 沙箱下免审批直接工作。用户需要同样的授权体验，但对象是**任意外部文件夹**：
让某一次会话能把工作空间之外的目录加入可写白名单，其余行为不变（未授权照旧 deny）。

本插件 `folder-auth` 复用同一套 `extraWritableRoots` 机制，只把授权对象从设备节点换成
**目录绝对路径**。

### 目标

- 按会话授权任意目录（人通过 `/fsauth add <绝对路径>` 触发）。
- 子会话继承、可撤销、会话结束失效、未授权 fail-closed。
- 与 `flash-device-auth` 共存、可叠加。

### 非目标

- 不做黑名单 / 白名单 / 存在性校验（见 §4 安全模型）。
- 不覆盖 Windows ACL rung（该 rung 不消费 `extraWritableRoots`，与 flashdev 相同限制）。
- 不改动 `flash-device-auth` 的语义与代码。

## 2. 仓库形态（独立 submodule）

`folder-auth` 是一个**独立的 git 仓库**，通过 git submodule 挂进
`dot-deepseek-harness`（与 `dsh-rerun` / `dsh-mobile` / `dsh-terminal` / `ThreadTrail`
一致），**代码不提交进父 repo**。

- **当前阶段**：仓库先在**本地**建立，**不建远程**；托管位置待定，实现阶段再决定是否 push。
- **本 spec 的归属**：随子仓库走，最终落在 `folder-auth` 仓库内（如
  `docs/superpowers/specs/`）。建仓时把本文件从父 repo 工作树移入子仓库。
- 父 repo 侧只登记 submodule 指针（`.gitmodules` + gitlink），不含插件源码。

## 3. 术语

- **授权（grant）**：一条 `{ path }`，一个绝对目录路径。
- **会话（session）**：dsh 的一个 agent 会话；授权事件写入该会话的日志。
- **extraWritableRoots**：策略对象上的附加可写根列表，由沙箱补丁消费。

## 4. 安全模型（明确取舍）

用户选择「真·任意路径」：

- `/fsauth add` 只做**正确性校验**：路径必须以 `/` 开头且非空。这是 bwrap `--bind` 的
  形式要求，**不是安全过滤**。
- **不做**：存在性校验、敏感路径拦截、`..` 穿越拒绝、白/黑名单。
- 后果：人可以授权 `/etc`、`~/.ssh`、DSH 安装树等敏感位置。这是**有意为之的取舍**，
  README 与 prompt 注入中必须显著注明。
- 授权是**人来触发**的（命令是给用户跑、不是给 agent 跑），与 flashdev 一致：agent 不
  能自行授权；未授权路径照旧 deny → 人工审批流程。

## 5. 架构与组件

TypeScript 编写，esbuild 构建（遵循 `caddy-https` / `dsh-rerun` host 半边约定）。

```
folder-auth/
├── package.json        # name: folder-auth; type: module; main: lib/index.js
│                       # scripts: build = "node build.mjs", typecheck = "tsc -p tsconfig.json"
│                       # peerDeps: @deepseek-ai/cordis; devDeps: @types/node, esbuild, typescript
├── build.mjs           # esbuild: src/index.ts → lib/index.js（ESM, node20, --external:@deepseek-ai/*）
├── tsconfig.json       # strict + noEmit（纯类型检查）, types:["node"], include:["src","tests"]
├── .gitignore          # lib/  node_modules/
├── src/
│   ├── index.ts        # 插件主体：包装 sandboxPolicy.resolve + /fsauth 命令 + prompt 注入
│   └── paths.ts        # 纯函数：foldFolderGrants / collectGrants / 绝对路径 token 校验
└── tests/
    ├── paths.test.ts   # node:test 单测（纯函数）
    └── index.test.ts   # node:test 单测（makeResolveWrapper）
```

配套改动：把 `folder-auth` 加进 `scripts/build-plugins.mjs` 的 `PLUGINS` 列表（该列表已
同时包含直接提交的 `caddy-https` 与 submodule 的 `dsh-terminal` / `dsh-mobile` / `dsh-rerun`，
submodule 形态不影响构建驱动）。

### 类型策略

插件注入 `sandboxPolicy` / `sessions` / `commands` / `systemPrompt`（cordis DI）。TS 侧优先
使用 `@deepseek-ai/cordis` 的类型（peer dep、build 时 external）；若类型不可解析则定义最小
本地接口，不引入额外运行时依赖。

## 6. 授权模型与命令语义

镜像 `flash-device-auth`：

- **按会话**：授权写为会话日志的 `sandbox/folder-root` 事件；新会话零授权，结束失效。
- **子会话继承**：沿 `parentSession` 链向上并集（`seen` 去重防环）。
- **可撤销**：`remove` / `clear`，或会话结束。
- **授权形态**：只有目录绝对路径 `{ path }`，不解析、不校验存在性。

命令 `/fsauth`：

```
/fsauth add <绝对路径>      # 授权该目录（本次会话）
/fsauth remove <绝对路径>   # 撤销
/fsauth list                # 本会话已授权目录
/fsauth clear               # 清空
```

错误分支：非绝对路径 / 空路径 → 命令返回错误，不落事件。

prompt 注入：告知 agent「本会话已授权哪些目录，写这些目录不要升级；其余照旧 deny」，
并显著提示「任意路径授权」的风险边界。

## 7. 沙箱补丁（无需改动）

实测结论：现有 `scripts/patch-probe-roots.mjs` **原样即可同时服务设备与目录**，无需改动。

- 补丁对每个 `extraWritableRoots` 用 `--dev-bind` 挂进容器。实测 `--dev-bind` 对**目录**
  同样生效：目录经 `--ro-bind / /` 已存在于容器内，`--dev-bind` 等价于 writable bind
  （已用 bwrap 冒烟验证写入成功）。而设备节点仍需 `--dev-bind`（flashdev 已验证 `--bind`
  会 EACCES）。
- 另外三处（`writableRoots` / `landlockProfileArgs` / `seatbeltProfileArgs`）对目录本就通用。
- 结论：folder-auth 复用 flashdev 的补丁，**零补丁改动**；部署前置仍是「打补丁 + 重启
  `dsh web`」。

## 8. 数据流

1. `/fsauth add /some/dir` → 会话日志追加 `sandbox/folder-root {op:"add", path:"/some/dir"}`。
2. 每次 resolve：包装后的 `resolve` 沿 `parentSession` 链收集授权 → 映射成路径 →
   追加进 `extraWritableRoots`（保留已有项）。
3. 生效面（四路一致）：
   - 文件工具 write/edit：fs 栅栏经 `writableRoots`；
   - bash：bwrap `--dev-bind`；
   - Landlock：readWrite；
   - Seatbelt：`writableRoots`。
4. 未授权路径照旧 deny。

## 9. 错误处理

- 非绝对路径 / 空路径 → `/fsauth` 返回错误。
- 授权了但不存在 / 无法解析的路径 → `--dev-bind` spawn 失败、fs 栅栏 `canonicalPath` 匹配不到
  → 两路均 fail-closed。
- 未授权写入 → deny（行为不变，走既有审批流程）。

## 10. 测试

- **node:test 单测（纯函数，Node 24 原生跑 `.ts`，无需 vitest）**：
  - `foldFolderGrants`：add/remove/clear/乱序折叠、忽略畸形事件。
  - `collectGrants`：parentSession 链并集、环安全。
  - 绝对路径 token 校验各分支（含拒绝 `/`）。
  - `makeResolveWrapper`（可注入）：workspace-write 追加、非 workspace-write 不动、无授权/无会话不追加、保留已有 extraWritableRoots。
- **补丁层**：保留现有 `writableRoots` self-test；目录 `--dev-bind` bwrap 冒烟、设备
  `--dev-bind` 作为 README 记录的手工验证项，不进 CI。

## 11. 风险与边界

1. 「真·任意路径」是有意取舍，README + prompt 显著注明。
2. macOS（Seatbelt）经 `writableRoots` 生效；Windows ACL rung 不消费 `extraWritableRoots`
   （与 flashdev 相同限制），文档注明 out-of-scope。
3. 补丁漂移：DSH 升级后 bwrap 块等文本可能不匹配 → 脚本"不匹配即报错"，README 提醒
   升级后重跑补丁 + 重启 `dsh web`。
4. 与 flashdev 叠加：append 组合安全；HMR 卸载时各自恢复 `original` 的顺序属边缘 case，
   README 注明。
5. 授权只在会话日志里，会话结束失效，不跨会话泄漏。

## 12. 文档

- 新增 `folder-auth/README.md`：语义、用法、前置（补丁 + 重启）、风险、与 flashdev 关系。
- 更新仓库根 `README.md` 目录总览表（标注 folder-auth 为 submodule）；把
  `scripts/patch-probe-roots.mjs` 说明从「仅设备」改为「设备 + 目录两类 root」。
