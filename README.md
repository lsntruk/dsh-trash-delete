# dsh-trash-delete · 删除会话 / 会话回收站

DSH Web 插件（npm 包名 `dsh-trash-delete`）。只加三个入口：

| 入口 | 位置 | 做什么 |
|---|---|---|
| **删除会话** | 侧栏会话「…」菜单 order 500 | 弹窗里三选一：`永久删除`（归档 → 删目录与派生索引 → 摘 live 条目）/ `移动到回收站`（`rename` 进 `$DSH_HOME/session-trash/`，下次启动 Harness 时清空）/ `取消` |
| **回收站按钮** | 工作区搜索框右边（搜索图标旁） | 列出回收站内容：每行「还原」、底部「清空回收站」「还原全部会话」「完成」 |
| **删除按钮** | 每条回答的动作条，`在新对话中分支` 图标之前 | 二次确认后删掉这条回答（改写 `session.v4.jsonl.zstd`），删完自动刷新页面 |

> 会话菜单里只有「删除会话」一行；没有「删除消息…」这一项 —— 删单条消息的入口在回答自己的动作条上。

## 一、残留索引

Harness 没有公开的「删除会话」API（`sessionPersistence` / `sessions` / `sessionController` / `workspaceRegistry` 都只有 archive），所以文件得自己删。删完之后，所有会「记住这个 id」的地方都要一起收拾，否则侧栏会留下永远打不开的灰行、或者回收站列表里冒出幽灵条目：

```
$DSH_HOME/sessions/<项目 slug>/<sessionId>/                 事件日志目录（session.v4.jsonl.zstd）
$DSH_HOME/storages/session_projcache/sessions/<id>.json      会话投影缓存
$DSH_HOME/storages/workspace.json                            侧栏真实来源：tables.workspaces.<ws>.sessionIds 里的 id
$DSH_HOME/storages/**/*.sqlite|db (+ -wal/-shm/-journal)     宿主派生索引库（存在才删，下次启动自动重建）
```

`scrubIndexes(home, id)` 会遍历 `storages/` 下深度 ≤ 4 的所有 `.json`，递归地把这个 id 从数组元素、对象键、`id` / `sessionId` 属性里抹掉，写 `.tmp-<pid>` 再 `rename` 原子落盘；`removeDerivedDatabases(home)` 清派生数据库；`pruneOrphanCaches` 清没有日志的投影缓存。**删除会话、移入回收站、启动自愈，三条路径都会跑这套清理。**

归档记录单独处理：删完后调 `workspaceRegistry.unarchiveSession(id)`（该 API 刻意不做存在性检查，正是为「记录还在、会话没了」准备的）。Host 改的是磁盘注册表，而侧栏渲染的是浏览器里的快照，所以浏览器半边删完还要自己再调一次 `uiWorkspace.unarchiveSession(id)`，那一行立刻消失。

内存里的会话也要摘：`session.list` 是「持久化 ∪ 活着的」，文件删光了只要还挂在 Host 的 live store 里就照旧会被列出来。`evictLive` 复刻一次真实 dispose：把 entry 从 `ctx.sessions.store`（普通 `Map`）里删掉并广播 `sessions.emitDisposed(entry)`，最后一次落盘会重建目录，所以 120ms 后再擦一遍。最后浏览器 `sessions.refresh()` 重拉基线，行当场消失，不用重启。

`POST /api/session-delete/sweep` 是历史残留的自愈入口：扫归档集，把找不到任何事件日志的 id 摘掉并清索引；每次页面加载跑一次。

## 二、会话回收站

移入回收站不是删文件，而是：

1. `rename` 整个会话目录到 `$DSH_HOME/session-trash/<sessionId>/<项目 slug>/`；
2. 同目录写一份 `trash.json`，记下 `title` / `workspaceId` / `movedAt` / 原来的 `slugs`；
3. 摘归档记录、清 `workspace.json` 里的 id、清投影缓存 —— 侧栏立刻不再显示它。

`会话回收站` 的入口在**工作区搜索框右边**：侧栏那个位置没有插槽可注册，所以客户端把一个 React 根挂到 DOM 注入的容器里 —— 锚点是搜索行里唯一不依赖语言的元素 `input[maxlength="500"]`（宽态下一直在，只是变窄），容器插到它的 `div.search` 所在容器 `div.searchSlot` 之后 —— 也就是搜索框右边、视图选项按钮左边。按钮本身用宿主的 `IconTrashOutlineRegular` 图标和 `Tooltip` 组件，外观与软件其它图标按钮一致。`MutationObserver` + `requestAnimationFrame` 去抖负责在侧栏重渲染后复挂。

回收站对话框标题只有文字（不带图标徽章）。每行右侧是「还原」，底部三个按钮：`清空回收站`（调 `/trash-purge`，立刻永久删除并清残留索引，不可再还原）、`还原全部会话`（调 `/restore-all`）、`完成`。还原时把目录 `rename` 回 `sessions/<slug>/<sessionId>/`，并把 id 用 `addToWorkspaceIndex` 写回 `tables.workspaces.<ws>.sessionIds`，刷新后侧栏可见。

**清空时机**：Harness 启动 2 秒后跑一次 `purgeTrash()` —— 上一次运行留下的回收站内容会被彻底删掉，并把它们的 id 从注册表和索引里再扫一遍。也就是说「下次重启 Harness 后删除回收站里面的会话」是启动自愈的一部分，不需要手动点。

## 三、删除一条回答

界面上的消息来自事件日志的 surface，而 surface **只有 append 和 replace 两种操作**（`dsh-session/lib/index.js` 的 `surfaceOpOf`），replace 只会让模型看不见、界面上照旧显示（`isAppendSurfaceEvent` 的注释写明「a landed replacement would erase conversation the user already saw」）。所以要让消息真从界面上消失，只能改写日志本身。

入口是每条回答动作条里的垃圾桶按钮：它注册在 `conversation.chat.assistant-actions`（order 45，正好排在反馈按钮之后、`在新对话中分支` 之前），拿到的是该轮最后一条助手消息的 `messageId`（裸 uuid）。宿主的路由按 `messageId` 用 `seqOfMessageId` 反查 `seq`，再走下面的改写流程。

`session-log.js` 负责这件事，纯 `node:zlib`：

- `scanZstdFrames` 按 Zstandard 帧结构（magic → frame header descriptor → 3 字节 block header → checksum）遍历；`decodeSessionLog` / `encodeSessionLog` 在「header 单独一帧 + 每 ~64KB 事件行一帧」的布局间互转，每帧都带 checksum，参数与宿主 `CHECKSUM_OPTIONS` 一致。
- 删除一条消息会**级联**处理：助手消息里的 `tool-call` block 连同对应 `tool/call`、`tool/result` 一起删；再迭代删掉所有结构化引用（`surfaceOp.startSeq/endSeq`、`sourceEventSeqs`、`shadowedRange`、`shadowedSeqs`）指向已删行的行；`session/title` 的 `messageSeqs` 过滤掉失效引用；`delivery-accepted.throughSeq` 下移到最近的存活更早行。
- 最后全量稠密重编号 `seq = index`，并把上面这些引用字段一起重映射。

写入顺序：evict live → 读原字节 → 改写 → 备份到 `$DSH_HOME/session-msg-backups/`（保留 20 份）→ 原子发布 → 用 `sessionPersistence.open(id,'read')` + `handle.read()` 让宿主自己做完整校验（`assertReleasedV4Relationships`）。校验不过就用备份回滚并返回 `409 refused-by-host`（`rolledBack: true`）——**宁可拒绝，也不留一个打不开的会话**。

改完之后如果这个会话本来活着（几乎总是：你正在里面点按钮），宿主会用 `agents.resume({ resumeSessionId })` 在新日志上重开会话，响应里带 `resumed`。正在回答时（`agents.get(id).status === 'running'`）直接 `409 session-running` —— 改一个正在写的日志没有意义。页面上显示的对话是 append-only 的本地状态，所以客户端在收到成功响应后 `location.reload()`，重载后那条回答就真的不在了。

`POST /api/session-delete/message-undo` 可以从最近一份备份把日志整体还原（撤销上一次删除）。

## 四、路由

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/api/session-delete/delete` | 彻底删除会话 + 清索引 |
| POST | `/api/session-delete/trash` | 移入回收站 |
| POST | `/api/session-delete/trash-list` | 列出回收站 |
| POST | `/api/session-delete/restore` | 从回收站还原一个会话 |
| POST | `/api/session-delete/restore-all` | 还原回收站里的全部会话 |
| POST | `/api/session-delete/trash-purge` | 立刻清空回收站（永久删除 + 清残留索引） |
| POST | `/api/session-delete/messages` | 列出可删消息 |
| POST | `/api/session-delete/message-delete` | 删除一条消息：给 `seq`，或给 `messageId`（界面走这条） |
| POST | `/api/session-delete/message-undo` | 撤销上一次消息删除 |
| POST | `/api/session-delete/sweep` | 摘掉死归档记录 + 清索引 |
| POST | `/api/session-delete/orphans` | 只清残留索引，不删会话 |
| POST | `/api/session-delete/evict` | 只摘 live 条目，不碰文件 |
| POST | `/api/session-delete/report` | 浏览器写一行报告到 `$DSH_HOME/session-delete.log` |
| GET | `/api/session-delete/debug` | Host 眼里的 `live` / `persisted` / `onDisk` |

写入类路由仅接受同源 POST、`application/json`、8KB 以内的 JSON，且 `sessionId` 必须匹配 `session-[A-Za-z0-9._-]{1,120}`，从不接受调用方给的路径。

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半边：14 条路由 + 启动自愈（清空回收站、摘死归档、清派生库、清孤儿缓存）。 |
| `client.js` | 浏览器半边：一行菜单、一条回答动作、一个 overlay、搜索框旁的回收站按钮，页面加载时触发一次 sweep。 |
| `session-log.js` | 会话日志的手术刀：zstd 帧解析、消息级联删除、seq 重编号、编码回写。 |
| `tools/probe-log.mjs` | 离线探针：对任意日志文件逐条消息试删并校验。 |
| `tools/smoke-host.mjs` | Host 冒烟：在假 DSH_HOME 上跑完整删除 / 回收站 / 还原全部 / 清空回收站 / 消息 / 恢复流程。 |
| `tools/smoke-client.mjs` | Client 冒烟：vm 沙箱里桩掉 React 与 fetch，检查一行菜单、回答动作、两个对话框、三选一按钮、回收站底部按钮，以及注入按钮能否真的挂到搜索框旁。 |
| `locale/*.json` | 插件管理卡片的中英文标题与描述。 |

## 自测

```
node tools/smoke-host.mjs "E:\蓝色大肥鱼正在工作\.test-home"
node tools/smoke-client.mjs
node tools/smoke-startup.mjs "E:\蓝色大肥鱼正在工作\.test-home-2"
node tools/probe-log.mjs "C:\Users\admin\.dsh\sessions\<slug>\<sessionId>\session.v4.jsonl.zstd"
```

## 安装

从 npm 装（发布后）：

```
plugin_manager { action: "install_bundle", target: "dsh-trash-delete@1.3.2" }
```

从本地目录装（开发态）：在 profile 的 `package.json` 里加

```json
"dependencies": { "dsh-trash-delete": "link:E:/蓝色大肥鱼正在工作/dsh-session-delete" },
"dsh": { "profile": { "bundles": [ "...", "dsh-trash-delete" ] } }
```

再让 `node_modules/dsh-trash-delete` 指向该目录（pnpm 的 `link:` 会自己建这个链接）。

Host 半边改动不必重启应用：`plugin_manager { action: "set_plugin", target: "include:session-delete", enabled: false }` 再 `enabled: true` 就会重新加载 Host（浏览器半边刷新页面即可换成新 bundle）。注意这里的目标是 patch 里的行 id `session-delete`，与包名无关，改包名不会改它。

## 兼容性与风险

- 测试于 Host `0.2.1-rc.5`、Node 22.19+/24+（`session-log.js` 用到 `node:zlib` 的 zstd API）。
- `session-log.js` 针对 **format v4** 日志。格式若变，插件会拒绝改写（宿主校验失败即回滚并返回 409），不会留下半坏的日志；但那条回答也就删不掉。
- 侧栏回收站按钮是 DOM 注入，锚点为 `input[maxlength="500"]`；宿主改侧栏结构会导致它消失（不影响其它功能）。
- **永久删除不可撤销**。移动进回收站的会话会在下次启动 Harness 时被清空，那之前可以还原。
