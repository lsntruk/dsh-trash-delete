# 发版流程

**打 tag 即发**：push 一个 `vX.Y.Z` tag，GitHub Actions 会校验版本、跑测试、`npm publish --provenance`，Git 与 npm 一起更新，不用发两次。

## 每次发版

```bash
# 1) 改代码，升 package.json 的 version，在 CHANGELOG.md 记一条
node --check index.js && node --check client.js && node --check session-log.js
node tools/smoke-client.mjs
node tools/smoke-host.mjs ".test-home"      # 需要先准备一份假 DSH_HOME

# 2) 提交推送
git add -A
git commit -m "release: X.Y.Z"
git push

# 3) 打 tag（必须与 package.json 的 version 一致，工作流会强制校验）
git tag -a vX.Y.Z -m "dsh-trash-delete X.Y.Z"
git push origin vX.Y.Z
```

## 一次性准备

### 1. npm 包已存在

Trusted Publishing 无法创建新包，所以**第一次**要手动发：

```bash
npm login
npm publish
```

### 2. 在 npm 绑定 Trusted Publisher

npmjs.com → 该包 → Settings → **Trusted Publisher** → GitHub Actions，填：

| 字段 | 值 |
|---|---|
| Organization or user | `Isntruk` |
| Repository | `dsh-trash-delete` |
| Workflow filename | `release.yml` |
| Environment | 留空 |

填完之后 CI 就能靠 OIDC 发布，仓库里不再需要 `NPM_TOKEN` secret，包页面上还会多一个 provenance 标记（证明这个版本确实由该仓库的该工作流构建）。

### 3. 仓库设置

- Settings → Actions → General → Workflow permissions 保持默认的 *Read repository contents*（工作流只需要 `id-token: write`，它已经在 workflow 文件里单独声明）。
- 不需要任何 secret。

## 手动补发

CI 失败或要补发一个已存在的版本号时：Actions → `release` → **Run workflow**，填一个 `version` 输入（不校验 tag）。工作流里 `npm publish` 前会先查版本是否已存在，已存在就跳过而不是报错——这是为了容忍重跑。

## 常见问题

- **`npm publish` 报 403**：Trusted Publisher 没绑对，或 workflow 文件名与填入的不一致。
- **CI 装了包但 npm 页面看不到**：npm 的元数据走 CDN，刷新缓存有几十秒到几分钟延迟，不是你发失败。
- **tag 与 package.json 不一致**：工作流第 4 步会直接失败，改 package.json 重新提交、删掉 tag 重打即可（`git tag -d vX.Y.Z && git push origin :vX.Y.Z`）。
