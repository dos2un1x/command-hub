fluentd
===

基于Ruby的日志采集与转发守护进程,插件生态丰富

## 补充说明

**Fluentd** 是 CNCF 毕业的日志采集与统一转发层,用 Ruby 编写。它的核心价值不在采集本身,而在**插件生态与统一路由**:超过 500 个插件覆盖几乎所有存储与消息系统的输入输出,配合 `<match>` 通配与 `@label` 可以把来自不同来源的日志按规则分发到多个后端。

在 Kubernetes 中的典型定位是**中心聚合器**(Aggregator):

```shell
节点级采集     Fluent Bit / Promtail,资源开销小
   ↓ forward 协议
中心聚合       Fluentd,做解析、富化、路由、重试
   ↓
后端存储       Elasticsearch / Loki / Kafka / S3 / 对象存储
```

它也常以 DaemonSet 形态直接跑在每个节点上采集容器日志,但代价是资源占用 —— Ruby 运行时加上一堆 gem 插件,单个 Pod 的内存通常在数百 MB 量级,启动也要十几秒到几十秒。**同样的采集任务,Fluent Bit 的内存占用通常只有 Fluentd 的十分之一左右**,这是选型时最需要权衡的一点。

配置文件由若干指令块组成,通过 Tag 串起来:

```shell
<source>     定义输入,给数据打上 Tag
<filter>     就地加工(富化、过滤、改写字段)
<match>      匹配 Tag 并输出,支持 * 与 ** 通配
<label>      把处理流程分组,便于模块化组织
<system>     全局设置,如日志级别、进程数
@include     引入其它配置文件
```

`<match>` 是路由的核心:`kube.**` 匹配所有以 `kube.` 开头的多级 Tag。**没有被任何 `<match>` 命中的 Tag,数据会被静默丢弃**。

### 安装

```shell
helm repo add fluent https://fluent.github.io/helm-charts/
helm repo update

# DaemonSet 形态,每个节点采集容器日志
helm install fluentd fluent/fluentd -n logging --create-namespace

# 聚合器形态(Deployment)
helm install fluentd-aggregator fluent/fluentd-aggregator -n logging --create-namespace

# 查看 Chart 默认值
helm show values fluent/fluentd > fluentd-values.yaml
```

Chart 默认值要点:

```shell
kind: DaemonSet
image:
  repository: fluent/fluentd-kubernetes-daemonset
  tag: ""                        # 空表示使用 variant 决定
  variant: elasticsearch7        # 镜像变体,决定内置哪些插件
  variantVersion: "1.1"
resources: {}                    # 默认没有任何 requests/limits
plugins: []                      # 启动时用 gem 安装的插件
tolerations: []
service:
  enabled: true
  type: ClusterIP
  ports: []
env: []
podSecurityContext: {}
volumeMounts: []
fileConfigs:
  01_sources.conf: ...           # 输入
  02_filters.conf: ...           # 过滤器
  03_dispatch.conf: ...          # 分发/标签
  04_outputs.conf: ...           # 输出
```

**默认输出同样是 Elasticsearch**(`host "elasticsearch-master"`, `port 9200`,用户 `elastic`,密码占位符 `changeme`),集群里没有这个服务时会持续重试报错。

### 配置结构

```shell
<system>
  log_level info
  <log>
    format json
  </log>
</system>

<source>
  @type tail
  @id in_tail_container_logs
  @label @KUBE
  path /var/log/containers/*.log
  pos_file /var/log/fluentd-containers.log.pos
  tag kubernetes.*
  read_from_head true
  <parse>
    @type cri
    time_key time
    time_format %Y-%m-%dT%H:%M:%S.%N%z
  </parse>
</source>

<label @KUBE>
  <filter kubernetes.**>
    @type kubernetes_metadata
    @id filter_kube_metadata
    kubernetes_url "#{ENV['KUBERNETES_URL']}"
    cache_size 1024
    watch false
  </filter>

  <filter kubernetes.**>
    @type record_modifier
    <record>
      cluster_name "#{ENV['CLUSTER_NAME']}"
    </record>
    remove_keys $.docker.container_id
  </filter>

  <match kubernetes.**>
    @type loki
    url "http://loki-gateway.logging.svc:80"
    <label>
      namespace $.kubernetes.namespace_name
      pod $.kubernetes.pod_name
      container $.kubernetes.container_name
    </label>
    <buffer>
      @type file
      path /var/log/fluentd-buffers/loki.buffer
      flush_mode interval
      flush_interval 5s
      retry_type exponential_backoff
      retry_forever true
      retry_max_interval 30
      chunk_limit_size 2M
      queue_limit_length 8
      overflow_action block
    </buffer>
  </match>
</label>
```

### 缓冲与可靠性

Fluentd 的缓冲区决定了日志会不会丢,是整个配置里最需要认真对待的部分:

```shell
<buffer>
  @type file                       # file 缓冲可落盘,memory 缓冲重启即丢
  path /var/log/fluentd-buffers/app.buffer
  flush_mode interval
  flush_interval 5s
  flush_thread_count 4             # 并发刷盘线程,提高吞吐
  retry_type exponential_backoff
  retry_forever true               # 后端恢复前一直重试
  retry_max_interval 30
  retry_timeout 72h
  chunk_limit_size 4M
  total_limit_size 2G              # 该插件可用的缓冲总量
  queue_limit_length 16
  overflow_action block            # 缓冲满时阻塞输入,而不是丢数据
</buffer>
```

`overflow_action` 有三个取值,语义差别很大:

```shell
throw      缓冲满时抛异常,可能中断采集
block      反压上游,让采集暂停(推荐,数据不丢)
drop_oldest_chunk  丢弃最老的块(会丢数据)
```

### 常用插件

```shell
输入
  in_tail                 读取文件,支持通配与位点记录
  in_forward              接收 Fluent Bit / Fluentd 转发
  in_systemd              读取 journald
  in_http                 HTTP 接收端点
  in_prometheus           以抓取方式读取指标

过滤
  kubernetes_metadata     补 Pod / Namespace / Label 元数据
  record_modifier         增删改字段
  record_transformer      用 Ruby 表达式改写字段
  grep                    按字段排除
  concat                  多行合并(Java 堆栈常用)
  parser                  结构化解析
  throttle                限速去重
  prometheus              暴露自身指标

输出
  out_loki                推送到 Loki
  out_elasticsearch       推送到 Elasticsearch / OpenSearch
  out_kafka               推送到 Kafka
  out_s3                  写入对象存储
  out_forward             转发给上游聚合器
  out_stdout              打印到标准输出,调试用
```

`concat` 插件的多行配置是最常被问到的:

```shell
<filter kubernetes.**>
  @type concat
  key log
  multiline_start_regexp /^\d{4}-\d{2}-\d{2}/
  flush_interval 5
  timeout_label @NORMAL
</filter>
```

### 验证与排障

```shell
kubectl get ds -n logging fluentd
kubectl get po -n logging -l app.kubernetes.io/name=fluentd -o wide
kubectl logs -n logging ds/fluentd --tail=200

# 确认最终生效的配置(镜像会由模板渲染,不要只看 ConfigMap)
kubectl exec -n logging ds/fluentd -- cat /fluentd/etc/fluent.conf
kubectl exec -n logging ds/fluentd -- ls -l /fluentd/etc/

# 校验配置语法
kubectl exec -n logging ds/fluentd -- fluentd --dry-run -c /fluentd/etc/fluent.conf -v

# 查看缓冲积压情况
kubectl exec -n logging ds/fluentd -- ls -lh /var/log/fluentd-buffers/
kubectl exec -n logging ds/fluentd -- du -sh /var/log/fluentd-buffers/

# 内置监控端点
kubectl exec -n logging ds/fluentd -- \
  curl -s localhost:24231/metrics | grep -E "fluentd_output_status|fluentd_buffer"

# 确认已加载的插件
kubectl exec -n logging ds/fluentd -- fluent-gem list | grep fluent-plugin

# 确认宿主机日志路径可见
kubectl exec -n logging ds/fluentd -- ls -l /var/log/containers | head
```

### 注意

1. **默认输出到 Elasticsearch**。Chart 的 `04_outputs.conf` 默认指向 `elasticsearch-master:9200`,并用 `user elastic` / 密码 `changeme`。集群里没有对应服务时 Fluentd 会不断重试并堆满缓冲区,最终因 `overflow_action` 阻塞采集。安装后必须改 outputs。
2. **默认密码 `changeme` 是真实存在的占位符**。如果你的 Elasticsearch 恰好接受这组凭据,日志会明文外发到非预期位置;即使不成功,这个默认值也说明 Chart 的默认配置不适合直接上生产。
3. **Fluentd 的资源开销远大于 Fluent Bit**。Ruby 运行时 + gem 插件让每个 Pod 的基础内存占用就达到数百 MB,加上文件缓冲与并发刷盘线程,聚合器场景常需要 1~2GB。**`resources` 默认为空**,不设 limits 会让 Fluentd 在日志洪峰时吃满节点内存;设得过小则会触发 Ruby GC 抖动甚至 OOMKilled。给 DaemonSet 设 `requests: 200m/512Mi`、`limits: 1/1Gi` 起步,聚合器按吞吐上调。
4. **内存缓冲(`@type memory`)在重启时会丢数据**。生产必须用 `@type file` 并保证缓冲目录落在持久化卷或宿主机路径上。放在 emptyDir 上等于没有缓冲。
5. **`pos_file` 必须持久化**。tail 插件靠位点文件记录读到哪一行,丢失会导致整份日志重推。宿主机重启后若 `/var/log` 被清理,残留日志与位点会不一致,产生重复或漏采。
6. **`overflow_action` 默认值是 `throw`**,缓冲区写满时会抛异常,可能导致采集中断。生产建议显式设为 `block`(反压上游、不丢数据),除非明确接受丢弃最老的数据。
7. **`plugin` 安装发生在容器启动时**。Chart 的 `plugins: []` 会在 entrypoint 里执行 `gem install`,这意味着:启动慢、依赖外网、镜像不可复现。离线集群必须使用自定义镜像并预先装好 gem。
8. **`fileConfigs` 与镜像的 `FLUENT_*` 环境变量是两套配置来源**。`fluent/fluentd-kubernetes-daemonset` 镜像的 entrypoint 会用 `FLUENT_ELASTICSEARCH_HOST` 这类变量渲染配置,而 Chart 的 `fileConfigs` 写的是另一份。同时配置时容易「改了没生效」,排查的第一步永远是 `kubectl exec ... cat /fluentd/etc/fluent.conf` 看实际加载的内容。
9. **`kubernetes_metadata` 过滤器需要 RBAC**。缺少 pods/namespaces 的读权限时日志照样能采,但 `kubernetes.namespace_name`、`kubernetes.pod_name`、`kubernetes.labels` 全为空,后续所有依赖这些字段的路由与标签都会失效。
10. **多行日志需要 `concat` 插件**。CRI 运行时按行写文件,Java 堆栈进来就是一行一条记录。`multiline_start_regexp` 必须能匹配每条日志的首行,否则合并结果错乱;`flush_interval` 过大则日志延迟明显。
11. **`<match>` 未命中会静默丢数据**。调试时先加一段 `<match **> @type stdout </match>` 确认数据确实到达了输出阶段,再排查后端问题。
12. **控制平面节点默认采不到**。`tolerations: []` 意味着 master/control-plane 节点的 `NoSchedule` 污点会把 Pod 挡在外面,需要显式添加 `operator: Exists` 容忍。
13. **`service.ports` 默认为空**。Fluentd 的监控端点(24231)与 forward 端口(24224)不会被暴露,聚合器场景下必须显式声明端口,否则上游 Fluent Bit 无法连接。
14. **日志重复往往来自两处**:一是位点丢失导致重读,二是 Fluent Bit 与 Fluentd 同时采集同一批容器日志。同一节点上只应保留一层文件采集。
15. **`flush_thread_count` 与 `flush_interval` 影响延迟与吞吐**。默认单线程在写入量大的场景会形成瓶颈,表现为缓冲持续增长而后端压力并不高;提高到 2~4 并适当降低 `flush_interval` 通常能明显改善。

### 相关命令

- `fluent-bit` — 轻量级日志与指标采集器
- `loki` — 水平可扩展的日志聚合系统
- `promtail` — Loki 官方日志采集代理
- `kubectl` — Kubernetes集群管理工具
- `helm` — Kubernetes包管理器

### 参考链接

- [Fluentd 官方文档](https://docs.fluentd.org/)
- [Fluentd 配置文件语法](https://docs.fluentd.org/configuration/config-file)
- [Fluentd 缓冲与重试](https://docs.fluentd.org/configuration/buffer-section)
- [Fluentd Kubernetes 部署](https://docs.fluentd.org/container-deployment/kubernetes)
- [fluent/helm-charts](https://github.com/fluent/helm-charts)
