# GitHub 发布工作流（目标规范）

本文档描述本项目**应采用**的 Git + GitHub Actions 发布最佳实践。

当前仓库的实际链路（见 [`PUBLISHING.md`](PUBLISHING.md) 与 [`README.md`](../README.md) 的 Publishing 章节）与此目标存在差距；后续改造应以本文为准。

## 核心原则

**Git 管代码，Tag 管版本，CI 管质量与构建，Release 管对外分发。**

四件事职责分离，不混用。

| 层级 | 职责 | 不应做的事 |
|------|------|------------|
| Git / 分支 | 代码演进与合并 | 不直接承担「发版」语义 |
| Tag | 标记不可变的正式版本 | 不用于日常开发标记 |
| CI | 验证、构建、产出 artifact | 不依赖开发者本机构建 |
| Release | 对外发布与下载入口 | 不让用户去 Actions 页面翻 artifact |

---

## 1. 分支策略

```
main ──────────────────────────────▶ 唯一发布源
  ↑
feature/* / fix/* ── PR ──▶ 合并前必须通过 CI
```

- `main` 上任意 commit 都应是「可发版」状态
- 功能与修复通过 PR 合并，避免直接在 `main` 上堆未验证变更
- 建议为 `main` 启用 branch protection：必须 PR、必须通过 CI、禁止 force push

---

## 2. 版本与 Tag

版本号以仓库根目录 [`VERSION`](../VERSION) 为单一真相源；打 tag 前同步派生元数据：

```bash
npm run version:read
# 编辑 VERSION
npm run version:sync
npm run version:check
```

提交版本变更后打 tag 并推送：

```bash
git tag v$(cat VERSION)
git push origin main --tags
```

规范：

- Tag 打在 `main` 的某个 commit 上，表示「这个点就是该版本」
- Tag 不可变：发布后不要修改或 force 覆盖
- 使用语义化版本：`vMAJOR.MINOR.PATCH`
- Tag 名必须与 `VERSION` 一致（如 `VERSION=0.0.17` → `v0.0.17`）

**Tag 的语义：这是一个正式版本，不是普通 commit。**

---

## 3. GitHub Actions 分层

按事件拆分职责，避免「每次 push 都打发布包」或「发布依赖本地机器」。

### 第一层：质量门禁（PR / push main）

```yaml
on:
  pull_request:
  push:
    branches: [main]
```

执行：lint、test、编译检查。**不产出**对外发布包。

### 第二层：发布构建（仅 tag）

```yaml
on:
  push:
    tags: ['v*']
```

执行：

1. 校验 tag 与 `VERSION` 一致
2. 构建 VSIX、Rider ZIP
3. 上传 artifact（作为 Release 与市场发布的输入）

**原则：只有 tag 才构建正式安装包；不在本地 `vsce package` / `gradlew buildPlugin` 作为发布路径。**

### 第三层：发布分发（Release 创建时）

```yaml
on:
  release:
    types: [published]
```

执行：

1. 将 CI 构建的 artifact 挂到 GitHub Release
2. （可选）同一 artifact 推送到 VS Code Marketplace、Open VSX、JetBrains Marketplace

市场发布 token 存放在 GitHub Secrets，不在仓库或本机配置文件中提交。

---

## 4. GitHub Release

Tag 与 Release 应配套，Release 是用户获取版本的**主入口**。

理想链路：

```
更新 VERSION + CHANGELOG → 打 tag → push tag
                              ↓
                    CI 构建 artifact
                              ↓
              自动创建 GitHub Release（附 VSIX / ZIP）
                              ↓
                    用户从 Release 页面下载安装
```

Release 页面应包含：

- 版本号与 tag 一致
- Changelog（可 `--generate-notes` 或手写）
- 构建产物：`.vsix`、Rider `.zip`
- 简要安装说明（或链接到 README Installation）

**不应**要求用户到 Actions → 某次 run → Artifacts 里手动找包。

---

## 5. 应用市场发布（可选第三层）

若需上架商店，使用**与 Release 相同的 artifact**，避免本地二次打包：

```
tag → CI 构建 → GitHub Release（用户下载）
                    ↓
              同一 artifact → 各应用市场
```

- 在 CI 的 `release` job 或独立 job 中完成市场上传
- 市场发布失败不应回滚已成功的 GitHub Release（可分 job，必要时 `continue-on-error`）
- Secrets：`VSCE_PAT`、`OVSX_PAT`、`JETBRAINS_PUBLISH_TOKEN`

---

## 6. 完整发布流程（操作清单）

维护者按顺序执行：

1. 在分支上完成开发与 PR 合并
2. 更新 `VERSION`、`CHANGELOG.md`，运行 `npm run version:sync` 与 `npm run version:check`
3. 提交并 push 到 `main`
4. 运行 **`python scripts/github_release.py`**（或 `npm run ship`）— 自动从 `VERSION` 推导 tag、推送 tag、等待 CI
5. 确认 GitHub Release：`python scripts/github_release.py release`
6. （可选）应用市场仍走现有流程：`npm run release -- --from-tag v$(cat VERSION)`
7. 本机安装：**仅从 Release 或 CI artifact 安装**，不本地构建发布包

### 辅助命令

```bash
python scripts/github_release.py status    # 查看 VERSION / tag / CI / Release 状态
python scripts/github_release.py tag       # 仅打 tag + push
python scripts/github_release.py wait      # 仅等待 Package workflow
python scripts/github_release.py release   # 从 CI 产物创建 GitHub Release
python scripts/github_release.py --dry-run # 预演
```

`github_release.py` 以 `VERSION` 为 SSOT，版本校验委托 `scripts/version.mjs`；**不**改动 `release.mjs` 市场发布链路。

### 本机安装（维护者自用）

```bash
# 从指定 tag 对应的 Release 资产下载，或：
gh release download v0.0.17

# Cursor / VS Code
cursor --install-extension editor-peer-bridge-vscode-peer-0.0.17.vsix

# Rider：Settings → Plugins → Install Plugin from Disk
```

---

## 7. 硬规则摘要

| 规则 | 原因 |
|------|------|
| 发布包只由 CI 构建 | 环境可复现、与 tag 绑定 |
| Tag 不可变 | 用户信任「vX.Y.Z 即该版本」 |
| PR 必须过 CI 再合并 | 防止坏代码进入 `main` |
| Release 附 artifact | 用户友好、单一下载入口 |
| Changelog 随版本更新 | 可追溯 |
| Secrets 仅用于 CI | 安全 |

---

## 8. 与当前仓库的差距（待改造）

后续实现时可对照勾选：

- [ ] PR / push `main` 增加独立「质量门禁」workflow（test / lint）
- [ ] Tag 构建成功后**自动创建 GitHub Release** 并上传 VSIX / ZIP
- [ ] 应用市场发布迁入 CI（或 tag 构建 job 的下游），减少 `npm run release --from-tag` 本地步骤
- [ ] 文档统一：`PUBLISHING.md` 以「目标流程」为准，标注已废弃的纯本地构建发布路径
- [ ] `main` branch protection 与 `version:check-tag` 在 CI 中强制执行

---

## 9. 一句话

> **PR 验质量，Tag 定版本，CI 构建，Release 分发。**

- **打 tag** → 触发正式构建  
- **GitHub Release** → 对外发布与下载  
- **应用市场** → Release 的延伸，同一 artifact，由 CI 推送  
