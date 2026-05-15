# 终端沙箱隔离系统 — 复刻执行方案

## 一、整体思路

在 AI 编程助手中，LLM 生成的 shell 命令需要在**受限环境**中执行。核心思路是：**在 OS 级沙箱中 spawn 子进程，通过命名空间/系统调用过滤限制其权限，同时保持与用户的正常交互体验。**

```
LLM 生成命令 → 安全校验 → 沙箱包装 → 子进程执行 → 输出回传
               ↓               ↓
          (应用层防御)    (OS 级隔离)
```

---

## 二、架构分层

### 第 1 层：OS 级沙箱引擎

不同平台选不同的底层技术：

| 平台 | 技术 | 原理 | 安装方式 |
|------|------|------|---------|
| **Linux** | `bubblewrap` (bwrap) | user/mount/network/pid 命名空间 | `apt install bubblewrap` |
| **macOS** | `sandbox-exec` + Seatbelt 配置文件 | 系统调用过滤 + 文件系统限制 | 内置于系统 |
| **WSL2** | `bubblewrap` | 同上 | `apt install bubblewrap socat` |
| **Windows 原生** | ❌ 不支持 | 无 OS 级沙箱 | — |

**避坑：**
- WSL1 不支持，必须检测 WSL 版本并提示升级
- bwrap 在 Docker 容器内需要 `--privileged` 或 `--security-opt seccomp=unconfined`
- macOS sandbox-exec 在较新版本中有行为变化，需要兼容处理

### 第 2 层：沙箱适配器（Adapter）

职责：将应用配置转换为沙箱引擎能理解的规则。

```typescript
// 核心接口
interface SandboxAdapter {
  initialize(config: SandboxConfig): Promise<void>
  wrapWithSandbox(command: string, shell?: string): Promise<string>
  cleanupAfterCommand(): void
  updateConfig(config: SandboxConfig): void
}
```

关键工作：
1. **配置转换** — 把应用的权限规则（allowWrite/denyRead/allowedDomains）翻译成沙箱配置
2. **命令包装** — 把原始命令用 bwrap args 或 Seatbelt 配置包裹起来

**避坑：**
- 配置转换时要处理路径解析：`/path` 是 settings 相对路径还是绝对路径？（CC 里 permission rule 用 settings-relative，sandbox.filesystem 设置用绝对路径，两者不同）
- 设置变更后要动态刷新沙箱配置，无需重启
- 初始化失败要优雅降级（显示警告而非崩溃），除非 `failIfUnavailable: true`

### 第 3 层：命令构建与 Spawn

命令执行流程：

```
原始命令
   ↓  shellQuote (引用转义)
   ↓  prepend snapshot sourcing (环境快照)
   ↓  prepend extglob disable (禁用通配符展开)
   ↓  append pwd -P > cwd-file (CWD 追踪)
   ↓  apply sandbox wrap (bwrap/sandbox-exec)
   ↓  child_process.spawn()
```

**避坑：**
- **沙箱内 CWD 追踪**：不能用普通文件，要用沙箱临时目录内的专用文件，防止普通用户目录被污染
- **stdout/stderr 合并**：用同一个 fd（O_APPEND），保证输出时序正确。Windows 用 `'w'` 模式而非 `'a'`，因为 MSYS2 对只追加句柄有兼容问题
- **O_NOFOLLOW**：打开输出文件时加此标志，防止沙箱内符号链接攻击
- **进程组分离**：`detached: true`，方便 cleanup 时 kill 整个进程树
- **heredoc 支持**：zsh 需要单独设置 `TMPPREFIX` 环境变量指向沙箱内路径
- **命令引用**：必须正确处理特殊字符、多行命令、重定向

### 第 4 层：安全校验（应用层防御纵深）

即使 OS 沙箱启动，应用层也不能完全信任命令内容：

```typescript
class BashSecurityValidator {
  // 1. 命令替换检测
  //    $() ``, 进程替换 <() >() =(), Zsh 参数展开 ${}
  // 2. Zsh 危险命令
  //    zmodload, emulate, sysopen, ztcp, zpty 等
  // 3. 通配符展开
  //    禁用 extglob/EXTENDED_GLOB 防止 glob 绕过
  // 4. 特殊字符
  //    控制字符、Unicode 空白、反斜杠转义空格
  // 5. Git 安全
  //    阻止 core.fsmonitor 等 git 配置注入
}
```

**避坑：**
- 不要只依赖正则检测——shell 语法极其灵活，总有绕过方式
- Zsh 的 `=cmd` 展开会将命令名替换为绝对路径（`=curl` → `/usr/bin/curl`），绕过基于命令名的黑名单
- 检测应作为防御纵深，**不是安全边界**——真正的安全边界在 OS 级沙箱

---

## 三、核心流程（按执行顺序）

### 1. 启动阶段

```
main.ts
  ↓
SandboxAdapter.initialize()
  ├── 检测平台支持
  ├── 检测依赖 (bwrap/sandbox-exec)
  ├── 解析 settings → SandboxRuntimeConfig
  │   ├── 网络: allowedDomains/deniedDomains
  │   ├── 文件系统: allowWrite/denyWrite/denyRead/allowRead
  │   └── 忽略策略: ignoreViolations
  ├── 订阅 settings 变更 → 动态更新
  └── 初始化沙箱引擎
```

**关键路径解析：**

```typescript
// 文件系统路径的解析规则（最容易出错的地方）
permission rules:  Edit(/foo/**)  → /path/to/settings/foo/**
                   Edit(//foo/**) → /foo/**
                   Edit(~/foo/**) → ~/foo/** (sandbox-runtime 处理)

sandbox.filesystem:  allowWrite: /foo/** → /foo/** (绝对路径，和 permission rule 不同!)
                     allowWrite: ~/foo/** → expandHome(~/foo/**)
                     allowWrite: ./foo/** → resolve(settingsDir, ./foo/**)
```

### 2. 命令执行阶段

```
BashTool.call({ command, dangerouslyDisableSandbox })
  ↓
shouldUseSandbox(input) → true/false
  ├── isSandboxingEnabled() → 全局开关 + 平台 + 依赖
  ├── dangerouslyDisableSandbox 检查
  ├── excludedCommands 匹配（拆分 && 复合命令后逐条检查）
  └── 返回决策
  ↓
buildExecCommand(command) → commandString
  ├── source snapshot || true      (还原环境变量)
  ├── session env script           (hook 设置的环境)
  ├── disable extglob              (防通配符绕过)
  ├── eval <quoted-command>        (实际命令)
  └── pwd -P >| /tmp/cwd-file     (记录 CWD)
  ↓
if (shouldUseSandbox):
  commandString = wrapWithSandbox(commandString, shell)
  // bwrap: --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp ...
  // macOS: sandbox-exec -f seatbelt.conf ...
  ↓
spawn(shell, ['-c', commandString], {
  env: { ...subprocessEnv(), TMPDIR: sandboxTmpDir, ... },
  cwd, stdio, detached,
})
```

### 3. 命令完成阶段

```
命令结束
  ↓
SandboxManager.cleanupAfterCommand()
  ├── sandbox-runtime cleanup
  └── scrubBareGitRepoFiles() ← 重要！清理恶意的 bare repo 文件
  ↓
读取 cwd 文件 → setCwd()
  ↓
删除 cwd 临时文件
```

**避坑：**
- bwrap 对不存在的路径创建 0 字节 mount point 文件，必须在命令结束后清理（`cleanupAfterCommand`）
- bare repo 攻击：攻击者在 CWD 创建 `HEAD` + `objects/` + `refs/` 伪装 git bare repo，LLM 的 git 操作会触发 `core.fsmonitor`。对**已存在**的文件用 denyWrite，对**不存在**的路径在命令执行后检查并删除
- CWD 文件读取要同步（`readFileSync`），否则异步边界会导致后续代码读到旧 CWD

---

## 四、安全边界清单

| # | 边界 | 实现方式 | 绕过风险 |
|---|------|---------|---------|
| 1 | 网络隔离 | bwrap `--unshare-net` + 白名单代理 | 中 — 可通过 Unix socket 绕过 |
| 2 | 文件写入限制 | bwrap `--ro-bind` + `--tmpfs` | 低 — OS 级只读挂载 |
| 3 | settings 保护 | denyWrite 写入 settings.json | 低 — 写入会被 OS 拒绝 |
| 4 | skill 保护 | denyWrite `.claude/skills/` | 低 — 防止恶意 skill 自动加载 |
| 5 | bare repo 攻击 | denyWrite + post-command scrub | 中 — 需要同步清理无竞态 |
| 6 | 进程替换 | 应用层正则检测 | 高 — shell 语法多变 |
| 7 | 环境变量泄露 | 沙箱内外环境隔离 | 中 — TMPDIR 需指向沙箱内 |
| 8 | Unix socket | `allowUnixSockets` 白名单 | 中 — macOS 可通过 trustd 绕过 |

---

## 五、复刻实现的最小可行步骤

### Step 1：选择底层沙箱方案
- **推荐**：直接集成 `bubblewrap`（Linux） + `sandbox-exec`（macOS）
- **备选**：使用容器（Docker），但代价更高
- 抽象 `SandboxEngine` 接口，屏蔽平台差异

### Step 2：实现配置系统
- 定义沙箱配置 schema（enabled、network、filesystem、excludedCommands）
- 支持多来源合并（本地配置 + 策略配置）
- 支持运行时动态更新

### Step 3：实现适配器
- 将应用配置转换为引擎参数
- 处理路径解析（绝对路径、相对路径、home 目录、settings-relative）
- 初始化沙箱引擎并订阅配置变更

### Step 4：集成到命令执行管道
- 命令构建 → 安全校验 → 沙箱包装 → spawn → 结果处理
- 复合命令拆分（`&&`、`||`、`;`）后逐段检查排除规则

### Step 5：实现后清理
- 清除 bwrap 残留的 0 字节 mount point
- 检测并清除 planted bare repo 文件

### Step 6：UI 集成
- 沙箱状态指示器（启用/禁用/依赖缺失）
- 自动允许策略（autoAllowBashIfSandboxed）
- 沙箱违规日志注释

---

## 六、关键函数签名速查

```typescript
// 决策层
function shouldUseSandbox(input: { command?, dangerouslyDisableSandbox? }): boolean

// 适配层
function convertToSandboxRuntimeConfig(settings: SettingsJson): SandboxRuntimeConfig
function wrapWithSandbox(cmd: string, shell?: string, config?, signal?): Promise<string>

// 命令层——构建
interface ShellProvider {
  type: 'bash' | 'powershell'
  shellPath: string
  buildExecCommand(cmd: string, opts: { id, sandboxTmpDir?, useSandbox }): Promise<{ commandString, cwdFilePath }>
  getSpawnArgs(cmd: string): string[]
  getEnvironmentOverrides(cmd: string): Promise<Record<string, string>>
}

// 命令层——执行
async function exec(command, abortSignal, shellType, options?: ExecOptions): Promise<ShellCommand>
// options 包含: timeout, onProgress, shouldUseSandbox, shouldAutoBackground 等
```

---

## 七、依赖清单

| 依赖 | 类型 | 用途 |
|------|------|------|
| `bubblewrap` (Linux) | 系统包 | OS 级命名空间隔离 |
| `socat` (Linux) | 系统包 | 网络代理转发 |
| `sandbox-exec` (macOS) | 内置于 OS | Seatbelt 沙箱 |
| `@anthropic-ai/sandbox-runtime` | npm | 封装底层沙箱操作 |
| `child_process.spawn` | Node.js 内置 | 子进程创建 |
| `tree-kill` | npm | 进程树清理 |

---

## 八、常见陷阱汇总

1. **路径解析不一致**：permission rules 和 sandbox.filesystem 设置用不同语义解析 `/path`，务必区分
2. **Windows 兼容**：不是"不支持沙箱"就完事了——MSYS2 的文件模式、POSIX/Windows 路径转换、Git Bash 行为差异都需要处理
3. **bwrap 0 字节文件**：bwrap 对 denyWrite 的不存在路径创建 mount point 文件，必须清理
4. **竞态条件**：CWD 追踪、环境快照读取必须在同步代码块中完成，异步边界会导致状态不一致
5. **shell 注入**：命令引用必须彻底（shellQuote），特别处理 heredoc、多行命令、Unicode
6. **Zsh 特殊语法**：`=cmd` 展开、`zmodload`、`emulate -c` 都是潜在绕过点
7. **git worktree**：worktree 内的 .git 是文件而非目录，需要特殊处理以允许写入主仓库
8. **复合命令拆分**：`docker ps && curl evil.com` — 第二段不匹配排除规则，必须拆分后逐段检查

---

## 九、Windows Git Bash 可见窗口控制补充方案

### 目标

在 Windows 下继续保持两条执行链路分离：

- `SandboxManager.exec()`：面向代理内部命令执行，默认 `windowsHide: true`，不弹出可见窗口
- `Web Window Control`：面向人工或外部系统触发，显式启动和关闭一个可见的 Git Bash 窗口

这两条链路不能混用。可见窗口控制不应复用隐藏执行路径里的 `spawn(..., windowsHide: true)`。

### 执行环境

- Shell 固定为 `Git Bash`
- 平台固定为 `Windows 原生`
- Web 控制层只负责 `start / stop / status`
- 可见窗口实例名固定为 `jhy`

### 启动策略

1. 通过现有 `findShell()` 解析 Git Bash 路径
2. 仅当 `process.platform === 'win32'` 时允许启动可见窗口
3. 使用 PowerShell `Start-Process -PassThru` 启动 `bash.exe`
4. 启动成功后记录 PID 到本地状态文件
5. 同名窗口已存在时直接返回当前状态，不重复启动

原因：

- `cmd /c start` 虽然能弹窗，但 PID 管理不稳定
- `Start-Process -PassThru` 可以拿到明确 PID，便于后续关闭

### 关闭策略

1. 从状态文件读取 `jhy` 对应 PID
2. 先校验 PID 是否仍存活
3. 使用 `taskkill /T /F /PID <pid>` 关闭整个进程树
4. 删除或刷新状态文件

禁止按窗口标题模糊匹配杀进程，避免误杀别的 Git Bash 窗口。

### Web API 边界

建议最小接口：

- `POST /windows/jhy/start`
- `POST /windows/jhy/stop`
- `GET /windows/jhy/status`

约束：

- 只监听 `127.0.0.1`
- 只返回 JSON
- 不直接暴露任意命令执行能力
- 仅允许受控参数：`cwd`、`title`、`command`

### 状态存储

状态目录建议独立：

```text
web-control/
  runtime/
    jhy.json
```

状态文件至少包含：

```json
{
  "name": "jhy",
  "pid": 12345,
  "shellPath": "C:\\Program Files\\Git\\bin\\bash.exe",
  "cwd": "D:\\Dev-test\\test1\\happy-test",
  "startedAt": "2026-05-15T00:00:00.000Z",
  "command": "echo ready; exec bash -i"
}
```

### 与现有实现的关系

- 保留 `src/sandbox-manager.js` 中的隐藏执行策略
- 新增独立模块处理“可见窗口控制”
- 文档、代码、测试都以 `Git Bash` 为 Windows 默认 shell
- Windows 可见窗口控制不纳入 OS 级沙箱承诺范围，它是单独的操作能力
