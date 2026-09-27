# 班级网站

面向班级自建的全栈网站源码：Vue 3 + NestJS，包含动态、公告、私有相册、论坛、知识库与 RAG 问答、题库与 AI 简答判分、每日一练、学时统计和管理后台。

本仓库是完整可自建的开源源码，部署时创建独立数据库，并由部署者设置首位管理员。

2026-09-27 更新：同步独立课程进度、题目主题校正与配图、每日一练内测用户、人工重建截止时间修复和答题结果题号标红；移除旧 AI 出题入口，保留历史数据模型。年鉴模块不包含在本次同步中。详见 [每日一练与升级说明](docs/DAILY_PRACTICE.md)。

**注意：它不是不需要后端的静态网站，也不能直接部署到 GitHub Pages。**

本仓库在本地完成了类型检查、生产构建、Prisma Client 生成、OpenAPI / 迁移 / 管理员初始化回归、部署安全测试、依赖审计、Compose 结构校验、发布扫描和桌面 / 手机 / 平板 GUI 检查，详见 [验证说明](docs/VALIDATION.md)。Linux 容器中的首次安装、真实 COS / AI / Embedding 账户接入与完整业务验收，按 [第 5 节](#5-首次登录与业务验收) 清单在部署时执行。

## 1. 源码结构

```text
class-site/
├─ apps/
│  ├─ api/                       NestJS REST 服务（全局前缀 /api/v1）
│  ├─ web/                       Vue 3 + Vite 前端
│  └─ worker/                    Node 后台任务进程
├─ packages/
│  ├─ contracts/                 共享类型、DTO 契约与 OpenAPI 文档
│  ├─ ai-core/                   AI 供应商调用、重试与提示词基础能力
│  ├─ knowledge-core/            知识库解析、H2 分块与 embedding 批处理
│  ├─ media-core/                媒体存储抽象（本地 / COS）与图像处理
│  ├─ quiz-core/                 题库、错题与练习领域逻辑
│  ├─ daily-practice-core/       每日一练状态机、选题、提示词与时间规则
│  └─ daily-practice-prisma/     每日一练的 Prisma 读写适配
├─ infra/                        首次安装、发布控制、镜像与反向代理配置
├─ docs/                         使用指南与验证说明
├─ sc/                           Vite 公共静态资源
├─ package.json                  工作区脚本入口
├─ pnpm-workspace.yaml           pnpm 工作区定义
├─ tsconfig.base.json            共享 TypeScript 严格模式基线
├─ .env.example                  本地开发配置样例（无真实值，仅供参考）
├─ SECURITY.md                   数据与安全边界
└─ LICENSE                       MIT 许可证
```

### 1.1 `apps/api`：REST 服务

NestJS 应用，监听 `PORT`（默认 3000），全局前缀 `api/v1`，Swagger 文档挂在 `/api/docs`。入口为 `src/main.ts`，模块装配在 `src/app.module.ts`，运行配置校验在 `src/runtime-config.ts`。

| 模块 | 职责 |
| --- | --- |
| `auth/`、`users/` | 邀请码注册、登录会话、CSRF、成员审批与角色 |
| `news/`、`announcements/` | 动态（含富文本与媒体）与公告、已读状态 |
| `albums/`、`media/` | 私有相册、展示图与原图、上传准入、图像处理、导出限流 |
| `forum/` | 论坛帖子与回复 |
| `knowledge/` | 知识库、版本、导入、阅读与向量检索（权限与容量约束在服务层） |
| `quiz/` | 题库、CSV / ZIP 导入、练习提交与 AI 简答判分 |
| `daily-practice/` | 独立课程进度、题目主题匹配、每日计划、内测权限与教学修订 |
| `credit-hours/` | 学时申报、凭证复核（含 AI 复核）、导出与批次 |
| `ai/` | RAG 问答、Embedding 调用与配额；每日计划和课程匹配复用调用网关 |
| `storage/` | 对象存储读写（本地目录或 COS） |
| `subjects/`、`database/`、`common/` | 学科章节、Prisma 服务、守卫、审计与 keyset 分页 |

`prisma/schema.prisma` 定义全部数据模型，`prisma/migrations/` 含 28 个正式 SQL 迁移，`prisma/seed.ts` 只负责管理员初始化路径。`scripts/` 是运维自检脚本（媒体、向量、AI 出题来源、taxonomy 审计），按需手动运行。

### 1.2 `apps/web`：前端

Vue 3 + Vite 单页应用，路由在 `src/router.ts`：`/`、`/login`、`/news`、`/announcements`、`/albums`、`/forum`、`/knowledge`、`/quiz`、`/daily`、`/credit-hours`、`/admin` 与 404 兜底。页面在 `src/views`，分组组件在 `src/components`（`layout`、`home`、`news`、`announcements`、`album`、`forum`、`knowledge`、`quiz`、`daily`、`credit-hours`、`admin`、`common`），状态在 `src/stores`（认证、公告），请求与领域工具在 `src/lib`（`api`、SSE、Markdown 渲染、格式化、标签），复用逻辑在 `src/composables`，样式在 `src/styles`。

### 1.3 `apps/worker`：后台任务

独立 Node 进程，与 API 分离部署，负责：知识库导入、渲染与索引补偿（`knowledge-*.ts`）、题库 CSV / ZIP 导入（`quiz-import*.ts`）、课程主题匹配（`curriculum-matching.ts`）、每日一练生成与调度（`daily-practice-*.ts`）、学时凭证 AI 复核（`credit-hour-review.ts`）、媒体与业务生命周期清理（`lifecycle-cleanup.ts`、`knowledge-photo-cleanup.ts`）、AI 调用网关（`ai-invocation-gateway.ts`）和本地存储适配（`local-storage.ts`）。

### 1.4 `packages/`：共享包

`contracts` 提供跨端类型与 `openapi.yaml`（API 契约的结构化解析在 `infra/tests/openapi.spec.mjs` 校验）；`ai-core` 封装供应商调用与重试；`knowledge-core` 负责 Markdown 解析、分块和 embedding 批处理；`media-core` 抽象本地 / COS 存储与图像处理；`quiz-core` 与 `daily-practice-core`、`daily-practice-prisma` 承载练习领域逻辑，被 API 与 Worker 共同复用。

### 1.5 `infra/`、`docs/`、`sc/` 与根文件

| 路径 | 用途 |
| --- | --- |
| `infra/deploy.py` | Linux 首次安装与日常运维：`init`、`check`、`up`、`resume`、`status`、`stop`、`start` |
| `infra/check-release.mjs` | 发布前自检：文件类型白名单、秘密 / 私网地址 / 个人路径 / 身份号码模式与符号链接 |
| `infra/runtime.env.example` | 生产运行时非秘密默认值；真实秘密由 `init` 写入私有配置目录 |
| `infra/Dockerfile.backend`、`infra/Dockerfile.web`、`infra/nginx.conf` | API / Worker 与 Web 镜像、HTTPS 反向代理 |
| `infra/tests/` | 部署安全、迁移、bootstrap 与 OpenAPI 的巡检脚本（`*.spec.mjs`、`deploy.test.py`） |
| `docs/VALIDATION.md` | 本地验证范围与部署时需自行验证的清单 |
| `docs/KNOWLEDGE_BASE_FILE_AUTHORING_GUIDE.md` | 知识库导入文件的编写与发布流程 |
| `sc/` | Vite `publicDir`，内容对任何访问者可见，只放可公开的图标等资源 |

## 2. 运行环境与依赖服务

推荐一台独立 Linux x86_64 服务器，8 GiB 内存起、至少 30 GiB 可用磁盘，并为原文件、备份和对象存储另留容量。

服务器需要：

- Docker Engine 和 Docker Compose **2.30.0 或更高版本**；使用本机默认 Docker context。
- Python 3.10+、Node.js 22、OpenSSL、curl、系统 CA 证书。Node 用于发布文件检查，应用构建在容器内完成。
- 自己的域名，DNS 指向此服务器；可用且与域名匹配的完整 TLS 证书链和未加密私钥。
- 网络能够下载基础镜像与 npm 依赖，并连接以下服务。

完整生产运行必须配置这些自有服务：

| 服务 | 当前代码约束 | 费用和数据范围 |
| --- | --- | --- |
| 腾讯云 COS | 独立私有桶、区域、HTTPS 签名访问端点及限权子账号 | 处理图、相册原图、学时凭证原图；配置上传与读写所需权限，保持匿名访问被拒绝 |
| DeepSeek | `AI_PROVIDER=deepseek`，`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` | 问答、评分、课程匹配、每日练习及学时凭证复核；部署前确认账户支持这些模型和文件接口 |
| 智谱 Embedding | `EMBEDDING_PROVIDER=zhipu`，`embedding-3`，1024 维 | 将获准外发的教材片段及查询转为向量；API 基础地址由部署者填写 |
| MySQL / Qdrant | 安装脚本创建独立容器和空数据卷 | MySQL 保存业务记录，Qdrant 保存知识向量；均不发布宿主端口 |

当前不是任意模型供应商通用适配版，生产校验不允许把 AI/Embedding 改成 mock，也不允许用数据库 BLOB 替代 COS。所列实验模型能否申请、是否继续可用，取决于供应商与账户权限。没有这些条件时可阅读源码、运行单元测试和前端替身预览。

## 3. 缺少部分服务时的可用功能

生产模式（`NODE_ENV=production`）启动时会校验全部外部服务配置，MySQL、COS、DeepSeek、智谱 Embedding 和 Qdrant 缺任一项都会拒绝启动。下表说明的是运行期某个服务中断，或开发模式未接入某个服务时，网站实际还能使用哪些功能。

| 缺少 / 中断的服务 | 受影响的功能 | 仍可正常使用 |
| --- | --- | --- |
| 智谱 Embedding、Qdrant | 知识库向量检索、RAG 问答与引用跳转；知识导入的向量化入库阶段 | 动态、公告、相册、论坛、知识库正文阅读、题库与练习、每日一练、学时统计与人工复核、管理后台 |
| DeepSeek AI | RAG 问答、AI 简答判分、课程自动匹配、学时凭证 AI 复核（复核任务保留并自动重试） | 客观题练习、题库导入、每日一练（对已有有效主题匹配的题目使用确定性选题并记录降级原因）、学时申报与管理员人工复核 |
| 腾讯云 COS | 新上传的相册原图与展示图、学时凭证图片 | 全部文字类功能；开发模式可改用 `MEDIA_STORAGE_PROVIDER=database` 与本地文件存储 |
| MySQL | 全部业务功能 | 无 |

开发模式（`NODE_ENV=development`）不强制这些服务齐全，可用 `AI_PROVIDER=mock`、`EMBEDDING_PROVIDER=mock`、`MEDIA_STORAGE_PROVIDER=database`、`STORAGE_PROVIDER=local` 在本地跑通流程；mock 只用于联调，不代表真实模型或存储行为。知识库检索与导入仍需可用的 Qdrant。

## 4. 首次安装

将本源码目录放到新服务器，例如 `/opt/class-site`。不要带入你已有站点的 `.env`、数据卷或备份。不要在已经承载其他站点的数据库上执行首次初始化。

下面命令中的域名、证书路径由部署者替换，命令不含密码。证书与私钥应位于源码目录之外。

```bash
cd /opt/class-site
node infra/check-release.mjs

sudo python3 infra/deploy.py init \
  --host class.yourschool.edu \
  --certificate /etc/letsencrypt/live/class.yourschool.edu/fullchain.pem \
  --private-key /etc/letsencrypt/live/class.yourschool.edu/privkey.pem

sudo python3 infra/deploy.py check
sudo python3 infra/deploy.py up
sudo python3 infra/deploy.py status
```

`init` 在终端交互读取 COS / AI / Embedding 配置和你指定的管理员身份、密码，秘密输入不回显。请提前将管理员密码保存在自己的密码管理器。数据库密码、数据库 root 密码、32 字节学生标识加密密钥和 Qdrant key 使用系统安全随机数单独生成，互不复用。注册页面仍称登录标识为“学号”，但管理员可以使用非真实学号的站点专用标识。

默认私有配置目录为 `/etc/class-site`，父目录须由 root 管理且不可被其他用户写入；目录权限 0700，内部环境文件和 TLS 文件 0600。此目录必须位于 Git 仓库之外。可以为每一步附加相同的 `--state-dir /etc/another-class-site` 使用其他位置。

`check` 检查本机 Docker、Compose 版本、证书有效期、域名和公私钥配对，以及 Compose 结构。`up` 执行以下顺序：

1. 拒绝接管同名现有容器、网络或数据卷，登记此次首次安装状态。
2. 从源码构建 API/Worker 和 Web 镜像；使用真实编译后的运行时校验器检查配置。
3. 启动新的 MySQL 和 Qdrant，准备独立上传卷，并通过 Worker 的现有初始化逻辑创建空向量集合、索引和 alias。
4. 运行正式 `prisma migrate deploy`，再检查迁移状态。
5. 仅当 `User` 表为空时，在事务内创建管理员；非空时拒绝执行。不会 seed 学生、动态、题目或照片。
6. 删除该安装器生成的一次性 `seed.env`，启动 API / Worker / HTTPS Web，并检查本机 HTTPS readiness。

历史迁移包含两个通用医学学科及系统单例配置。这些是应用初始字典，仅供参考，使用者可自行修改。数据库并非“所有表永远零行”；迁移记录、系统默认值及由部署者创建的管理员是正常初始化结果。

仅 Web 发布 80/443；80 跳转到 HTTPS。数据库、API、Worker 和 Qdrant 不发布宿主端口。请在目标服务器的云安全组/边界防火墙中按你的开放范围配置 Web 访问；脚本不会修改防火墙、DNS、SSH 或其他应用。不要通过发布 3000、3306、6333、6334 来解决连接问题。

## 5. 首次登录与业务验收

打开自己的 `https://` 站点，使用设置的管理员登录。先用很少量、容易辨认的虚构内容验证：

1. 修改密码，登出后重新登录；创建短期邀请码，注册一个测试成员并审批。
2. 创建一条动态，分别验证公开与成员权限；发布一条公告并验证已读状态在刷新后保持。
3. 上传一张自制测试图片，检查相册展示图与原图下载；未登录访问私有媒体应被拒绝。
4. 建立测试知识库，使用自有、允许外发的材料导入；等待后台完成，再验证阅读、问答和引用跳转。
5. 创建少量测试题并提交练习；按 [每日一练指南](docs/DAILY_PRACTICE.md) 配置自有课表与题目主题，验证每日一练最终任务状态。
6. 仅使用虚构姓名与自制凭证测试学时复核，检查人工复核和导出结果；确认供应商文件删除状态。
7. 核对测试内容刷新后保留、Worker 日志没有持续错误，并登记精确测试记录 ID。清理只能覆盖这份清单。

桌面与手机分别检查一次导航、登录与主要对话框。不要把 readiness、mock、构建成功等同于上述业务验收。没有测试账号、真实供应商权限或网络条件时，应记录未覆盖项。

## 6. 日常运行、失败恢复与更新

```bash
sudo python3 infra/deploy.py status
sudo python3 infra/deploy.py stop
sudo python3 infra/deploy.py start
```

这些命令不删除数据卷。`start` 只重新启动已安装的容器，不构建新镜像、不运行迁移、不重置管理员。

首次安装中断时，先在服务器本地检查 `/etc/class-site/deployment.log`，修复网络、配置或权限后执行 `sudo python3 infra/deploy.py resume`。日志为私有材料，可能含依赖组件的错误详情，分享前必须脱敏。`resume` 只适用于本安装器已登记的首次安装，不用于升级既有站点。

如果在创建管理员成功后、登记 `seeded` 状态前突然断电，再次执行会因用户表非空而拒绝 seed。这是保留已有账号的保护机制。应由管理员确认创建结果后恢复安装状态，不能清空用户表来绕过。不要手动把其他站点的数据卷或凭据接到这个安装状态目录。

本脚本不提供无人值守升级或自动回滚。以后更新源码前必须先备份数据库、uploads、COS 对象、Qdrant 和加密密钥，在隔离环境恢复并演练新迁移。检查新旧数据库结构与应用版本兼容后，再设计发布步骤；旧镜像不能单独恢复新版本产生的数据。

TLS 证书在 `init` 时被复制到私有目录，**不会随原证书路径自动续期**。续期后同步更新私有目录中的完整链和对应私钥，保持 0600 权限，运行 `check`，再通过本项目的 Compose 配置执行 `exec -T web nginx -t` 和 `exec -T web nginx -s reload`。按同样原则轮换供应商 key；仅修改环境文件不会更改已运行容器环境，需在受控维护窗口重新创建相关服务。数据库密码轮换还需要同步修改数据库账号，不能只改文件。

首次运行脚本不会为部署者建立备份计划。接收真实数据前必须完成 [数据与安全边界](SECURITY.md) 中的备份验收，并将私有配置目录纳入离线加密备份。

## 7. 本地开发与检查

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm db:generate
pnpm typecheck
pnpm test:infra
python3 infra/tests/deploy.test.py
pnpm build
pnpm release:check
```

工具版本以 `package.json` 和锁文件为准（`packageManager` 为 pnpm 11.9.0）。`pnpm lint` 是类型检查，不是 ESLint。只在需要时运行 `pnpm test`；本仓库没有以大量新增测试代替真实业务验收。

裸进程 `pnpm dev` 需要部署者创建的本地数据源和 `.env`。`.env.example` 仅供开发配置，不是可直接使用的生产部署配置，不包含可登录密码。生产配置由 `infra/runtime.env.example` 和 `deploy.py init` 生成；不要设置 `NODE_ENV=development` 绕过生产校验。

## 8. 适配其他班级

默认名称和图标均为中性占位内容，用于保持界面布局与业务流程完整。

因源站用于医学院校班级，故当前医学题库提示词和部分学时规则仍带有领域限定，非原院校使用者部署前应自行审阅修改以下内容：

| 内容 | 修改位置 |
| --- | --- |
| 首页名称、学校行、简述 | `apps/web/src/views/HomeView.vue` |
| 页眉、页脚、路由标题 | `apps/web/src/components/layout/SiteHeader.vue`、`SiteFooter.vue`、`apps/web/src/router.ts` |
| HTML 标题、description | `apps/web/index.html` |
| 公共图标 | `sc/badge.png`，使用你有权公开的 PNG，去掉 EXIF 等元数据 |
| 学科、章节、成员、教学进度 | 登录管理后台配置；迁移中的初始医学学科可在后台停用或调整 |
| 医学出题、评分、每日计划提示词 | `apps/worker/src/ai-question-generation.ts`、`apps/api/src/quiz/short-answer-grader.service.ts`、`packages/daily-practice-core/src/prompt.ts` |
| 学时凭证规则 | `apps/worker/src/credit-hour-review.ts`，包括特定志愿服务凭证来源及印章判断；非同类班级应先评审规则 |

**注意：** 内部 `@bmc3/*` 工作区名称、Cookie 名称和迁移中的技术标识仍有保留，使用时谨慎修改，以免破坏依赖与历史契约。

## 9. 许可证

本项目以 [MIT 许可证](LICENSE) 发布，可自由使用、修改和再分发，需保留版权与许可声明。MIT 只覆盖本仓库代码；引入的第三方素材、图表和直接 / 传递依赖仍按各自授权使用，部署者应自行核对。

## 10. 安全与数据边界

部署后处理真实成员数据前，请阅读 [数据与安全边界](SECURITY.md)：其中列出了用户、动态、相册、学时、知识库、练习和运维备份各类数据的存储与外发范围，以及备份、恢复和第三方权限要求。
