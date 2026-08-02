# kube-explorer

kube-explorer is a portable explorer for Kubernetes without any dependency.

It integrates the Rancher steve framework and its dashboard, and is recompiled, packaged, compressed, and provides an almost completely stateless Kubernetes resource manager.

## Changelog

每次发布新版本前必须更新本节，按版本倒序记录面向用户的主要变动。

### v0.5.8 - 2026-08-02

- 优化 Deployment、ReplicaSet 和 Pod 列表加载，使用服务端预热快照和关键字优先过滤，降低大集群首次加载与搜索等待时间。
- 过滤请求期间保留已有 Deployment 列表，避免输入关键字时出现整页刷新、灰色空表或错误的无匹配中间状态。
- 完善列表缓存容量、生命周期和写入后失效机制，修复重新部署后 Pod 列表短暂为空、存活时间陈旧以及 Shell/Logs 连接到旧 Pod 的问题。
- 改进 WebSocket、日志和 YAML 等流式响应代理，确保 Shell、Logs 与 YAML 查看编辑在缓存优化后仍能正常使用。
- Pod 日志加载完成后自动滚动到底部，同时保留用户在加载期间主动滚动时的控制权。

### v0.5.7 - 2026-07-25

- 修复 Deployment、DaemonSet、StatefulSet 等工作负载详情页可能因全局命名空间筛选而不显示 Pod 的问题。
- 优化独立部署模式的前端请求，移除无用的 Rancher `/v3`、Grafana、Fleet 探测和大量预取请求，并复用 Dashboard Store 中已有的资源与指标数据。
- 删除发布包中无需运行时加载的 source map，降低嵌入资源体积；下载脚本会保留定制脚本并自动生成缓存版本号。
- 优化节点列表密度、标签间距和 CPU/RAM/Pod 圆角进度条，新增 `Pods 已使用 / 可分配总量` 展示。
- 修复滚动更新或 Redeploy 后新 Pod 存活时间停在 1 秒的问题，并保持原生列排序下连续读秒。
- Deployment 的 Pod 状态统计改为按“状态名称 + 状态颜色”独立分组，并使用紧凑状态块展示。
- 改进 Pod 指标列刷新和排序稳定性，减少 Vue 表格更新时的闪烁、错位与重复请求。

### v0.5.6 - 2026-07-24

- 优化 Pod、Deployment、ReplicaSet 等列表请求，完整加载分页资源并对高频列表增加短时缓存。
- 重构 Pod 指标表刷新与排序逻辑，改善滚动更新、路由切换和表格替换时的显示稳定性。
- 节点 CPU/RAM 使用率改为读取 Metrics API，并补充 Request、Limit、总容量摘要。
- 增加列表优化测试，覆盖完整列表、分页请求和缓存行为。

### v0.5.5 - 2026-07-23

- 优化资源编辑完成后的返回路径，保留用户进入编辑器前的来源页面。
- 修复创建中 Pod 的指标列错位问题。
- 调整发布构建链路，确保使用仓库中已提交的定制 Dashboard 资源。
- 修正 Docker Hub 与阿里云镜像仓库路径，支持 amd64/arm64 构建并提供独立 ARM 标签。

### v0.5.4 - 2026-06-08

- 增加 Docker Hub 多架构镜像构建，并支持 amd64、arm64 独立发布标签。
- 发布 Linux 压缩二进制文件并精简容器运行时镜像。
- 优化 Pod 指标列表的刷新、缓存和渲染。

## Dashboard 定制功能与源码迁移清单

当前 Dashboard 基于 `cnrancher/kube-explorer-ui` 的 `release-2.9.2-cn` 分支和
`v2.9.2-kube-explorer-ui-rc1` 构建产物。现有功能主要通过
`custom-metrics.js`、`custom-priority-lists.js` 和下载阶段的产物补丁实现。

后续迁移到前端源码时，以本节作为功能基线。每个编号必须单独实现和验收；只有源码实现、
自动化测试和浏览器回归全部通过后，才能删除对应的注入逻辑。

### 前端功能

| 编号 | 功能点 | 当前行为与源码迁移验收标准 | 源码迁移 |
| --- | --- | --- | --- |
| UI-01 | 独立部署启动 | kube-explorer 模式跳过 Rancher `/v3` 登录认证流程，同时正常初始化 Store 和资源监听。 | 待迁移 |
| UI-02 | 移除无效能力探测 | 独立模式不探测 Rancher Monitoring/Grafana，不加载 Fleet Agent，不产生必然失败的接口请求。 | 待迁移 |
| UI-03 | 首屏资源懒加载 | 不预取所有 lazy chunk，仅预加载入口文件，避免首次打开下载几乎整个 Dashboard。 | 待迁移 |
| UI-04 | 独立模式布局 | 隐藏多余侧栏，固定主导航宽度，收紧主内容边距和 Node 表格密度。 | 待迁移 |
| UI-05 | 编辑后返回来源页 | 从详情页或过滤后的列表进入编辑器，保存后直接回到原路径、查询参数和锚点，不闪现资源总列表。 | 待迁移 |
| UI-06 | Deployment 写后详情恢复 | Redeploy 或详情页 PUT/PATCH 成功后重新读取完整 Deployment，并恢复后续 watch 响应。 | 待迁移 |
| UI-07 | 工作负载 Pod 不受全局命名空间误过滤 | Deployment、DaemonSet、StatefulSet、ReplicaSet、Job 等详情中的 Pod 按工作负载自身关联结果显示。 | 待迁移 |
| UI-08 | 工作负载 Pod 状态统计 | 按“状态名称 + 状态颜色”分组计数，以紧凑状态块显示，避免不同严重程度被错误合并。 | 待迁移 |
| UI-09 | Pod CPU/RAM 指标列 | 在 Pod 总列表、工作负载 Pod 页和 Node 详情 Pod 表中显示 CPU、RAM 列，并稳定放在 Restarts 后面。 | 待迁移 |
| UI-10 | Pod 使用量进度条 | 显示 Metrics API 实际用量、Request、Limit；优先按 Limit 计算比例，否则按 Request；达到 Limit 90% 时警告。 | 待迁移 |
| UI-11 | CPU/RAM 排序 | 支持 CPU、RAM 升降序，默认非分组 Pod 表按 RAM 降序；点击原生列后恢复 Dashboard 原生排序。 | 待迁移 |
| UI-12 | Pod 表格刷新稳定性 | 正确处理 Pending、ContainerCreating、分组行缺列和新 Pod 插入，避免指标与 IP、Node、Age 错位。 | 待迁移 |
| UI-13 | 滚动更新实时显示 | 滚动更新或 Redeploy 后新 Pod 立即进入当前排序结果，Age 持续更新，不停在 `1 sec`。 | 待迁移 |
| UI-14 | Pod 表格固定布局 | 固定主要列宽，长名称和镜像可换行，小屏支持横向滚动，路由和 watch 更新时布局不跳动。 | 待迁移 |
| UI-15 | Node 实际资源指标 | Node CPU/RAM 使用 Metrics API 实际用量，显示与 Pod 指标一致的进度条，90% 以上警告。 | 待迁移 |
| UI-16 | Node 资源汇总 | 聚合非终态 Pod，展示 CPU/RAM Request、Limit、总容量以及 `Pods 已使用 / 可分配总量`。 | 待迁移 |
| UI-17 | Node 详情 Pod 批量操作 | 提供行选择、全选/半选、已选数量和批量删除，优先复用原生确认并报告部分失败。 | 待迁移 |
| UI-18 | Node 详情 Pod 操作菜单 | 提供 Shell、Logs、编辑配置、编辑 YAML、克隆、下载 YAML 和删除，支持中英文并优先选择非 `istio-proxy` 容器。 | 待迁移 |
| UI-19 | Pod 日志体验 | 未设置偏好时默认 `1000 lines`；加载完成后自动滚到底部；用户主动滚动或触摸时取消自动滚动。 | 待迁移 |
| UI-20 | 数据请求复用 | 优先复用 Dashboard Store 已加载的 Pod、Node 和 Metrics；缺失时才请求 API，并合并并发请求。 | 待迁移 |
| UI-21 | 完整分页读取 | API fallback 沿 `pagination.next`、`links.next` 或 Kubernetes `continue` 读取所有页面。 | 待迁移 |
| UI-22 | Deployment 搜索协调 | 搜索时协调 Deployment、ReplicaSet、Pod 请求，防抖输入并在过滤后恢复完整关联数据。 | 待迁移 |
| UI-23 | 搜索期间保留当前列表 | 新筛选结果返回前保留已有 Deployment 表格并显示 Spinner，避免空表、错误无匹配状态和整页闪烁。 | 待迁移 |

`UI-18` 当前的“下载 YAML”实际将格式化后的 JSON 以 `.yaml` 文件名下载。源码迁移时应生成
真正的 YAML，并将其作为显式行为修正单独测试和提交。

### 后端配套契约

以下能力保留在 Go 服务端，不迁入 UI 仓库，但新版前端必须完成兼容回归。

| 编号 | 配套能力 | 保留与验收要求 |
| --- | --- | --- |
| BE-01 | 完整资源列表 | Pod、Deployment、ReplicaSet 首次列表请求不能因分页限制导致关联数据不完整。 |
| BE-02 | 高频列表缓存 | Pod、Node、Metrics、Deployment、ReplicaSet JSON 短时缓存和并发合并必须区分响应格式、代理前缀与用户身份，并在写操作成功后失效。 |
| BE-03 | 搜索关键字协议 | 前端通过 `X-Kube-Explorer-List-Filter-Keyword` 传递安全关键字，后端按名称、命名空间和容器镜像过滤。 |
| BE-04 | 搜索快照 | Deployment 列表相关资源保持预热快照和后台刷新；工作负载详情请求必须绕过列表快照。 |
| BE-05 | 流式请求与连接 | WebSocket、Shell、Logs、YAML 和 API 响应不能被 HTML 代理缓冲或列表缓存截获。 |

### 构建和验收要求

- BUILD-01：前端 fork 固定到 `release-2.9.2-cn` 的确定提交，不直接以持续变化的 `main` 为基线。
- BUILD-02：独立模式认证、Monitoring/Grafana 和 Fleet 逻辑必须改在源码中，删除压缩 bundle 字符串替换。
- BUILD-03：继续生成静态 `dist` 并由 Go `embed` 打包，保持 kube-explorer 的单文件部署形态。
- BUILD-04：保持 lazy chunk 按需加载、删除发布包 source map，并为定制资源生成内容哈希。
- TEST-01：每个 UI 编号必须有对应的单元或组件测试，并通过真实浏览器完成目标交互验证。
- TEST-02：完成迁移后回归 Pod、Node、Deployment、编辑、Redeploy、Logs、Shell、YAML 和大列表搜索流程。

## Usage ✅

Please download the binary from the [release page](https://github.com/zhangsean/kube-explorer/releases).

To run an HTTP only server:

```bash
./kube-explorer --kubeconfig=xxxx --http-listen-port=9898 --https-listen-port=0
```

Then, open the browser to visit http://x.x.x.x:9898 .

![](docs/assets/kube-explorer-record.gif)

## Build ✅

To debug on an AMD64 Linux host:

```bash
make dev

# $basedir=/opt/ui/dist/
# prepare the file trees like this
# $basedir/dashboard/
# $basedir/api-ui/
# $basedir/index.html

# good to go!
./bin/kube-explorer --debug  --ui-path /opt/ui/dist/ --http-listen-port=9898 --https-listen-port=0
```

To build all cross-platform binaries:

```bash
CROSS=tag make
```

## Supported features

- Specified system default registry for shell image, e.g. `--system-default-registry`
- Specified shell image name, e.g. `--pod-image`
- Deployed behind proxy
  - [Behind ingress with dns name](./deploy/kubectl/README.md)
  - [Behind ingress with dns name and path prefix](./deploy/kubectl/path-prefix/Readme.md)
  - Base auth via ingress such as [nginx](./deploy/kubectl/nginx-auth/README.md), [traefik-v1](./deploy/kubectl/traefik-v1-auth/README.md) and [traefik-v2](./deploy/kubectl/traefik-v2-auth/README.md)

## Support Matrix

Currently, there are several major versions under maintenance, each tailored to different Kubernetes version ranges due to the use of varying steve and client-go versions.

| Major | Target Rancher Branch | K8s version range |
| ----- | --------------------- | ----------------- |
| v0.4  | v2.8.x                | >= 1.25 <= 1.28   |
| v0.5  | v2.9.x                | >= 1.27 <= 1.30   |

Please use the proper kube-explorer version for your k8s setup.

## Related Projects

- kube-explorer ui([https://github.com/cnrancher/kube-explorer-ui](https://github.com/cnrancher/kube-explorer-ui))
- autok3s([https://github.com/cnrancher/autok3s](https://github.com/cnrancher/autok3s))
- api-ui([https://github.com/rancher/api-ui](https://github.com/rancher/api-ui))
