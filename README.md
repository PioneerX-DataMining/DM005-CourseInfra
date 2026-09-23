# DM005-CourseInfra

数据挖掘课程的统一部署仓库。正式架构不依赖 EdgeOne 的 GitHub Connector，而是由 **public 的 DM005 GitHub Actions 集中构建**，再通过 EdgeOne CLI 把完整课程站点部署到一个 EdgeOne Makers Project。

## 正式架构

```text
DM001 / DM011 / DM012 / DM013 / ...
独立 GitHub 仓库（可以 public，也可以 private）
                │
                │ GitHub Organization Webhook（main push）
                ▼
EdgeOne Function: /api/course-webhook
                │
                │ repository_dispatch
                ▼
DM005-CourseInfra（public）
GitHub Actions 标准 runner
                │
                ├─ 核对已发布项目 commit
                ├─ 拉取各项目源码
                ├─ 按各项目自己的命令构建
                ├─ 按 mount 拼成一个完整站点
                │
                ▼
        EdgeOne CLI deploy
                │
                ▼
EdgeOne Project: dm-course-gateway
                │
                ▼
          dm.pioneer-x.cn
  ├─ /                              → DM001
  ├─ /projects/dm011/               → DM011（private，配置读取 Token 后启用）
  ├─ /projects/dm012/               → DM012
  └─ /projects/dm013/               → DM013
```

EdgeOne 不需要连接任何 GitHub 仓库，也不负责项目源码构建。它负责 Webhook 接收、成品托管、CDN 和自定义域名。

## 自动部署

正常触发路径是 Webhook：课程组织内任一仓库的 `main` 有 push 后，组织 Webhook 调用 `/api/course-webhook`。接收端验证 GitHub HMAC-SHA256 签名后，触发 DM005 的 `repository_dispatch`。

DM005 收到事件后仍会核对注册表中已发布项目的真实 commit；如果变化来自未发布项目，或发生重复 Webhook 投递，则不会重复部署。

另保留每 30 分钟一次的 reconciliation 检查作为兜底，防止某次 Webhook 丢失或部署失败。`config/apps.json`、Webhook 函数或部署脚本自身更新时会立即强制部署，也可以从 Actions 手动运行。

DM005 自己的 push 会被 Webhook 接收端忽略，避免 `state/deployments.json` 更新导致循环部署。

### 并发与卡死策略

CourseInfra 使用固定 concurrency group，并采用 `cancel-in-progress: false`：

- 任意时刻只允许 1 个生产部署真正运行；
- 当前部署运行期间出现多个仓库 push 时，GitHub Actions 只保留最新的 pending 任务；
- 当前部署完成后，pending 任务会重新读取所有已注册仓库的最新 `main` SHA，因此中间提交无需逐个发布；
- 不主动取消已经进入 EdgeOne 发布阶段的任务，避免 GitHub 取消而 EdgeOne 云端仍继续发布所造成的重叠部署；
- 整个 deploy job 有 15 分钟总超时，EdgeOne 发布步骤有 12 分钟进程上限；
- EdgeOne 发布命令不做自动重复 deploy。因为本地超时不代表远端部署已经停止，重复调用可能创建多个生产部署；
- 每 30 分钟的 reconciliation 会检查 `state/deployments.json` 与各仓库最新 SHA；如果不一致，则自动补一次最新状态部署。

因此设计目标不是“每个 commit 都上线”，而是“并发提交最终收敛到最新站点状态”。

## Secrets 与权限

DM005 GitHub Actions Secrets：

- `EDGEONE_API_TOKEN`：上传构建产物到 EdgeOne。
- `COURSEINFRA_REPO_TOKEN`：只有启用 private 项目发布时才需要；fine-grained PAT 对相应课程仓库授予 `Contents: read`。

EdgeOne Project `dm-course-gateway` 环境变量：

- `GITHUB_WEBHOOK_SECRET`：GitHub Organization Webhook 的共享 Secret。
- `GITHUB_DISPATCH_TOKEN`：fine-grained PAT，仅需对 `PioneerX-DataMining/DM005-CourseInfra` 授予 `Contents: write`，用于调用 GitHub Repository Dispatch API。

Token 不写入仓库。DM005 是 public，但学生项目可以继续 private；真正运行构建的是 public DM005 的标准 GitHub-hosted runner。

## Organization Webhook 一次性配置

在 GitHub 组织 `PioneerX-DataMining` 的 Settings → Webhooks 中只需要创建一个 Webhook：

```text
Payload URL: https://dm.pioneer-x.cn/api/course-webhook
Content type: application/json
Secret: 与 EdgeOne 的 GITHUB_WEBHOOK_SECRET 完全一致
Events: Push events
Active: enabled
```

接收端只处理：

- `PioneerX-DataMining` 组织内的仓库；
- `refs/heads/main`；
- 非 DM005 自身的 push。

其他事件、分支和组织会直接返回 ignored。

## 项目注册表

`config/apps.json` 是单一事实来源。主要字段：

- `id`：项目编号，如 `DM013`
- `repo`：GitHub 仓库
- `branch`：生产分支，通常是 `main`
- `mount`：最终在 `dm.pioneer-x.cn` 下的目录
- `publishEnabled`：是否纳入正式站点
- `basePathReady`：是否已经适配非根目录部署
- `privateRepo`：源仓库是否 private
- `build.install`：安装命令
- `build.command`：构建命令
- `build.output`：最终静态文件目录

当前：DM001 发布到 `/`；DM012 发布到 `/projects/dm012/`；DM013 发布到 `/projects/dm013/`；DM011 已重置为占位页，但仓库为 private，配置 `COURSEINFRA_REPO_TOKEN` 后即可启用。

## Base Path 规范

学生项目统一使用编号路径 `/projects/dmNNN/`，项目必须适配自己的子目录。静态项目优先使用相对路径：

```html
<link rel="stylesheet" href="./styles.css">
<script src="./assets/app.js"></script>
```

Vite / React / Vue 项目应配置对应的生产 base，例如 DM011 使用 `/projects/dm011/`。不要直接使用 `/styles.css`、`/assets/app.js` 这类从域名根目录开始的资源路径。

## EdgeOne

整个课程网站只需要一个 EdgeOne Makers Project：`dm-course-gateway`。GitHub Actions 使用 CLI 直接上传已经组装好的目录：

```bash
edgeone makers deploy <assembled-site> \
  -n dm-course-gateway \
  -t "$EDGEONE_API_TOKEN" \
  -e production \
  --site china
```

手工构建目录中同时包含 `edge-functions/`，因此 Webhook Receiver 会和课程站点一起发布。EdgeOne 官方支持在直接上传产物中携带 Makers Functions。

最终只把 `dm.pioneer-x.cn` 绑定到 `dm-course-gateway`。

## Infra 状态页

每次构建都会生成：

```text
/__infra/
/__infra/apps.json
```

用于查看当前上线的项目、路径和 commit，不包含任何 Secret。状态页还会显示本次构建时间、上一次成功部署时间、本次发生变化的项目，以及当前的单通道部署策略。
