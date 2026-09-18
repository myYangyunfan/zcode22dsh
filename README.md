# dsh-zcode-migrate

把 **zcode CLI 的历史会话**迁移成 **dsh（DeepSeek Harness）原生会话日志**。迁移产物直接落在 dsh 的会话目录里，dsh 无需任何适配就能识别、浏览、恢复（resume）它们。

参考实现：[yanggenjie/zcode-data-archive](https://github.com/yanggenjie/zcode-data-archive)（把 zcode 导出为 pi 格式 / HTML 预览站 / 归档报表）。本项目是同一件事的 **dsh 版本**，并且做成了 dsh 插件。

本仓库是该插件的独立主页；它同时被内置在 [DSH Desktop](https://github.com/myYangyunfan/dsh_desktop)（桌面客户端）里作为伴随插件开箱可用——两处的代码同源，独立仓库便于单独安装与跟踪改动。

**零第三方依赖**，只用 Node 内置模块（`node:sqlite`、`node:zlib`），`npm ci` 不需要装任何东西。

---

## 它做了什么

zcode 和 dsh 都用 SQLite/文件记录会话，但两边的**数据模型根本不同**：

| | zcode | dsh |
|---|---|---|
| 存储 | `~/.zcode/cli/db/db.sqlite`（session / message / part 三张表） | `~/.dsh/sessions/<项目>/<会话>/session.jsonl.zstd` |
| 模型 | **物化转录**：一串消息，每条自带内容片段 | **事件溯源日志**：追加式事件流，历史由回放推导 |
| 工具结果 | 挂在发起它的 assistant 消息里（`part.state.output`） | 独立的 user 角色 surface 事件（`tool/result`） |
| 轮次/步骤 | 隐含在消息顺序里 | 显式的 `turn/start`、`step/start`、`step/end`、`turn/end` 边界 |

所以迁移不是改个后缀，而是**换模型**。本项目做的就是把前者翻译成后者，并且翻译到 dsh 自己的读取器完全认不出来的程度。

### 为什么产物能被 dsh 直接读到

dsh 的 JSONL 持久化后端把每个会话存成：

```
<root>/--<归一化 cwd>--/<编码后的会话 id>/session.jsonl.zstd
```

文件内容是**拼接的带校验和 zstd 帧，每帧一条 JSONL 记录**，首帧第一条是 v0 会话头。

`core/paths.js` 与 `core/zstdlog.js` **逐字节复刻**了这套规则（`projectKey` / `encodeSegment` 直接移植自 `@deepseek-ai/dsh-session-persistence-jsonl`），因此产物与 dsh 自己写出的文件在磁盘上同构——包括 zstd 帧描述符位（`singleSegment=false`、`checksum=true`）、CJK 路径的 `~XXXX` 转义、以及 Windows 路径长度处理。

---

## 安装

```bash
git clone https://github.com/myYangyunfan/zcode22dsh.git
dsh plugin --profile web add ./zcode22dsh     # 装进某个 profile
```

也可以直接用本地路径（开发时更顺手）：

```bash
dsh plugin --profile web add /path/to/dsh-zcode-migrate
```

或者在 profile 的 patch 层里插入本插件（见 `cordis.patch.yml`）：

```yaml
- insert:
    - id: zcode-migrate
      name: dsh-zcode-migrate
      config:
        dbPath: ~/.zcode/cli/db/db.sqlite
        dshRoot: ~/.dsh/sessions
        includeSubagents: false
        snapshot: true
        agentPreset: standard
        slashCommand: true
```

**零第三方依赖**：只用 Node 内置的 `node:sqlite`（≥22.5）与 `node:zlib` 的 zstd（dsh 自身也依赖它，所以运行 dsh 的环境必然具备）。

### 配置项

| 字段 | 默认 | 含义 |
|---|---|---|
| `dbPath` | `~/.zcode/cli/db/db.sqlite` | zcode 会话库路径 |
| `dshRoot` | `~/.dsh/sessions` | dsh 会话根目录（产物写到这里） |
| `includeSubagents` | `false` | 是否默认迁移子代理会话（子代理数量通常是顶层的好几倍） |
| `snapshot` | `false` | 是否先用 SQLite 在线备份做一致性快照 |
| `agentPreset` | `standard` | 写入会话头的 dsh agent preset（决定恢复该会话时的工具与提示词组合） |
| `slashCommand` | `true` | 注册 `/zcode` 斜杠命令约定 |

关于 `snapshot`：只读访问对 WAL 库本身就是一致读，所以默认关闭。开启后会把整库复制到**系统临时目录**（不是数据库旁边——那可能是上 GB 的意外残留），并在本次运行结束时自动删除。

---

## 用法

### 在 dsh 里（设置页：勾选 + 一键迁移）

打开「设置 → zcode 迁移」：点**侦察**列出 zcode 里的会话（按项目分组、标出已迁移），
勾选要迁的（默认勾好「未迁移」的那批，另有「只选未迁移 / 全选 / 清空」），
决定是否**先预演**（默认开，不写盘），然后点**迁移选中**——按批推进度并逐条给结果。
迁完刷新/重启 dsh，新会话就出现在左侧会话列表里。

**工作区归组**（两件事缺一不可，只做第一件就会看到「迁移完还在未分组」）：dsh 的会话归组靠
工作区记录里的 **`sessionIds`**，**不是**按会话头的 `cwd` 现算 —— 内核只在工作区域**首次**
初始化时按 cwd 自动归组一遍，此后新建的会话必须显式 `attachSession`。所以「登记工作区」做的是：

1. `registry.create(path)` —— 建出工作区（按路径去重，重复点不会建重复的）；
2. `workspace.attachSession(dshSessionId)` —— 把该目录下的会话**挂进去**（幂等）。

真迁之后插件会**自动**对涉及的目录做这两步；已迁过的会话可以点「登记全部工作区」或每个分组头的
「登记工作区」补做（顺带修好历史上「只建了空工作区」的残留）。结果行会报
`工作区已登记 / 会话已归组 / 跳过 / 失败` 四个数。

**目录已不存在的那些**（zcode 历史会话常常指向早就删掉的项目）：侦察时就会标出
`目录已不存在`，这些分组**不显示**「登记工作区」按钮，「登记全部工作区」也只发还在的目录；
万一目录在侦察之后被删掉，宿主会报 `skipped: true`（不是失败）——页面把它按灰字列在
「跳过（目录已不存在）」一栏。也就是说**不存在 ≠ 失败**：登记结果分栏显示，红字只剩真失败。

> 这类会话**没法**归组，不是插件的偷懒：内核的 `create` 与 `attachSession` 都会校验目录真实
> 存在（工作区要拥有一个真实文件夹）。想让它们也进工作区，只有把目录建回来再点一次
> 「登记工作区」。

**每个工作区一键迁移**：每个项目分组头有「全选此组 / 迁移此组（N）/ 登记工作区」——
「迁移此组」直接勾选并迁移该组未迁移的会话，不用先手动勾。

设置页的数据全部走宿主侧 `/zcode-migrate/api/{inspect,migrate,verify,workspaces}`（客户端半不碰
文件系统，该路由只信本机 Host）。

### 在 dsh 里（模型可调用工具）

| 工具 | 作用 |
|---|---|
| `zcode.inspect` | 只读侦察：库总量、按项目分布、待迁移清单、哪些已迁移过 |
| `zcode.migrate` | 执行迁移（按会话幂等，支持 `dryRun`） |
| `zcode.verify` | 回读一个产物，确认可被 dsh 解析 |

### 斜杠命令

dsh 没有命令注册面，本插件用一段系统提示把 `/zcode` 前缀映射到上面的工具：

```
/zcode                      → 列出命令清单
/zcode inspect              → zcode.inspect
/zcode migrate [dryRun]     → zcode.migrate
/zcode migrate --cwd <路径>  → 只迁移某个项目
/zcode migrate --ids <sess_a,sess_b>
/zcode migrate --includeSubagents
/zcode verify <路径>         → zcode.verify
```

### 命令行（不启动 dsh 也能用）

首次批量迁移、CI 或脚本化时更顺手：

```bash
node cli.mjs inspect
node cli.mjs migrate --dry-run
node cli.mjs migrate --cwd "C:\Users\me\Desktop\my-project"
node cli.mjs migrate --include-subagents --limit 50
node cli.mjs verify "<...>/session.jsonl.zstd"
```

---

## 映射规则

| zcode | dsh |
|---|---|
| `session.directory` | 会话头 `cwd` → 决定项目目录 |
| `session.title` | `session/title` 事件（保留标题） |
| `session.parent_id` | 会话头 `parentSession` + `origin: subagent` + `delegationDepth: 1` |
| user 消息 text/file 片段 | `turn/start` → `step/start` → `user/message`（content 为块数组） |
| assistant 消息（一次模型调用） | `assistant/message`（一个 step） |
| `reasoning` 片段 | `reasoning` 内容块 |
| `tool` 片段 | `assistant/message` 里的 `tool-call` 块 **+** 独立的 `tool/call` / `tool/result` 事件对 |
| `message.finish` | `turn/end` 的 reason（`tool-calls` 表示回合继续，不开新的 turn/end） |
| `message.tokens` | `assistant/message` 的 `usage`（camelCase，零值字段省略） |
| `synthetic` / 非 user 来源的 user 消息 | `source: {kind: 'plugin'}`（不冒充人类输入，也不会被标题事件引用） |

**关键顺序**：dsh 要求 `step/start` 在进入该 step 的消息**之前**（真实 dsh 日志即 `turn/start → step/start → user/message → assistant/message`）。顺序错了，dsh 的 v2 格式迁移会报 `cannot acquire a system head without changing chronology` 而拒绝加载。

**工具名映射**：zcode 的 `Bash/Read/Edit/Write/Glob/Grep/Agent/TodoWrite/SendMessage/TaskStop/WebSearch` 会映射到 dsh 实际暴露的工具名（`pwsh/read/edit/write/glob/grep/subagent/todo_write/send_message/interrupt_agent/web_search`），未知工具名原样保留。可用 `toolNameMap: false` 关闭。

---

## 验证

### 已验证到什么程度

在一台真实的开发机上跑了全量：

```
扫描 485 会话 → 迁移 482 / 跳过 3 / 失败 0
事件 532,683 · 消息 110,847 · 工具结果 98,392 · 轮次 16,748 · 体积 298.9 MB（耗时 62 秒）

dsh 校验: 482/482 通过 · 533,165 事件
```

「dsh 校验」指的是**用 dsh 自己的代码**加载每一个产物：

1. **`@deepseek-ai/dsh-session-persistence-jsonl`**（`JsonlSessionPersistence.loadStored`）——dsh 读取会话的正式入口，走它自己的物理编解码路径。
2. **`@deepseek-ai/dsh-session-format-catalog`**——跑完整的 v0→v1→v2→v3 格式迁移链 + 当前格式校验（`validation: 'current'`）。

对照实验：对一个**真实 dsh 原生日志**跑同样的校验，两者的物理头版本（0）、逻辑恢复版本（3）、以及 v2→v3 迁移插入的 `system/message` 行为**完全一致**——即从 dsh 读取器的视角看，迁移产物与原生产物不可区分。

自己复跑：

```bash
node scripts/validate-with-dsh.mjs ~/.dsh/sessions
```

### 单元测试

```bash
npm test        # 70 个测试，覆盖路径规则、帧编解码、事件映射、迁移编排、插件契约、设置页 HTTP 面，以及设置页的真渲染 + 真点击
```

测试用**自建的合成 zcode 数据库**，不依赖你机器上的真实数据。

---

## 设计说明

```
core/          框架无关的迁移逻辑（纯 Node，零第三方依赖）
  paths.js       dsh 目录/文件命名规则（逐字节移植）
  zstdlog.js     dsh 日志物理编解码（帧写入 + 结构化帧扫描）
  zcode.js       zcode SQLite 读取（node:sqlite，只读 + 可选快照）
  convert.js     zcode 消息模型 → dsh 事件流
  migrate.js     编排：筛选 → 转换 → 原子写入 → 回读校验
src/           dsh 插件适配层（薄）
  index.js       Cordis 契约：name / inject / Config / apply
  tools.js       三个模型可调用工具
scripts/       开发期验证工具（依赖 dsh 内部包布局，不参与运行时）
test/          node:test 测试
```

几个刻意的选择：

- **`core/` 不知道 dsh 的存在**。迁移逻辑可以被 CLI、测试或别的主机直接调用，dsh 适配层只是一层壳。
- **写入是原子的**：整份日志先在内存里编码完，写到临时文件再 rename。dsh 的文件监听随时可能读到这个文件，绝不能让它看到写了一半的帧。
- **不往用户目录里丢垃圾**：`snapshot` 开启时快照落在系统临时目录且用完即删——它可能比源库还大，放在 `~/.zcode/cli/db/` 旁边是意外残留。
- **按会话幂等**：zcode id 确定性地映射到 dsh id，重复迁移覆盖同一个文件，不会堆重复会话。
- **不伪造内容**：zcode 里没有对应物的事件类型（如 `timeline`、`compaction` 片段）不硬造 dsh 事件；无内容的 assistant 行（模型切换等）直接跳过，不会凭空产生空轮次。

---

## 已知边界

- **不迁移 zcode 的 compaction 记录**。dsh 有自己的压缩事件模型，语义不能一一对应；迁移的是压缩后的完整转录。
- **不迁移 `input_history` / 未发送草稿 / 用量报表 / todo 历史**。参考仓库的「数据归档」产物在 dsh 侧没有对应落点。这些数据仍可从 zcode 库直接读。
- **不写入 dsh 的 `request/header` 快照**。它是请求期日志，恢复会话时 dsh 会自己生成新的。
- **子代理会话默认不迁移**（数量大且多为噪音），需要时用 `includeSubagents`。
- 迁移产物是**只读历史**：dsh 可以浏览并继续对话，但继续对话产生的新事件会追加到同一个日志里，原 zcode 库不受影响。

---

## License

MIT

## 内置注意事项（改这个插件前必读）

1. **不要给它加回 `dsh.bundle.patch`**：本仓库的启动期同步对 bundle 类插件会主动移除
   loader 行（改走 profile 清单），而这个插件只有「一行 insert」的 patch，走清单不生效 ——
   实测表现为「客户端半（设置页）在，宿主半（工具/命令/路由）全没有」。作为普通配套件
   （与另外 23 个内置件一致）由同步写行加载才是对的。
2. **不要写 `ctx.zcodeMigrate = ...`**：cordis 4 的 ctx 是 Proxy，未声明 provide 就赋属性会抛
   `cannot set property "zcodeMigrate" without provide`，整个宿主半加载失败（内核日志
   `[loader-isolation] entry zcode-migrate ... failed`）。只走 `ctx.provide(...)`；
   `test/plugin.test.mjs` 有一条用 Proxy 复刻该行为的回归锁。
3. 内核日志在 `%APPDATA%dsh-desktoplogs`（**不是** `%APPDATA%DSH Desktoplogs`，
   后者是退役 Electron 线的旧目录）—— 排查加载问题先看那里的 `dsh-web.log`。
