# DM005-CourseInfra

数据挖掘课程的统一基础设施仓库：项目注册表（Registry）、统一域名路由（Gateway）和 Base Path 规范。

## 正式部署架构

**日常发布不经过 GitHub Actions。** 每个课程项目直接连接 EdgeOne Makers 的 Git 集成，由 EdgeOne 监听 `main` 分支并自动构建、自动部署；本仓库只维护统一入口和路由。

```text
GitHub repositories
  ├─ DM001-course-hub ─────────────→ EdgeOne Project: dm001-course-hub
  ├─ DM011-Canteen-Commons ────────→ EdgeOne Project: dm011-canteen-commons
  ├─ DM012-Calorie-Calculator ─────→ EdgeOne Project: dm012-calorie-calculator
  └─ DM013-BioChemLearn ───────────→ EdgeOne Project: dm013-biochemlearn
                                         │
                                         │ EdgeOne production origins
                                         ▼
DM005-CourseInfra ──EdgeOne Git Auto Deploy──→ dm-course-gateway
  ├─ config/apps.json
  ├─ scripts/validate-registry.mjs
  ├─ scripts/render-gateway.mjs
  └─ gateway/
                                         │
                                         ▼
                                  dm.pioneer-x.cn
  ├─ /                              → DM001 Course Hub
  ├─ /projects/canteen-commons/     → DM011
  ├─ /projects/calorie-calculator/  → DM012
  └─ /projects/biochemlearn/        → DM013
```

## 原则

1. **一组 / 一个仓库**：项目代码保持独立，不合并到 CourseInfra。
2. **一项目 / 一个 EdgeOne Project**：各项目独立部署、预览和回滚。
3. **EdgeOne 原生 Git Auto Deploy**：`main` 更新后由 EdgeOne 直接发布，不消耗 GitHub Actions 分钟。
4. **统一域名只属于 Gateway**：`dm.pioneer-x.cn` 绑定 `dm-course-gateway`，Gateway 按 URL path rewrite 到项目自己的 EdgeOne 生产域名。
5. **CourseInfra 是控制面，不是 CI 执行器**：它记录项目、路径、Origin 与 Base Path 状态，并生成 Gateway Middleware。
6. **未满足 Base Path 规范的项目不进入统一路径**。

## 注册表

`config/apps.json` 是单一事实来源。核心字段：

- `id`：课程项目编号，例如 `DM013`
- `repo`：GitHub 仓库
- `branch`：生产分支，默认 `main`
- `mount`：在 `dm.pioneer-x.cn` 下的路径
- `edgeoneProject`：独立 EdgeOne Makers 项目名
- `origin`：该项目的 EdgeOne 生产域名，例如 `https://xxxxx.edgeone.app`
- `basePathReady`：是否能安全挂载到非根路径
- `routeEnabled`：是否已经接入 Gateway
- `build`：供文档和应急部署使用的安装、构建、产物目录信息

`routeEnabled=true` 时必须填写 `origin`；非根路径还必须 `basePathReady=true`。

## 每个项目第一次接入 EdgeOne

每个项目只做一次：

1. EdgeOne Makers → 导入 Git 仓库。
2. 选择对应 `PioneerX-DataMining/DMxxx-*` 仓库。
3. Production Branch 选择 `main`。
4. 打开 Auto Deploy。
5. 按项目填写 Build Command / Output Directory。
6. 第一次部署成功后，把 EdgeOne Production Domain 写入 `config/apps.json` 的 `origin`。
7. Base Path 检查通过后，把 `routeEnabled` 设为 `true`。

以后学生只需要正常提交并合并到 `main`，EdgeOne 会自行更新网站。

## DM005 Gateway 在 EdgeOne 的配置

本仓库自身也直接连接 EdgeOne Git 集成：

- Git repository: `PioneerX-DataMining/DM005-CourseInfra`
- Production branch: `main`
- Install command: 留空
- Build command: `npm run build`
- Output directory: `gateway`
- Auto Deploy: 开启

`npm run build` 会先校验注册表，再生成 `gateway/middleware.js` 与 `/__infra/apps.json`，并做 JavaScript 语法检查。只要 `main` 更新，Gateway 就由 EdgeOne 自己重新发布。

## Base Path 规范

挂在 `/projects/<slug>/` 下的项目，浏览器地址会保留这个前缀。项目应优先使用相对资源路径：

```html
<link rel="stylesheet" href="./styles.css">
<script src="./assets/app.js"></script>
```

对于 Vite / React / Vue 等项目，应显式配置生产 `base` 为对应 mount，例如：

```text
/projects/canteen-commons/
```

避免 `/styles.css`、`/assets/app.js` 这类从域名根目录开始的绝对路径，否则会绕过项目自己的 mount。

## GitHub Actions 的角色

GitHub Actions **不参与日常部署**。

仓库中仅保留手动应急工作流：

- `Emergency deploy registered app`
- `Emergency deploy gateway`

只有 EdgeOne Git 集成故障、临时重部署或排障时才手动运行，因此正常课程使用不会持续消耗 Actions 分钟。

## Infra 观察页

Gateway 上线后：

```text
https://dm.pioneer-x.cn/__infra/
```

用于查看公开的项目挂载、Base Path 和路由状态，不包含任何 Token。