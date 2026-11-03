# 变更记录

本文件记录每个版本的可见变化。版本号遵循 semver：破坏性的行为变更走 major，新入口/新能力走 minor，修 bug 走 patch。

## 1.3.2 — 搜索时让位

- 搜索框展开时回收站按钮与清空 × 重叠。现在复用宿主的 `searchSlotExpanded` 状态类：搜索态下按钮收起（`max-width:0` / `opacity:0` / `visibility:hidden`，带 180ms 过渡），与侧栏其它图标行为一致；退出搜索后滑回。

## 1.3.1 — 预留列宽（已废弃）

- 给搜索框展开态预留 38px 列宽以避免重叠，观感上仍像「挤着」，1.3.2 改为整体隐藏。

## 1.3.0 — 六处 UI 打磨

- 删除对话框按钮顺序改为 `永久删除 → 移动到回收站 → 取消`。
- 回收站对话框标题去掉左侧图标，只留文字。
- 所有图标换成宿主的 `IconTrashOutlineRegular` / `IconArchiveOutlineRegular`，与软件其它图标同一套线条与尺寸。
- 悬停提示改用宿主 `Tooltip` 组件（`side:'bottom'`、`delayMs:300`），不再用原生 `title`。
- 回收站对话框底部新增 `清空回收站`（两次点击确认）与 `还原全部会话`。
- 行内按钮文案 `恢复` → `还原`。
- 新增路由 `POST /api/session-delete/restore-all`、`POST /api/session-delete/trash-purge`，共 14 条。

## 1.2.0 — 入口重排

- 会话菜单只留一行「删除会话」；`移动到回收站` 移进删除对话框，三选一：`永久删除 / 移动到回收站 / 取消`。
- 回收站入口挪到工作区搜索框右侧（侧栏该位置没有插槽，用 React 根挂到 DOM 注入的容器，锚点 `input[maxlength="500"]`）。
- 删单条消息从「会话菜单 → 消息列表」改成「每条回答的动作条，`在新对话中分支` 之前」的按钮；删除时用 `messageId` 定位，宿主改写日志后 `agents.resume` 重开会话。
- `POST /api/session-delete/message-delete` 支持 `messageId`，并新增 `session-running` 409（回合进行中拒绝删除）。

## 1.1.0 — 回收站与删消息

- 新增「移动到会话回收站」：`rename` 到 `$DSH_HOME/session-trash/<id>/<slug>/` 并写 `trash.json`，下次启动 Harness 时清空；可逐个还原。
- 新增「删除单条消息」：改写 `session.v4.jsonl.zstd`（surface 的 `replace` 只对模型生效，界面不会隐藏，所以必须动日志），含 zstd 帧解析、工具生命周期级联、seq 重编号、引用重映射、宿主校验、失败回滚与备份撤销。
- 新增 `session-log.js` 与离线探针 `tools/probe-log.mjs`。
- 残留索引清理扩展到派生 sqlite 库。

## 1.0.0 — 删除会话

- 会话菜单加一行「删除会话」。
- 删除不只是删目录：还在 `workspace.json` 的 `tables.workspaces.<ws>.sessionIds`、投影缓存、派生索引库里抹掉这个 id，并摘掉 live store 里的内存条目，避免侧栏留下打不开的灰行。
- 自动自愈：页面加载与 Host 启动时各跑一次残留清扫（`sweep`）。
