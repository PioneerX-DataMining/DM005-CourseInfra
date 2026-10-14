# 课程项目成员查询（GitHub OAuth）

## 范围

课程主页公开。项目成员详情只向 `PioneerX-DataMining` 的已登录、仍具有有效组织身份的成员提供。
实际实现：`edge-functions/api/course-members.js`，部署后路径 `/api/course-members`。

- `GET ?action=login&id=DM012`：GitHub OAuth 登录
- `GET ?action=callback`：服务端交换授权码、校验用户与组织身份、签发 HttpOnly 会话
- `GET ?action=session`：校验会话和实时组织成员身份
- `GET ?action=project&id=DM012`：读取项目 GitHub Team 与 Direct access 协作者
- `POST ?action=logout`：注销本地会话（同源 Origin 校验）

服务端不会返回学号、真实姓名、邮箱、成绩或 GitHub 访问令牌。
成员查询使用 DM005 部署生成的 `/__infra/apps.json` 作为项目登记来源；客户端不能指定任意 GitHub 仓库。
一个人可能因为组织默认权限、团队、直接授权等原因拥有仓库权限；该目录是 GitHub 协作联系人目录，**不是 AutoLab 正式分组名单**。

## 首次启用（由课程管理员操作）

1. 在 GitHub Settings → Developer settings → OAuth Apps 创建课程 OAuth App。
   - Homepage URL：`https://dm.pioneer-x.cn`
   - Authorization callback URL：`https://dm.pioneer-x.cn/api/course-members?action=callback`
   - 学生登录时仅申请 `read:org`；不申请学生私人仓库访问权限。
2. 在 EdgeOne `dm-course-gateway` 的 **Production 环境变量 / Secrets** 配置：
   - `COURSE_GITHUB_CLIENT_ID`：OAuth App Client ID
   - `COURSE_GITHUB_CLIENT_SECRET`：OAuth App Client Secret，服务端 Secret
   - `COURSE_SESSION_SECRET`：由安全随机数生成的至少 32 字节密钥，服务端 Secret
   - `COURSE_MEMBERS_GITHUB_TOKEN`：教师或课程管理员持有的 GitHub API 服务令牌。
     需要有权查看组织内部成员、项目仓库协作者、关联团队及团队成员。
     优先最小权限 fine-grained PAT（组织 Members: read，仓库 Metadata: read，并由账号具备需要的仓库访问等级）；根据 GitHub API 实际响应核查，不扩大到仓库写入权限除非确需。
3. 配置组织层 OAuth App access restrictions：若组织限制第三方 OAuth App，应批准此 OAuth App。
4. 在 GitHub 创建/核对多人项目的 Team 以及单人项目的 Direct access。组织 owners/仓库 Admin 不显示为“学生成员”的直接授权项。
5. 部署 DM005 后，用两种账号各执行一次端到端检查：有效组织成员可看、非组织账号只能看到拒绝提示；检查浏览器 Network，确保未登录时没有成员列表及 API token。
6. 如果要让学生看到 **正式分组而不是仓库协作者**，仍以 AutoLab 分组为准，不要推断仓库管理权限等于课程分组。

## 安全约束

- OAuth `state` 随机生成，保存在 Secure / HttpOnly / SameSite=Lax Cookie 内，10 分钟过期。
- 回调服务端交换 OAuth code；令牌不写入浏览器本地存储和页面内容。
- 会话 HMAC-SHA256 签名，8 小时过期；每次读接口都会通过 GitHub API 重新核验组织成员身份。
- 成员信息 `Cache-Control: private, no-store`；失败时返回错误，不降级到公开列表。
- Github service token 仅存放 EdgeOne Production Secret，不放 DM001、DM005 仓库或 Actions 构建产物。
- 组织成员即具有查看所有课程项目 GitHub 协作者的权限；若将来需要更细的分组权限，应单独制定政策。

## 注意

本功能**只有在上述 EdgeOne Secrets 和 GitHub OAuth App 配置完毕后才会启用**。
仅提交仓库代码不意味着 GitHub 登录和成员查询已经上线并验收。
