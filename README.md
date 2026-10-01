# 命令速查站(多分支)

Linux / Kubernetes 命令速查站。支持多分支切换,新增分支不需要改代码。

## 快速开始

```bash
npm install
npm run build      # 构建到 build/
```

本地预览:

```bash
npx serve build     # 或 python3 -m http.server -d build 8000
```

## 目录结构

```
command/<分支>/<slug>.md   内容源(Markdown)
branches.json              分支注册表
legacy-slugs.json          曾发布过的老 URL 集合(页面迁移后仍保证可访问)
template/                  EJS 模板
assets/                    CSS / JS / 图片源
scripts/                   构建与校验脚本
build/                     构建产物(gitignore)
public/  public.zip        发布暂存与打包产物(gitignore,由 npm run package 生成)
```

## 新增一个命令页

在对应分支目录下新建 `command/<分支>/<slug>.md`,格式:

```markdown
<slug>
===

一行中文描述

## 补充说明

**<slug>命令** 是……

### 语法

```shell
命令示例
```

### 注意

1. ……

### 相关命令

- `其他命令` — 说明

### 参考链接

- [标题](https://example.com)
```

**两条硬性规则:**

1. **第一行必须与文件名(去掉 `.md`)完全一致。** 产物文件名取标题,而链接取文件名 —— 二者不一致必然 404。构建会拦截并报错。
2. **文件名必须是 ASCII slug**(`pod`、`kube-proxy`),不能有空格或中文。中文只能出现在描述与正文里。

描述取自 `===` 之后、第一个 `##` 之前的内容,进搜索索引。

## 新增一个分支

1. 建目录 `command/<分支id>/`,放入 `.md`
2. 在 `branches.json` 的 `branches` 数组里加一条:

```json
{
  "id": "docker",
  "name": "Docker",
  "desc": "容器运行时与镜像管理",
  "searchPlaceholder": "搜索 Docker 命令",
  "default": false
}
```

3. `npm run build`

分支标签自动出现在首页与所有内页顶栏,搜索索引、总览页分组、计数全部自动更新。**无需改动任何代码。**

`id` 必须与目录名一致。`"default": true` 只能有一个。

### 老 URL 跳转(`legacy-slugs.json`)

曾经发布过的 `/c/<slug>.html` 老 URL 固化在这个文件里,构建时按 slug 查当前页面并生成跳转 stub。**这是关于历史的事实,与页面现在归属哪个分支无关** —— 把页面迁到别的分支后,老 URL 依然有效,不需要改这里。

`aliases` 用于同一页面曾以多个名字发布的特殊情况(如 `pullgcc` 与 `gcc`)。

同名跨分支时(如 `pv`、`service` 在两个分支都有),老 URL 指向**默认分支**的那个;其余情况按 slug 直接匹配。构建日志会打印实际解析结果。

## 校验与发布

```bash
npm run validate       # 命名与结构校验
npm run check-links    # 产物内链完整性(零 404)
npm run verify         # build + validate + check-links
npm run package        # verify + 暂存 public/ + 打包 public.zip(可直接上传)
```

`npm run package` 产出的 `public.zip` 与 `build/` 逐字节一致 —— 打包用系统
`zip` 并排除 `__MACOSX`/`.DS_Store`(Linux/Windows 解包不会多出一堆 `._*`),
完成后还会自检条目数与解压体积。`public/` 与 `public.zip` 均为本地暂存产物,
每次发布重新生成。

> 保真度校验(`fidelity.mjs`)已在迁移完成后退役:它的比对基线是旧站产物 `public/c/*.html`,
> 该目录已于 2026-10-01 随新站上线清理。历史实现见 commit `96d0bfa`。

## 架构说明

`js/dt.js` 里的每条记录形如:

```js
{"n":"helm","p":"/linux/helm","d":"Kubernetes包管理器","b":"linux"}
```

`p` 是**完整路径**(含分支),因此链接拼接是 `${站点根}${p}.html`。这也是构建脚本能直接从 `p` 反推源文件路径(`command/linux/helm.md`)的原因。

完整设计文档见 `docs/superpowers/specs/2026-09-18-branch-architecture-design.md`。

## 内容覆盖

| 分支 | 页面 | 说明 |
|---|---|---|
| Linux | 618 | 上游 jaywcjlove/linux-command 的命令集 |
| Kubernetes | 254 | 集群与节点、工作负载、网络、存储、安全、可观测性、CI/CD、服务网格、Operator、发行版等 |

Kubernetes 分支按方向划分:

```
集群与节点   kubeadm kubelet kube-proxy kube-apiserver etcd crictl ctr kubeconfig node ...
调度与资源   kube-scheduler affinity taints-tolerations priority-class poddisruptionbudget
             topology-spread resource-quota limitrange qos descheduler cluster-autoscaler vpa
工作负载     pod deployment statefulset daemonset job cronjob replicaset hpa
网络         service ingress networkpolicy coredns cni calico cilium flannel metallb multus ...
配置与存储   configmap secret pvc pv storageclass namespace csi longhorn rook ceph ...
安全         rbac serviceaccount pod-security-admission securitycontext admission-webhook
             opa gatekeeper kyverno falco trivy cosign sealed-secrets cert-manager vault ...
可观测性     prometheus alertmanager grafana loki fluent-bit jaeger opentelemetry thanos ...
CI/CD        argocd flux jenkins tekton argo-workflows argo-rollouts keda knative ...
服务网格     istio linkerd envoy kiali gateway-api contour traefik apisix kong nginx-ingress ...
Operator     crd operator kubebuilder operator-sdk olm controller-runtime aggregated-apiserver
发行版       k3s k0s talos microk8s k3d minikube kind kubeone rancher karmada kubevela openshift
中间件       postgres-operator mysql-operator redis-operator strimzi elastic-operator ...
运维工具     k9s kustomize velero metrics-server kube-bench kube-state-metrics chaos-mesh ...
```

其中 **`ecosystem-status`** 是一页专门的生态状态汇总:已退役/已归档的项目(含时间点与替代方案)、发生重大变更的项目(如 kube-proxy 的 IPVS 模式废弃、containerd 2.x 配置格式变更)、以及已从 CNCF 毕业的项目。写内容时如引用第三方工具,建议先对照该页确认其是否仍在维护。

> 各页面的 `### 注意` 小节记录的是**经核实的真实坑点**与常见误传的纠正,而非泛泛的最佳实践。

## 内容来源与许可

`command/linux/` 下的全部页面,以及 `command/k8s/` 中的 `kubectl`、`helm`、`docker` 三页,取自 [jaywcjlove/linux-command](https://github.com/jaywcjlove/linux-command)(MIT),是其 `command/*.md` 的内容,合计 621 页。本仓库在此之上加入了分支架构,以及 Kubernetes 分支其余的 251 页内容。

上游的版权声明与许可正文已完整复刻在 [LICENSE](LICENSE) 中 —— 该文件同时给出本站自有部分的许可,并逐条写明各自覆盖哪些路径。**分发本仓库或其内容时,不得移除 LICENSE。**

其中 `gcc.md` 修正了一处上游缺陷:原标题误写为 `pullgcc`,导致产物名为 `pullgcc.html` 而链接指向 `gcc.html`,产生 404。现标题与文件名统一为 `gcc`。

`kubectl`、`helm`、`docker` 三个页面已从 linux 迁至 k8s 分支(它们同属两边,放在 k8s 更符合浏览直觉)。迁移不影响老 URL —— `/c/kubectl.html` 仍会跳转到新位置。
