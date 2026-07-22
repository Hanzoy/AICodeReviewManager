# Code Review Control Center

一个采用“总管理端 + 独立项目组节点”架构的 AI Code Review 管理程序。

当前版本包含：

- React + Ant Design 总管理界面
- Node.js 总管理后端
- Node.js 项目组节点
- 项目组创建与一次性注册码
- 项目组动态端口注册
- 长期节点凭据与重连
- 节点心跳、离线检测和主动注销
- 项目组独立工作台与组内仪表盘
- GitLab、AI、飞书和本地仓库配置页面
- Review 项目创建、编辑与删除
- 项目详情、Commit 树、分支/关键词/时间筛选与仓库状态校验
- 指定一个或多个 Commit、或按完整分支范围发起手动 Code Review
- 每项目唯一 GitLab Webhook URL 与一次性 Secret 展示
- Merge Request Webhook 鉴权、幂等去重与串行队列入队
- 单仓库串行 GitLab MR Ref 拉取与 Detached HEAD 切换
- DeepSeek 自动执行只读、非交互 Review 与 JSON Schema 结构化输出
- MR 成功进入 Review 队列后发送飞书机器人通知，支持签名校验
- 手动 Review 完成飞书通知，并与严重问题、失败通知共享统一策略
- Review 结果 GitLab MR 评论发布、幂等检查与失败重试
- 项目组配置本地 JSON 持久化
- 敏感配置 AES-256-GCM 本地加密
- 基于本地 JSON 文件的管理端与节点身份存储
- 注册闭环冒烟测试

## 运行环境

- Node.js 22 或更高版本
- npm 10 或更高版本
- 项目组节点 Review 运行时

## Docker 部署（推荐）

Docker 方案包含两个镜像：

- `code-review-helper`：管理 API 与项目组节点共用的 Node.js 镜像，已包含 Git、SSH 客户端和 Review 执行器。
- `code-review-helper-web`：静态管理界面和到管理 API 的反向代理。

Docker 通过 bind mount 直接使用项目现有的 `data/`：管理端挂载 `data/manager`，每个项目组节点挂载 `data/group-nodes/<GROUP_ID>`。容器运行时会把仓库根目录覆盖为 `/app/data/group-node/repositories`，但不会改写 `config.json` 中原有的 Windows 路径，因此 Docker 与直接运行 Node 可以交替读取同一份历史数据。删除或升级容器不会删除宿主机数据。不要让 Node 进程和对应 Docker 容器同时运行，以免并发写文件或操作同一个 Git 仓库。

### 1. 启动管理端

需要 Docker Engine 24+ 和 Docker Compose v2。复制配置示例并按实际访问地址修改：

```bash
cp .env.docker.example .env.docker
```

至少检查 `MANAGER_PUBLIC_URL`。该地址会用于生成节点注册码和 GitLab Webhook URL，必须能够被项目组节点和 GitLab 访问。仅在本机试用时可以保留 `http://localhost:5173`；服务器部署应改为域名或服务器 IP，例如 `https://code-review.example.com`。

```bash
docker compose --env-file .env.docker up -d --build
docker compose ps
```

默认管理界面为 `http://localhost:5173`。查看日志：

```bash
docker compose logs -f manager web
```

### 2. 启动项目组节点

先在管理界面创建项目组并点击“注册节点”，复制弹窗中的“项目组 ID”和“注册代码”。然后为该节点准备独立配置：

```bash
cp .env.group.example .env.group
```

编辑 `.env.group` 中的 `GROUP_ID`、`ENROLL_TOKEN` 和 `GROUP_NAME`，再启动节点：

```bash
docker compose --env-file .env.group -f compose.group.yaml -p code-review-team-a up -d --build
docker compose --env-file .env.group -f compose.group.yaml -p code-review-team-a ps
```

`-p` 名称用于区分不同项目组。增加项目组时，为每个节点使用不同的 `.env.group-*` 文件和不同的 `-p` 名称。首次注册后，长期节点凭据保存在宿主机的 `data/group-nodes/<GROUP_ID>` 中，后续重启不需要生成新注册码。

查看节点日志：

```bash
docker compose --env-file .env.group -f compose.group.yaml -p code-review-team-a logs -f group-node
```

### 3. 生产环境入口

推荐在现有 Nginx、Traefik 或云负载均衡器后终止 HTTPS，并把流量转发到本机 `5173` 端口。此时可在 `.env.docker` 中设置：

```dotenv
WEB_BIND_ADDRESS=127.0.0.1
MANAGER_PUBLIC_URL=https://code-review.example.com
```

反向代理必须同时转发普通页面、`/api/*` 和 `/hooks/*`；不要只转发首页。GitLab Webhook 使用 `/hooks/*`。

### 4. 升级与数据

源码部署升级：

```bash
git pull
docker compose --env-file .env.docker up -d --build
docker compose --env-file .env.group -f compose.group.yaml -p code-review-team-a up -d --build
```

默认宿主机数据目录：

- 管理端：`data/manager`
- 项目组节点：`data/group-nodes/<GROUP_ID>`

可通过 `CODE_REVIEW_DATA_DIR` 指定绝对路径，例如 Windows 使用 `E:/Projects/CodeReviewHelper/data`。备份时应停止管理端和所有项目组节点，再完整备份该数据根目录。不要只备份 `manager`；GitLab、AI、飞书密钥、仓库和 Review 结果都保存在对应的 `group-nodes` 目录中。

如果项目组节点与管理端不在同一台 Docker 主机，需要让双方网络互通：将 `MANAGER_INTERNAL_URL` 改为节点可访问的管理端地址，并把 `GROUP_PUBLIC_URL` 设置为管理端可回连的节点地址，同时自行发布和保护节点的 `7100` 端口。同机部署不需要暴露节点端口。

## 启动总管理端

```bash
npm install
npm run dev
```

启动后：

- 管理界面：`http://<管理端IP>:5173`
- 管理 API：`http://<管理端IP>:7000`

在管理界面创建项目组后，页面会生成类似下面的单次启动命令：

```bash
npm run start:group -- --manager-url=http://<管理端IP>:7000 --group-id=<group-id> --enroll-token=<token> --data-dir=./data/group-nodes/<group-id>
```

项目组首次注册成功后会在自己的数据目录保存长期节点身份。后续启动可以继续使用同一个数据目录，不需要重新输入一次性注册码。

## 常用命令

```bash
# 同时启动管理 API 和 Web 管理端
npm run dev

# 只启动管理 API
npm run start:manager

# 启动项目组节点
npm run start:group -- --manager-url=<url> --group-id=<id> --enroll-token=<token>

# 类型检查并构建前端
npm run build

# 验证创建项目组、节点注册、心跳和清理闭环
npm run test:smoke

# 验证 Git 仓库、结构化 AI 结果、串行 Worker 与 GitLab 评论闭环
npm run test:review-worker
```

## 数据目录

```text
data/
├─ manager/
│  └─ groups/{groupId}/group.json
└─ group-nodes/
   └─ {groupId}/
      ├─ identity.json
      ├─ config.json
      ├─ projects.json
      ├─ review-queue.json
      ├─ review-output-schema.json
      ├─ repositories/{projectKey}/
      └─ review-artifacts/{taskId}/result.json
```

`data/` 已加入 `.gitignore`。项目组节点后续的 GitLab、AI、飞书、项目及 Review 数据都应保存在自己的项目组目录中。

项目组节点升级后，使用原数据目录重新启动即可，不需要新的注册码：

```bash
npm run start:group -- --manager-url=http://<管理端IP>:7000 --group-id=<group-id> --name=<group-name> --data-dir=./data/group-nodes/<group-id>
```

## 节点生命周期

### 正常停止

在项目组节点终端按 `Ctrl+C`。节点会通知总管理端注销，然后在管理页面显示为“离线”。

### 正常重启与重连

始终复用第一次注册时的 `--data-dir`。目录中的 `identity.json` 保存了长期节点身份，因此不需要新的注册码：

```bash
npm run start:group -- --manager-url=http://<管理端IP>:7000 --group-id=<group-id> --name=<group-name> --data-dir=./data/group-nodes/<group-id>
```

节点允许使用新的动态端口，重连后会自动更新管理端中的端口和心跳状态。

### 重新注册

只有节点身份丢失、总管理端数据被重置或长期凭据失效时才需要重新注册：

1. 在管理页面为该项目组生成新的单次注册码。
2. 使用相同数据目录并增加 `--reset-identity`：

```bash
npm run start:group -- --reset-identity --manager-url=http://<管理端IP>:7000 --group-id=<group-id> --enroll-token=<new-token> --name=<group-name> --data-dir=./data/group-nodes/<group-id>
```

`--reset-identity` 只删除节点注册身份，不删除 GitLab、AI、飞书和项目组业务配置。

## 创建项目与配置 GitLab Webhook

1. 进入 `/groups/{项目组标识}/settings`，配置 GitLab Base URL、API URL 和 Access Token。
2. 进入“项目管理”，只需填写 GitLab Project ID/Path（数字 ID 或 `namespace/project`）并点击“读取项目信息”。系统会通过项目组的 GitLab 连接自动填写项目名称、项目标识、默认分支和 Clone 地址。
3. 如果需要使用镜像仓库或特殊 Clone 地址，展开“高级设置（Clone 地址和默认分支）”进行覆盖；普通项目不需要填写。
4. 创建后复制页面一次性显示的 Webhook URL 与 Secret token。
5. 在 GitLab 项目的 `Settings → Webhooks` 中填写 URL 和 Secret token。
6. Trigger 只勾选 `Merge request events`，保存后发送测试请求。

Webhook URL 由总管理端对外提供。部署时必须把 `MANAGER_PUBLIC_URL` 配置成 GitLab 服务器能够访问的地址，例如：

```powershell
$env:MANAGER_HOST="0.0.0.0"
$env:MANAGER_PUBLIC_URL="https://code-review.example.com"
npm run start:manager
```

当前兼容模式使用 GitLab `Secret token`，接收端校验 `X-Gitlab-Token`。Secret 明文只在创建或轮换时返回一次，节点只保存 SHA-256 哈希。

收到有效 Merge Request 事件后，节点会：

- 校验 Webhook Secret 和 GitLab Project ID/Path；
- 按 delivery ID 和 MR Head SHA 去重；
- 将旧的排队版本标记为 `superseded`；
- 将 MR 关闭或合并对应的排队任务标记为 `cancelled`；
- 将新版本追加到项目组本地串行队列。

## DeepSeek Review 执行

1. 确保项目组节点的 Review 运行时已经就绪。
2. 在项目组“设置 → GitLab”配置 API URL 和具有 MR 评论权限的 Access Token。
3. Clone、Fetch 和同步远端统一使用项目组配置的 Access Token：新项目默认采用 HTTPS；旧项目即使保存了 SSH 地址，执行时也会通过 GitLab API 转换为 HTTPS。Token 只通过临时 AskPass 环境传入，同时禁用本机 Credential Helper，不写入仓库 URL 或日志。
4. 在“设置 → DeepSeek Review”配置 API 地址、API Key、审查模型、执行策略和团队 Review 提示词。
5. MR Webhook 入队后，项目组 Worker 一次只处理一个任务。

每个任务会依次执行：

1. 复用项目唯一的本地仓库；目录不存在时才 Clone。
2. 拒绝覆盖存在未提交修改的仓库。
3. Fetch `refs/merge-requests/{iid}/head` 和目标分支，并校验 HEAD SHA。
4. Detached Checkout 到 MR HEAD。
5. Worker 先把本次审查范围的真实 Git Patch 写入 `review-artifacts/{taskId}/review-input.patch`；MR 任务生成 merge-base 到 HEAD 的差异，手动任务逐个生成所选 Commit 的精确差异。
6. 将该 Patch 目录以只读方式提供给 DeepSeek Review 运行时，并配合只读工具白名单和 JSON Schema 执行非交互 Review。
7. 解析固定结构的结论、风险等级与 Findings。
8. 调用 GitLab Notes API，将 Markdown Review 结果发布到对应 MR。

DeepSeek API Key 只保存在项目组节点的 AES-256-GCM 加密文件中。执行日志、输入 Patch 和结构化结果保存在对应任务的 `review-artifacts/{taskId}` 下，便于排查失败。如果模型返回“无法获取或读取 Diff”且没有任何 Finding，Worker 会把任务标记为失败，不会将无效结果记录为 Review 完成。

评论包含任务 ID 与 Commit SHA 隐藏标记。节点在评论成功后、写入完成状态前异常重启时，会先查找该标记，避免重复评论。失败任务会在 Review 列表保留错误，可直接点击“重试”。

## 手动 Code Review

在项目组“项目管理”中点击项目名称或“Commit / Review”，可以进入项目详情页：

1. 按分支、提交人、提交信息关键词和起止日期筛选本地 Commit 历史。
2. 选择一个或多个 Commit；也可以切换为“快速选择整个分支”。
3. 预览提交数、文件数和增删行数；分支模式自动以项目配置的默认分支为比较基准。
4. 提交任务后，它会与 GitLab MR 任务进入同一个项目组串行队列。
5. 完成后在项目详情的“手动 Review 历史”中查看结构化结果。

指定 Commit 模式会分别审查每个所选 Commit 的精确 Patch；分支模式会审查目标分支与源分支 Merge Base 到源分支 HEAD 的范围。手动 Review 结果只展示在管理页面，不会写入某个 GitLab MR。

Commit 树根据父 Commit 和分支引用绘制多轨分叉、合并关系。项目组节点会把 Commit 元数据缓存在 `data/group-nodes/{groupId}/cache/commit-graphs`，不缓存代码文件，也不修改仓库；本地 HEAD、分支、远端引用或 Tag 变化时缓存会自动失效并重建。

项目详情中的“重新检测”只执行轻量本地仓库校验，不访问 GitLab；“同步远端”会执行 `git fetch --prune --tags origin`，同步全部远端分支并在返回前预热 Commit 缓存。同步与该项目的 Review 执行共享同一把 Git 操作锁，避免 Fetch、Checkout 与 AI Review 并发修改仓库。完整工作区脏文件检查延迟到 Review 真正执行前进行，因此日常打开 Commit 树不会扫描大型工作区。

“项目组设置 → 飞书通知”中可以单独启用或关闭“手动 Code Review”。如果结果包含严重问题，优先按“严重问题”事件发送；执行失败仍按“Review 失败”事件发送。

### 复用已有的大型本地仓库

可以直接复用已有的相同 Git 仓库，无需重新 Clone 数百 GB 数据：

1. 在项目详情复制系统显示的“本地路径”。
2. 停止正在使用目标仓库的其他 Git 操作。
3. 将完整仓库目录复制或移动到该路径，必须包含 `.git`；不要只复制工作区文件。
4. 确保仓库没有 `.git/index.lock`、没有未提交改动，并且 `origin` 与项目配置的 Clone 地址一致。
5. 点击“刷新仓库”，状态通过后即可查询 Commit 和发起手动 Review。

对 400 GB 级仓库，优先在同一磁盘内移动目录，或使用系统级增量复制工具。管理页面只负责校验目标路径，不通过 HTTP 上传或复制仓库。

## 代码结构

```text
src/                  React 管理端
server/manager/       总管理端 Node API 与文件存储
server/group/         项目组 Node 节点
shared/               前后端共享协议
scripts/              联调和维护脚本
```

## 当前边界

当前里程碑已经完成项目组工作台、配置存储、项目管理、Webhook 接收、MR 与手动任务共享的串行 Review Worker、Commit/分支手动 Review、DeepSeek Review、GitLab MR 汇总评论，以及 MR 入队、手动 Review、Review 完成、Review 失败和严重问题飞书通知。GitLab 行级 Discussion 评论仍待接入。
