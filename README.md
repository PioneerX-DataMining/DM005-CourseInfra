# DM005-CourseInfra

数据挖掘课程的统一部署仓库。正式架构不再依赖 EdgeOne 的 GitHub Connector，而是由 **public 的 DM005 GitHub Actions 集中构建**，再通过 EdgeOne CLI 把完整课程站点部署到一个 EdgeOne Project。

## 正式架构

```text
DM001 / DM011 / DM012 / DM013 / ...
独立 GitHub 仓库（可以 public，也可以 private）
                │
                │ DM005 每 10 分钟检查是否有新 commit
                ▼
DM005-CourseInfra  (public)
GitHub Actions 标准 runner
                │
                ├─ 拉取各项目源码
                ├─ 按各项目自己的命令构建
                ├─ 按 mount 拼成一个完整静态站点
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
  ├─ /projects/canteen-commons/     → DM011（启用后）
  ├─ /projects/calorie-calculator/  → DM012（启用后）
  └─ /projects/biochemlearn/        → DM013
```

EdgeOne 不需要连接任何 GitHub 仓库，也不负责构建。EdgeOne 只接收已经构建好的站点文件并负责托管、CDN 和自定义域名。

## 为什么 DM005 要 public

标准 GitHub-hosted runner 在 public repository 中不消耗私有仓库 Actions 分钟额度。DM005 只包含部署规则、项目注册表和脚本，不保存任何明文 Token。

Secrets 仍然只存在于 GitHub Actions Secrets：

- `EDGEONE_API_TOKEN`：上传构建产物到 EdgeOne。
- `COURSEINFRA_REPO_TOKEN`：仅当启用 private 项目发布时需要；使用 fine-grained PAT，只授予对应课程仓库 `Contents: read`。

私有学生仓库本身不需要运行 GitHub Actions，因此不会因为日常 push 消耗它们的 Actions 分钟。

## 自动部署

`.github/workflows/deploy-site.yml` 有三种触发方式：

1. 每 10 分钟自动检查一次已启用项目的生产分支；只有发现新 commit 才重新构建和部署。
2. `config/apps.json` 或部署脚本发生变化时立即部署。
3. 必要时可从 GitHub Actions 手动运行。

每次成功部署后，DM005 会更新 `state/deployments.json`，记录各项目已经上线的 commit。下一轮没有变化时会直接跳过。

当 DM005 仍为 private 时，部署 job 会直接跳过，不占用 private runner 分钟；把仓库切成 public 后自动开始工作。

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

当前：

- DM001 → `/`，已启用
- DM013 → `/projects/biochemlearn/`，已启用
- DM011 → 暂未启用；需要先修复 `/styles.css` 等根绝对路径
- DM012 → 暂未启用；当前没有可发布内容

## Base Path 规范

挂在 `/projects/<slug>/` 下的项目必须适配该路径。静态项目优先使用相对路径：

```html
<link rel="stylesheet" href="./styles.css">
<script src="./assets/app.js"></script>
```

Vite / React / Vue 项目应配置对应的生产 base，例如：

```text
/projects/canteen-commons/
```

不要直接使用 `/styles.css`、`/assets/app.js` 这类从域名根目录开始的资源路径。

## EdgeOne

整个课程网站只需要一个 EdgeOne Makers Project：

```text
dm-course-gateway
```

GitHub Actions 使用：

```bash
edgeone makers deploy <assembled-site> \
  -n dm-course-gateway \
  -t "$EDGEONE_API_TOKEN" \
  -e production \
  --site china
```

如果项目不存在，CLI 可在首次部署时创建。EdgeOne 不需要绑定 GitHub 仓库。

最终只把自定义域名：

```text
dm.pioneer-x.cn
```

绑定到 `dm-course-gateway`。

## Infra 状态页

每次构建都会在成品站点中生成：

```text
/__infra/
/__infra/apps.json
```

用于查看当前上线的项目、路径和 commit，不包含任何 Secret。
