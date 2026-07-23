# Editor Peer Bridge 发布手册

> **目标工作流**（GitHub 最佳实践：PR 验质量、Tag 定版本、CI 构建、Release 分发）见 [`GITHUB_RELEASE_WORKFLOW.md`](GITHUB_RELEASE_WORKFLOW.md)。本文档记录**当前**可用的操作步骤；流程自动化改造以后者为准。

## 前置条件

| 市场 | 账号 | Token |
|------|------|-------|
| VS Code Marketplace | Microsoft 账号 + Publisher `shichao402` | Azure DevOps PAT (Marketplace > Manage)，可选 |
| Open VSX Registry | Open VSX 账号 + 同名 namespace | https://open-vsx.org/user-settings/tokens ，可选 |
| JetBrains Marketplace | JetBrains 账号 | https://plugins.jetbrains.com/author/me/tokens |

## 一、更新版本号

根目录 [`VERSION`](../VERSION) 是唯一版本源。改完后同步派生元数据：

```bash
# 编辑 VERSION
npm run version:sync
npm run version:check
```

同时更新 [`CHANGELOG.md`](../CHANGELOG.md)（以及 marketplace 侧的 `vscode-peer/CHANGELOG.md` / Rider `plugin.xml` change-notes）。

## 二、提交代码后打 Tag / GitHub Release

工作树干净且已与 `origin` 同步后：

```bash
npm run ship -y
# 等价于: python scripts/github_release.py ship -y
```

这会：校验版本 → 打 `v$(cat VERSION)` → 推送 tag → 等待 `Package` workflow →（可选后续）创建 GitHub Release。

创建 GitHub Release（从 CI artifact）：

```bash
python scripts/github_release.py release -y
```

## 三、全渠道市场发布

从 CI 打包产物发布（推荐），不要依赖本机构建：

```bash
npm run release -- --from-tag v$(cat VERSION)
```

会尝试：

- VS Code Marketplace（需 `VSCE_PAT` / `release.config.json` 的 `vscode.pat`；缺 token 则跳过）
- Open VSX（需 `OVSX_PAT` / `openvsx.pat`；缺 token 则跳过）
- JetBrains Marketplace（需 `JETBRAINS_PUBLISH_TOKEN` / `rider.token`）

本地 dry-run：

```bash
npm run release -- --from-tag v$(cat VERSION) --dry-run
```

## 四、本机构建（调试用）

### VS Code 扩展

```bash
cd vscode-peer
npm install
npm run compile
npx @vscode/vsce package
```

产物：`vscode-peer/editor-peer-bridge-vscode-peer-x.x.x.vsix`

### Rider 插件

需要 JDK 17+。优先用项目 Gradle Wrapper：

```bash
cd rider-peer
./gradlew buildPlugin
```

产物：`rider-peer/build/distributions/editor-peer-bridge-rider-x.x.x.zip`

## 五、发布检查清单

- [ ] `VERSION` 已更新，且 `npm run version:sync` / `version:check` 通过
- [ ] CHANGELOG / marketplace README / protocol README 已与行为对齐
- [ ] 代码已提交并推送到主线
- [ ] `npm run ship`（或手动 tag）已触发 `Package` workflow 且成功
- [ ] GitHub Release 已创建（如需要）
- [ ] `npm run release -- --from-tag v…` 已发布到已配置的市场渠道
- [ ] Rider / VS Code / Cursor / CodeBuddy 侧能装上新版本

## 关键文件

| 文件 | 用途 |
|------|------|
| `VERSION` | 发布版本单一真相源 |
| `vscode-peer/package.json` | VS Code 扩展元数据、版本号 |
| `rider-peer/build.gradle.kts` | Rider 插件构建配置、版本号、兼容范围 |
| `rider-peer/src/main/resources/META-INF/plugin.xml` | Rider 插件描述、change-notes |
| `vscode-peer/.vscodeignore` | VSIX 打包排除规则 |
| `CHANGELOG.md` | 版本历史 |
| `shared/protocol/README.md` | 跨 IDE 行为约定 |
| `release.config.json` | 本机发布 token（gitignore） |
| `LICENSE` | MIT 许可证 |

## 插件 ID

- VS Code: `editor-peer-bridge-vscode-peer`（package.json name）
- JetBrains: `com.editorpeerbridge.bridge`（plugin.xml id）
- Publisher: `shichao402`
