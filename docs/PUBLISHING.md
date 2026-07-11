# Editor Peer Bridge 发布手册

> **目标工作流**（GitHub 最佳实践：PR 验质量、Tag 定版本、CI 构建、Release 分发）见 [`GITHUB_RELEASE_WORKFLOW.md`](GITHUB_RELEASE_WORKFLOW.md)。本文档记录**当前**可用的操作步骤；流程自动化改造以后者为准。

## 前置条件

| 市场 | 账号 | Token |
|------|------|-------|
| VSCode Marketplace | Microsoft 账号 + Publisher `shichao402` | Azure DevOps PAT (Marketplace > Manage) |
| JetBrains Marketplace | JetBrains 账号 | https://plugins.jetbrains.com/author/me/tokens |

## 一、更新版本号

同时改这两处，保持一致：

```
vscode-peer/package.json        → "version": "x.x.x"
rider-peer/build.gradle.kts     → version = "x.x.x"
```

## 二、构建

### VSCode 扩展

```bash
cd vscode-peer
npm run compile
npx @vscode/vsce package
```

产物：`vscode-peer/editor-peer-bridge-vscode-peer-x.x.x.vsix`

### Rider 插件

需要 JDK 17+ 和 Gradle 9+（`IntelliJ Platform Gradle Plugin 2.x` 要求）。如果使用项目内置工具：

```bash
cd rider-peer

JAVA_HOME="../.tools/jdk/jdk-21.0.10+7" \
PATH="../.tools/jdk/jdk-21.0.10+7/bin:$PATH" \
"../.tools/gradle/gradle-9.5.0/bin/gradle" \
--no-daemon buildPlugin
```

产物：`rider-peer/build/distributions/editor-peer-bridge-rider-x.x.x.zip`

## 三、发布

### VSCode Marketplace

```bash
cd vscode-peer

# 首次登录（只需一次）
npx @vscode/vsce login shichao402
# 粘贴 Azure DevOps PAT

# 发布
npx @vscode/vsce publish
```

PAT 获取：
1. https://dev.azure.com → User Settings → Personal access tokens
2. Scopes: Marketplace > Manage

### JetBrains Marketplace

```bash
cd rider-peer

JAVA_HOME="../.tools/jdk/jdk-21.0.10+7" \
PATH="../.tools/jdk/jdk-21.0.10+7/bin:$PATH" \
JETBRAINS_PUBLISH_TOKEN="your_token_here" \
"../.tools/gradle/gradle-9.5.0/bin/gradle" \
--no-daemon publishPlugin
```

Token 获取：https://plugins.jetbrains.com/author/me/tokens

**注意**：第一次必须在 https://plugins.jetbrains.com/plugin/add 手动上传 ZIP。之后才能用命令行。

## 四、提交 & 推送

```bash
git add -A
git commit -m "Release vx.x.x"
git push
```

## 五、发布检查清单

- [ ] 版本号已更新（package.json + build.gradle.kts）
- [ ] CHANGELOG.md 已更新
- [ ] VSCode 编译通过
- [ ] Rider 构建通过
- [ ] VSCode Marketplace 发布成功
- [ ] JetBrains Marketplace 发布成功
- [ ] Git commit + push

## 关键文件

| 文件 | 用途 |
|------|------|
| `vscode-peer/package.json` | VSCode 扩展元数据、版本号 |
| `rider-peer/build.gradle.kts` | Rider 插件构建配置、版本号 |
| `rider-peer/src/main/resources/META-INF/plugin.xml` | Rider 插件描述、vendor 信息 |
| `vscode-peer/.vscodeignore` | VSIX 打包排除规则 |
| `CHANGELOG.md` | 版本历史 |
| `README.md` | 项目文档 |
| `LICENSE` | MIT 许可证 |

## 插件 ID

- VSCode: `editor-peer-bridge-vscode-peer`（package.json name）
- JetBrains: `com.editorpeerbridge.bridge`（plugin.xml id）
- Publisher: `shichao402`
