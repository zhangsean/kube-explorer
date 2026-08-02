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
