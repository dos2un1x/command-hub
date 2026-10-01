grafana
===

指标可视化与监控大盘平台,常与Prometheus搭配使用

## 补充说明

**Grafana** 是开源的指标可视化与可观测性平台。它本身不存储任何监控数据,而是作为**查询前端**去连接各种数据源(Prometheus、Loki、Tempo、Elasticsearch、MySQL、ClickHouse……),把查询结果渲染成图表与大盘(Dashboard)。

在 Kubernetes 中它通常承担三个角色:

```shell
监控大盘          读取 Prometheus,展示集群与业务指标
日志检索          读取 Loki,按标签查容器日志
链路追踪          读取 Tempo / Jaeger,查看调用链
```

部署方式有三种,选择取决于你是否已经用了 Operator:

```shell
kube-prometheus-stack 中的 Grafana 子 Chart  最常见,开箱即用
grafana/grafana 独立 Chart                    自定义程度最高
Grafana Operator(CRD)                        用 GrafanaDashboard / GrafanaDataSource 声明式管理
```

Grafana 的核心难点不在安装,而在**配置的持久化与版本化**:手工在 UI 上点出来的大盘存于 Grafana 自己的数据库(SQLite 或外部数据库),换一个集群就没了。生产做法是把数据源与大盘全部**以代码形式(ConfigMap)供给(Provisioning)**,让 Grafana 变成无状态组件。

### 安装

```shell
# 官方 Chart 仓库
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update

# 2026 年 1 月起 Chart 迁至社区仓库,长期维护版本在这里
helm repo add grafana-community https://grafana-community.github.io/helm-charts

# 独立安装
helm install grafana grafana-community/grafana \
  -n monitoring --create-namespace \
  --set persistence.enabled=true \
  --set persistence.size=10Gi \
  --set admin.existingSecret=grafana-admin

# 随 kube-prometheus-stack 安装时,只覆盖 Grafana 相关值
helm upgrade prometheus prometheus-community/kube-prometheus-stack -n monitoring \
  --set grafana.enabled=true \
  --set grafana.persistence.enabled=true \
  --set grafana.adminPassword='<强密码>'

# 查看自动生成的 admin 密码(独立 Chart 未指定时)
kubectl get secret -n monitoring grafana -o jsonpath='{.data.admin-password}' | base64 -d

# kube-prometheus-stack 的 Grafana 默认密码是 prom-operator,必须改掉
kubectl get secret -n monitoring prometheus-grafana -o jsonpath='{.data.admin-password}' | base64 -d
```

### 核心配置项

```shell
replicas: 1
image:
  repository: docker.io/grafana/grafana
  tag: ""                       # 默认取 AppVersion,且是 -distroless 变体
persistence:
  type: pvc
  enabled: false                # 默认关闭,数据存 emptyDir
  size: 10Gi
  accessModes:
    - ReadWriteOnce
adminUser: admin
admin:
  existingSecret: ""            # 推荐:从已有 Secret 读取
  userKey: admin-user
  passwordKey: admin-password
datasources: {}                 # 数据源 Provisioning
dashboardProviders: {}          # 大盘 Provider 定义
sidecar:
  dashboards:
    enabled: false
    label: grafana_dashboard    # ConfigMap 需带此 label
    searchNamespace: ALL        # ALL 表示全集群搜索
  datasources:
    enabled: false
    label: grafana_datasource
service:
  enabled: true
  type: ClusterIP
  port: 80
  targetPort: 3000
ingress:
  enabled: false
resources: {}
plugins: []                     # 安装插件,会触发容器内下载
grafana.ini: {}                 # 映射为 grafana.ini
```

### 数据源配置

数据源通过 `datasources` 生成 ConfigMap 并挂进 `/etc/grafana/provisioning/datasources/`:

```shell
datasources:
  datasources.yaml:
    apiVersion: 1
    deleteDatasources:
      - name: Prometheus
        orgId: 1
    datasources:
      - name: Prometheus
        type: prometheus
        access: proxy
        url: http://prometheus-kube-prometheus-prometheus.monitoring.svc:9090
        isDefault: true
        jsonData:
          timeInterval: 30s
          httpMethod: POST
      - name: Loki
        type: loki
        access: proxy
        url: http://loki-gateway.monitoring.svc:80
        jsonData:
          maxLines: 1000
      - name: Tempo
        type: tempo
        access: proxy
        url: http://tempo.monitoring.svc:3200
        jsonData:
          tracesToLogsV2:
            datasourceUid: loki
```

`datasources` 下的 key 必须以 `.yaml` 结尾(`datasources.yaml`),Chart 会用它作为挂载文件名。

### 大盘供给(Provisioning)

有两种互斥的做法,Chart 的注释明确写了「两者不能同时使用」:

**方式一:dashboardProviders(大盘写进 values)**

```shell
dashboardProviders:
  dashboardproviders.yaml:
    apiVersion: 1
    providers:
      - name: 'default'
        orgId: 1
        folder: 'General'
        type: file
        disableDeletion: false
        editable: true
        options:
          path: /var/lib/grafana/dashboards/default
dashboards:
  default:
    my-app:
      json: |
        { "title": "My App", "panels": [] }
```

**方式二:sidecar(大盘放在带 label 的 ConfigMap 里,推荐)**

```shell
kubectl create configmap my-dashboard -n monitoring \
  --from-file=my-dashboard.json \
  --dry-run=client -o yaml | \
  kubectl label --local -f - grafana_dashboard=1 --dry-run=client -o yaml | \
  kubectl apply -f -
```

对应的 values:

```shell
sidecar:
  dashboards:
    enabled: true
    label: grafana_dashboard
    labelValue: "1"
    searchNamespace: ALL
    folderAnnotation: grafana_folder   # ConfigMap 的 grafana_folder 注解决定文件夹
    provider:
      foldersFromFilesStructure: true
```

sidecar 是一个与 Grafana 共处一个 Pod 的辅助容器,它 watch 带指定 label 的 ConfigMap,把 JSON 写入 `/tmp/dashboards` 并触发热加载。**改 ConfigMap 后无需重启 Grafana**。

### grafana.ini 常用配置

```shell
grafana.ini:
  server:
    root_url: https://grafana.example.com
    serve_from_sub_path: false
  auth.anonymous:
    enabled: false
    org_role: Viewer
  security:
    admin_user: admin
    cookie_secure: true
  database:
    type: postgres
    host: postgres.monitoring.svc:5432
    name: grafana
    user: grafana
  analytics:
    reporting_enabled: false
    check_for_updates: false
  unified_storage:
    index_path: /var/lib/grafana-search/bleve
```

外部数据库的密码不要写在 values 里,用 `env` 注入:

```shell
env:
  GF_DATABASE_PASSWORD:
    valueFrom:
      secretKeyRef:
        name: grafana-db
        key: password
envFromSecret: grafana-db
```

### 排障

```shell
# 查看 Pod 与大盤供给是否生效
kubectl get po -n monitoring -l app.kubernetes.io/name=grafana
kubectl logs -n monitoring deploy/grafana -c grafana --tail=100
kubectl logs -n monitoring deploy/grafana -c grafana-sc-dashboard --tail=50

# 确认数据源 ConfigMap 已生成
kubectl get cm -n monitoring | grep -i grafana

# 确认 sidecar 找到的大盘
kubectl logs -n monitoring deploy/grafana -c grafana-sc-dashboard | grep -i "configmap"

# 确认 RBAC 能让 sidecar 读到全集群 ConfigMap
kubectl get clusterrole grafana-clusterrole -o yaml | grep -A5 configmaps

# 忘记密码时重置
kubectl exec -n monitoring deploy/grafana -c grafana -- \
  grafana cli admin reset-admin-password '<新密码>'
```

### 注意

1. **默认没有持久化存储**。`persistence.enabled` 默认是 `false`,Grafana 的数据目录挂的是 emptyDir。Pod 一重启,**UI 上手工创建的大盘、用户、API Key、告警规则全部消失**。生产要么开 PVC,要么把数据源和大盘都做成 Provisioning 后接受无状态 —— 但两者至少要有一个。
2. **`kube-prometheus-stack` 的 Grafana 默认密码是 `prom-operator`**,这是公开的默认值,任何能访问 Grafana 端口的人都能登录并看到全部监控数据。安装后第一件事就是改 `grafana.adminPassword` 或用 `grafana.admin.existingSecret`。
3. **新版本 Chart 默认使用 distroless 镜像**。distroless 镜像里没有 shell、没有包管理器,`kubectl exec -it ... -- sh` 会失败,`grafana cli` 也未必可用。需要调试或安装插件时,把 `image.tag` 指定为非 distroless 变体(例如 `12.0.0` 而不是 `12.0.0-distroless`)。
4. **`GF_INSTALL_PLUGINS` 已被弃用**,新版镜像会打印 `GF_INSTALL_PLUGINS is deprecated`,插件静默不装。应改用 `GF_PLUGINS_PREINSTALL_SYNC`。另外 Chart 的 `plugins:` 会去 grafana.com 下载,离线集群直接失败。
5. **Chart 会把 emptyDir 挂到 `/var/lib/grafana`**,覆盖掉自定义镜像里预先 `grafana cli plugins install` 装好的插件目录。用自定义镜像预装插件时必须把 `persistence` 打开或改 `grafana.ini.paths.plugins` 到别的目录。
6. **sidecar 与 dashboardProviders 不能同时用**。Chart 的注释明确说明「一个 provider 的大盘要么来自外部 ConfigMap,要么来自 values.yaml,不能两者都提供」。混用会出现大盘重复或互相覆盖。
7. **sidecar 的 ConfigMap 必须有正确的 label**。默认是 `grafana_dashboard`(数据源是 `grafana_datasource`)。label 的**值**不参与匹配,但不能为空;习惯写 `"1"`。漏了 label 的大盘 ConfigMap 会被完全忽略,日志里也未必有明显报错。
8. **sidecar 需要集群级 RBAC 才能跨命名空间读 ConfigMap**。设置 `searchNamespace: ALL` 时,Chart 会创建 ClusterRole;如果集群策略禁止创建 ClusterRole(`rbac.namespaced: true`),sidecar 只能读本命名空间的 ConfigMap,其它命名空间提交的大盘一律不可见。
9. **Provisioned 的大盘在 UI 上是只读的**。所有 Provisioning 来源的大盘会显示「无法保存」,UI 上的修改在下次容器重启或 sidecar 重扫时被覆盖。要改必须先改 ConfigMap 里的 JSON 再提交。
10. **单个 ConfigMap 有约 1MiB 的容量上限**(etcd 限制)。大盘 JSON 超过这个体积(常见于几百个 panel 的巨型大盘)无法放入 ConfigMap,需要拆分或改用 Grafana Operator / 对象存储。
11. **改了 `grafana.ini` 必须重启 Pod**。只有 `grafana.ini` 是启动时读取的;数据源、大盘、告警规则走 Provisioning 支持热加载。`helm upgrade` 会触发 Deployment 滚动更新,直接 `kubectl edit cm` 则不会。
12. **Ingress 场景要设 `grafana.ini.server.root_url`**。不设置时 Grafana 生成的分享链接、告警通知里的链接会指向集群内地址。子路径部署还要同时打开 `serve_from_sub_path`。
13. **`replicas` 大于 1 需要共享数据库与共享 Session**。SQLite 无法被多个副本共享,必须换成 PostgreSQL/MySQL 并设置 `grafana.ini.database`,否则多副本之间会出现登录状态随机丢失、大盘不一致。
14. **`testFramework.enabled` 默认为 `true`**,Chart 会渲染一个以 `bats` 镜像运行的测试 Pod(通过 `helm test` 触发)。在禁止拉取 Docker Hub 的集群里,这个 Pod 会长期 `ImagePullBackOff`,虽不影响 Grafana 本身但会干扰巡检。
15. **Grafana 不存数据**。大盘为空先确认数据源连通性(`Save & test`)、时间范围、以及 Prometheus 里到底有没有对应序列,而不是先怀疑 Grafana。

### 相关命令

- `prometheus` — Kubernetes集群监控系统与时间序列数据库
- `loki` — 水平可扩展的日志聚合系统
- `alertmanager` — Prometheus 告警路由与去重组件
- `helm` — Kubernetes包管理器
- `kubectl` — Kubernetes集群管理工具

### 参考链接

- [Grafana 官方文档](https://grafana.com/docs/grafana/latest/)
- [Grafana Provisioning 文档](https://grafana.com/docs/grafana/latest/administration/provisioning/)
- [grafana-community/helm-charts](https://github.com/grafana-community/helm-charts)
- [Grafana Operator](https://github.com/grafana/grafana-operator)
- [Grafana 配置(grafana.ini)参考](https://grafana.com/docs/grafana/latest/setup-grafana/configure-grafana/)
