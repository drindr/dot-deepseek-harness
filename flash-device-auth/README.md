# flash-device-auth

dsh 主机插件：**按会话授权烧录设备**（调试探头、USB 串口、任意设备节点），让烧录在
`workspace-write` 沙箱下免审批直接工作。

## 为什么需要它

bwrap 沙箱容器的 `/dev` 是稀疏 devtmpfs，**没有 `/dev/bus/usb`、`/dev/hidraw`、
`/dev/ttyACM*`、`/dev/ttyUSB*`**（这些树由主机 udev 创建）。probe-rs 在沙箱内能枚举到
探头但全部 `(inaccessible)`，串口烧录（esptool 等）同样找不到设备——烧录不得不升级
`danger-full-access`（每次烧录一次审批弹窗）。本插件按会话授权具体设备，配套的沙箱
补丁把这些节点的真实路径挂进容器（`--dev-bind`），此后 workspace-write 下直接可烧，零弹窗。

## 语义

- **按会话**：授权写为该会话日志的 `sandbox/device-root` 事件；新会话零授权，
  会话结束即失效。**不是全局、不是"每个会话"**。
- **子会话继承**：沿 `parentSession` 链向上并集（子 agent 烧录也免确认）。
- **两种授权形态**：
  - **设备身份** `vid:pid[:serial]`（推荐）：每次调用经 sysfs 解析成当前真实节点
    （`/dev/bus/usb/BB/DDD` 补零路径 + hidraw + ttyACM/ttyUSB），重插/换号自动跟随；
    未插则解析为空 → 照旧 deny（fail closed）。**不绑定具体编号，未来换任何
    VID:PID 的探头/串口适配器都适用**。
  - **精确路径** `/dev/...`：直接点名（覆盖板载串口 `/dev/ttyS0`、块设备等没有
    USB 身份可解析的目标）；路径必须位于 `/dev` 下且当前是设备节点才生效。
- **可撤销**：`/flashdev remove|clear`，或会话结束。
- **审计**：授权/撤销事件入会话日志（无逐次调用记录）。

## 使用

在会话里执行（这是用户命令，不是给 agent 的）：

```
/flashdev list                          # 目录 + 本会话授权 + 当前解析到的节点
/flashdev scan                          # 列出当前插入的所有 USB 设备（发现新设备用）
/flashdev add all                       # 目录非空→授权目录全部；目录为空→授权当前所有已插入的 USB 设备
/flashdev add 0d28:0204                 # 按 VID:PID（该类全部设备）
/flashdev add 0d28:0204:070000...       # 按 VID:PID:serial（精确到某台）
/flashdev add /dev/ttyUSB0              # 按精确路径（串口/板载串口/块设备）
/flashdev remove <同上>                  # 撤销
/flashdev clear                         # 清空本会话全部授权
```

授权后，该会话内对授权设备节点的写入不再需要审批；未授权设备照旧走 deny → 人工流程。
新设备接入：`/flashdev scan` 看 VID:PID → `/flashdev add <vid:pid[:serial]>` 即完成授权，
**无需改代码或配置**。

## 前置：沙箱补丁（必须）

本插件依赖 `writableRoots` 的扩展钩子。DSH 安装树位于 npm/npx 缓存且升级即被替换，
用补丁脚本管理（幂等、可回退、升级后重跑）：

```bash
node /home/drin/workspace/dsh-plugin/scripts/patch-probe-roots.mjs            # 应用
node /home/drin/workspace/dsh-plugin/scripts/patch-probe-roots.mjs --revert   # 回退
```

打补丁后**必须重启 `dsh web`**。补丁内容（全部加性，无 `extraWritableRoots` 时行为不变）：

| 位置 | 函数 | 作用 |
|---|---|---|
| `dsh-sandbox` | `writableRoots()` | seatbelt / fs 栅栏写入授权 |
| `dsh-sandbox-local` | `bwrapProfileArgs()` | 把授权节点用 `--dev-bind` 挂进容器 |
| `dsh-sandbox-local` | `landlockProfileArgs()` | Landlock 写入授权 |

（仅 `workspace-write` 模式下生效；`read-only`/`danger-full-access` 语义不变。）

### 实测发现（决定实现的关键结论）

1. **必须 `--dev-bind`，不能 `--bind`**：bwrap unshare 用户命名空间后，用 `--bind` 挂进
   容器的设备节点无法打开（open 返回 EACCES，即使节点 0666 世界可写）；`--dev-bind`
   正常且自动创建父目录。
2. **usbfs 路径三位补零**：`/dev/bus/usb/<bus>/<dev>` 节点名是补零的（`003/002` 而非
   `3/2`）——插件按补零路径解析，否则 stat 失败、节点被丢弃。
3. **probe-rs 走 libusb**：核心节点是 `/dev/bus/usb/BB/DDD`（hidraw 对 DAPLink 非必需，
   一并注入无害）；串口烧录（esptool 等）走 ttyACM/ttyUSB，插件同样解析注入。

## 配置（web profile patch，可选）

```yaml
- insert:
    - id: flash-device-auth
      name: flash-device-auth
      # catalog 是可选的"已知设备"注册表，仅为 /flashdev add all 和标签便捷：
      # config:
      #   catalog:
      #     - { label: daplink-1, vid: "0d28", pid: "0204", serial: "0700000100440055360000054e534d4ca5a5a5a597969908" }
      #     - { label: jlink-1,  vid: "1366", pid: "1069", serial: "001051878318" }
```

**默认 catalog 为空**——插件不预设任何设备，授权一律按会话经 `/flashdev add` 发生。
`catalog` 只是便捷注册表，**不构成授权**。`/flashdev add all` 在目录非空时授权目录全部；
目录为空时**回退为授权当前所有已插入的 USB 设备**（输出会明确列出添加了哪些）。

## 主机侧注意

- 设备节点权限由主机 udev 规则决定（如 `/etc/udev/rules.d/69-probe-rs.rules`）。
  容器内挂载的节点继承主机权限；若主机上普通 shell 能烧录，容器内同样能。
  若 SSH 使用且未在 plugdev 组，需先在主机侧解决（`usermod -aG plugdev $USER`）。
- 网络烧录（probe-rs server）不涉及设备节点，不在本插件范围。
