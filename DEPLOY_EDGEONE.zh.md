# 部署到 EdgeOne Pages

这个副本直接使用 [Real API Pricing](https://github.com/FeiZhuLulu/real-api-pricing) 的网页、计算逻辑和数据，保留原版布局、中英切换、图表、筛选、详情与下载功能。站名通过 `replica/` 中的构建封装调整，原网站源码保持上游版本。原软件许可证及第三方来源说明仍保留在 `LICENSE` 和 `SOURCES.md`。

网站是静态站点，不需要数据库、服务器函数或模型 API 密钥。请先把整个项目上传到自己的 GitHub 仓库，再在 EdgeOne 中关联这个仓库。

## 首次部署

1. 在 EdgeOne Pages 控制台选择「导入 Git 仓库」，连接 GitHub，并授权访问自己的项目仓库。官方文档部分页面已使用 EdgeOne Makers 名称。
2. 选择自己的仓库和生产分支，通常为 `main`。保持「自动部署」开启。
3. 填写下面的构建设置。如果框架预设自动填写了不同值，以这张表为准。

| 设置 | 值 |
| --- | --- |
| 项目根目录 | 仓库根目录 `./` |
| Node.js | 22，至少 22.12；可选控制台提供的 22.21.1 或更新的 22 版本 |
| 安装命令 | `npm --prefix web ci --ignore-scripts` |
| 构建命令 | `node replica/build.mjs` |
| 输出目录 | `web/dist` |
| 环境变量 | 无需添加 |

4. 开始部署。完成后，打开 EdgeOne 分配的网站地址，检查语言切换、图表筛选、详情与导出。
5. 如有自己的域名，再在控制台绑定。所选加速区域对域名备案的要求，以 EdgeOne 控制台提示为准。

项目根目录需要选仓库根目录，因为网站构建同时读取 `web/` 外的 `data/`、`derived/`、`config/` 和共享脚本。安装命令只安装网站依赖；`--ignore-scripts` 跳过依赖安装时的生命周期钩子，网站自身的数据生成、测试和构建仍正常执行。

要自动接收后续更新，请使用 Git 集成创建项目。EdgeOne 的「直接上传」项目不能直接切换为 Git 自动部署，需要另建 Git 集成项目。

官方说明：[导入 Git 仓库](https://pages.edgeone.ai/document/importing-a-git-repository)、[构建与自动部署设置](https://pages.edgeone.ai/document/build-guide)、[部署方式](https://edgeone.ai/document/70404)。

## 上游自动同步

GitHub Actions 中的 **Sync upstream website** 每小时第 17 分钟检查一次上游 `main`，也支持手动运行。首次上传后，在自己仓库的 Actions 页面确认该工作流已启用。

同步流程如下：

1. 获取上游最新提交，并固定到该提交的 SHA。
2. 从 Git 跟踪的文件对象读取完整源码与数据快照。不会读取源目录的未提交文件，也不会执行上游 GitHub 工作流。
3. 更新自己的副本；仅删除上一次同步清单中已有、而本次上游已删除的文件。
4. 在只有读取权限的独立任务中运行网站依赖安装、`npm --prefix web test` 和 `node replica/build.mjs`。
5. 全部通过后，由另一个任务提交并推送已验证的变更。EdgeOne 的 Git 集成收到生产分支新提交后构建并发布。

以下自有内容受到保护，不会被上游同步覆盖或删除：

- 整个 `replica/` 目录，包括构建封装、同步脚本和上次同步清单。
- 整个 `.github/` 目录，包括本项目自己的检查和同步流程。
- `DEPLOY_EDGEONE.zh.md`、`edgeone.json`、`AGENTS.md`、`.agents/` 和 `.codex/`。
- `.git/`，同步脚本不修改 Git 仓库内部数据。

其余列入 `replica/upstream.json` 的文件由上游管理，包括网页源码、数据、文档及静态图。以后修改站名和其他副本配置，请放在 `replica/` 中；直接修改上游管理的文件会在后续同步时被替换。

如果上游新文件与不在清单中的本地文件冲突、出现符号链接/子模块、路径类型变化或构建不兼容，同步会失败并保留线上已有版本，不会强制发布。`replica/upstream.json` 记录最近一次已采用的上游提交和受管理文件清单。

自动提交使用仓库内置的 `GITHUB_TOKEN`，不需要另外添加 GitHub 或 EdgeOne 密钥。构建任务只有读取权限，具有写入权限的提交任务不运行上游网站代码。若自己的分支保护规则禁止机器人直接推送，需要调整规则，或将流程改成通过拉取请求合并。

GitHub 的内置令牌提交不会再触发另一个基于 `push` 的 GitHub Actions 流程，因此网站测试与构建已放在同步流程本身。EdgeOne 使用外部 Git 集成接收提交；第一次自动同步后，可在 EdgeOne 部署列表确认对应提交已发布。[GitHub 官方令牌行为](https://docs.github.com/en/actions/concepts/security/github_token)

## 手动检查与运行

网页操作：打开自己仓库的 **Actions → Sync upstream website → Run workflow**，选择默认分支运行。同步或构建失败时，也在这里查看日志。

本地先预览变更，不写入任何文件：

```sh
node replica/sync-upstream.mjs --dry-run
```

实际同步并检查网站：

```sh
node replica/sync-upstream.mjs
npm --prefix web ci --ignore-scripts
npm --prefix web test
node replica/build.mjs
```

脚本只应用文件与更新清单，不会自动提交或推送。本地操作应在已保存工作的干净副本中执行，检查通过后再提交到自己的仓库。

开发验证时，可以用另一个本地 Git 仓库的 **HEAD 提交** 代替网络来源，也可指定临时目标目录。来源仓库中尚未提交的修改不会被同步：

```sh
node replica/sync-upstream.mjs --dry-run --source-dir /path/to/upstream
node replica/sync-upstream.mjs --source-dir /path/to/upstream --target-dir /path/to/test-copy
```

目标目录必须已有 `replica/upstream.json`。需要指定 Git 可执行文件时，可设置 `GIT_BIN` 环境变量。

## 定时运行的限制

GitHub 的定时任务可能排队、延迟或被跳过，所以每小时检查不代表即时同步。定时流程仅在默认分支运行；公开仓库连续 60 天没有活动时，GitHub 可能自动停用定时流程。遇到这种情况，在 Actions 中重新启用工作流并手动运行一次即可。默认安排在第 17 分钟，以避开整点高峰。

如果同步验证期间自己又向生产分支提交了修改，最终推送可能因分支已前进而被拒绝。流程不会覆盖你的提交；下一次定时或手动同步会基于新版本重试。

这些限制见 [GitHub 定时工作流官方说明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)。
