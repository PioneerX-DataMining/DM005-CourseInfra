# DM005-CourseInfra

数据挖掘课程的统一部署控制面（Control Plane）与 EdgeOne Gateway。

## 目标

课程项目保持“一组/一个仓库、独立开发、独立 EdgeOne Project”，但部署规则、项目登记、统一入口和路由由本仓库集中管理。

```text
GitHub repositories
  ├─ DM001-course-hub
  ├─ DM011-Canteen-Commons
  ├─ DM012-Calorie-Calculator
  └─ DM013-BioChemLearn
          │
          ▼
DM005-CourseInfra
  ├─ config/apps.json       # 项目注册表 / 单一事实来源
  ├─ GitHub Actions         # 统一构建和 EdgeOne 部署
  └─ EdgeOne Gateway       # dm.pioneer-x.cn 的路径路由
          │
          ▼
dm.pioneer-x.cn
  ├─ /                              → DM001 Course Hub
  ├─ /projects/canteen-commons/     → DM011
  └─ /projects/biochemlearn/        → DM013
```

## 当前原则

1. **项目仓库不合并**：每个小组继续拥有自己的 GitHub 仓库。
2. **每个可上线项目拥有独立 EdgeOne Project**：互不影响，可单独回滚和预览。
3. **CourseInfra 统一管理部署参数**：仓库、分支、构建命令、产物目录、EdgeOne 项目名、挂载路径都登记在 `config/apps.json`。
4. **统一入口只由 Gateway 占有**：`dm.pioneer-x.cn` 最终绑定 `dm-course-gateway`，Gateway 根据 URL path 重写到各项目的 EdgeOne 域名。
5. **未满足 Base Path 要求的项目不进入统一路径**：项目可先独立部署测试，修复绝对资源路径后再开启路由。

## 注册表

编辑 `config/apps.json` 即可登记新项目。核心字段：

- `id`：课程项目编号，例如 `DM013`
- `repo`：GitHub 仓库
- `branch`：生产分支
- `mount`：统一域名下的路径
- `edgeoneProject`：独立 EdgeOne Makers 项目名
- `deployEnabled`：是否允许 CourseInfra 部署
- `basePathReady`：是否能安全挂在非根路径
- `routeEnabled`：是否已经接入 Gateway
- `origin`：该 EdgeOne Project 的生产域名，例如 `https://xxxxx.edgeone.app`
- `build`：安装命令、构建命令、产物目录

`routeEnabled=true` 时，校验器会要求 `origin` 非空；非根路径还要求 `basePathReady=true`。

## GitHub Actions

### Validate infrastructure

每次修改注册表、脚本或 Gateway 时自动校验配置并重新生成 Middleware，防止路径冲突或错误项目名进入主分支。

### Deploy registered app

在 Actions 中手动选择 `app_id`（例如 `DM001`），CourseInfra 会：

1. 读取注册表；
2. Checkout 对应项目仓库；
3. 执行该项目自己的安装/构建命令；
4. 清理 `.git`、`.github`、`node_modules` 等非发布内容；
5. 使用 EdgeOne CLI 部署到注册表指定的 Makers Project。

官方 CLI 使用方式为：

```bash
edgeone makers deploy <artifact> -n <project-name> -t <token> -e production
```

### Deploy gateway

生成 `gateway/middleware.js` 后，把 `gateway/` 作为独立 EdgeOne Project `dm-course-gateway` 部署。

## 一次性需要人工配置的凭据

本仓库**不保存任何 Token**。在 GitHub Repository / Organization Secrets 中配置：

- `EDGEONE_API_TOKEN`：EdgeOne Makers API Token，用于部署。
- `COURSEINFRA_REPO_TOKEN`：可选。若需要从本仓库的 Action 读取其它**私有**项目仓库，提供一个只读 Contents 权限的 fine-grained GitHub token；全部是公开仓库时可不配。

可选 Repository Variable：

- `EDGEONE_SITE`：`china` 或 `global`，默认 `china`。

## 第一次迁移 DM001 的推荐顺序

1. 配置 `EDGEONE_API_TOKEN`。
2. 运行 **Deploy registered app**，输入 `DM001`。
3. 在 EdgeOne 控制台查看 `dm001-course-hub` 的生产域名。
4. 把该域名填入 `config/apps.json` 的 `DM001.origin`，并把 `routeEnabled` 改为 `true`。
5. 运行 **Deploy gateway**，先用 Gateway 的 EdgeOne 临时域名验证课程主页、Concept 页面、手机端等。
6. 验证通过后，给 Gateway 绑定 `dm.pioneer-x.cn`，最后再切 DNS。

这样迁移期间现有 GitHub Pages 不受影响。

## Base Path 规范

挂在 `/projects/<slug>/` 下的项目，浏览器看到的 URL 前缀不会消失。Gateway 会把该前缀从回源请求中剥离，因此：

- 推荐：`styles.css`、`./styles.css`、相对链接；
- 谨慎：`/styles.css`、`/assets/app.js` 这类从域名根目录开始的绝对路径。

后者会绕过项目自己的 mount，必须修改后才能把 `basePathReady` 设为 `true`。

## Infra 观察页

Gateway 部署后可访问：

```text
https://dm.pioneer-x.cn/__infra/
```

这里仅显示公开的部署元数据与路由状态，不显示 Token 或其它秘密。
