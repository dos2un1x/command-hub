configmap
===

Kubernetes中存放非敏感配置数据并注入Pod的资源对象

## 补充说明

**ConfigMap** 用于把配置数据(配置文件、命令行参数、环境变量)从容器镜像中解耦出来,让同一个镜像可以在不同环境(开发、测试、生产)用不同配置运行,而不必重新构建。

ConfigMap 存的是**明文、非敏感**的键值对。密码、Token、证书这类内容应当放 Secret,尽管两者在使用方式上几乎一样 —— 区别主要在于 Secret 提供了独立的 RBAC 与 etcd 静态加密支持。

ConfigMap 本身只是一份数据,Pod 通过三种方式使用它:环境变量、命令行参数、以及挂载成文件。其中**挂载成文件时可以做到自动更新**,而环境变量方式不会,这是最容易踩的坑。

### 创建方式

```shell
# 从字面量创建
kubectl create configmap app-config \
  --from-literal=LOG_LEVEL=debug \
  --from-literal=MAX_CONN=100

# 从单个文件创建,key 为文件名
kubectl create configmap nginx-conf --from-file=nginx.conf

# 从整个目录创建,目录下每个文件成为一个 key
kubectl create configmap app-conf --from-file=./conf/

# 指定 key 名(而不是用文件名)
kubectl create configmap nginx-conf --from-file=config=nginx.conf

# 从 env 文件创建,文件格式为 KEY=value
kubectl create configmap app-env --from-env-file=app.env

# 从 YAML 创建,推荐用于版本管理
kubectl apply -f configmap.yaml
```

### 语法

```shell
kubectl get configmap [名称] [选项]
kubectl describe configmap [名称]
kubectl create configmap [名称] [数据来源] [选项]
kubectl delete configmap [名称]
```

### YAML 清单

最基础的形态:

```shell
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
  namespace: default
data:
  LOG_LEVEL: debug
  MAX_CONN: "100"
  app.properties: |
    server.port=8080
    server.timeout=30s
    feature.new-ui=true
```

存放二进制内容(如小程序码图片、字体)需要用 `binaryData`,值必须是 base64:

```shell
apiVersion: v1
kind: ConfigMap
metadata:
  name: binary-config
data:
  app.properties: |
    mode=prod
binaryData:
  logo.png: iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==
```

不可变 ConfigMap,可避免 kubelet 频繁 watch 带来的 apiserver 压力,但**创建后不可修改,只能删除重建**:

```shell
apiVersion: v1
kind: ConfigMap
metadata:
  name: immutable-config
data:
  VERSION: v1.0.0
immutable: true
```

### 在 Pod 中使用

注入为环境变量:

```shell
apiVersion: v1
kind: Pod
metadata:
  name: env-demo
spec:
  containers:
    - name: app
      image: busybox:1.36
      command: ["sh", "-c", "env && sleep 3600"]
      env:
        - name: LOG_LEVEL              # 单个 key 注入
          valueFrom:
            configMapKeyRef:
              name: app-config
              key: LOG_LEVEL
      envFrom:
        - configMapRef:
            name: app-config           # 整个 ConfigMap 的所有 key 注入
        - configMapRef:
            name: extra-config
            optional: true             # 不存在时不阻塞 Pod 启动
```

挂载为文件,容器内表现为 `/etc/config/` 目录下的一组文件:

```shell
apiVersion: v1
kind: Pod
metadata:
  name: volume-demo
spec:
  containers:
    - name: app
      image: nginx:1.27
      volumeMounts:
        - name: config-volume
          mountPath: /etc/config
          readOnly: true
  volumes:
    - name: config-volume
      configMap:
        name: app-config
        defaultMode: 0644
```

只挂载其中几个 key,配合 `items` 指定路径与权限:

```shell
apiVersion: v1
kind: Pod
metadata:
  name: items-demo
spec:
  containers:
    - name: app
      image: nginx:1.27
      volumeMounts:
        - name: config-volume
          mountPath: /etc/nginx/conf.d
  volumes:
    - name: config-volume
      configMap:
        name: nginx-conf
        items:
          - key: nginx.conf
            path: default.conf
            mode: 0644
```

### 热更新

ConfigMap 变更后,挂载为卷的内容会自动同步到容器内(默认约 1 分钟,受 kubelet 同步周期与缓存影响)。应用需要自己监听文件变化,例如 nginx 需要执行 reload:

```shell
# 确认 ConfigMap 已更新
kubectl get configmap app-config -o yaml

# 进入 Pod 查看挂载内容是否已同步(注意符号链接指向 ..data)
kubectl exec -it volume-demo -- ls -l /etc/config
kubectl exec -it volume-demo -- cat /etc/config/app.properties

# 让 nginx 重新加载配置
kubectl exec -it volume-demo -- nginx -s reload
```

真正让应用重启以读取新配置(环境变量方式必须这样做):

```shell
kubectl rollout restart deployment/my-app
kubectl rollout status deployment/my-app
```

### 常用操作

```shell
# 查看
kubectl get configmap -A
kubectl get cm app-config -o yaml

# 查看内容(比 -o yaml 可读)
kubectl describe configmap app-config

# 修改
kubectl edit configmap app-config

# 从文件更新(会整体替换该 key)
kubectl create configmap app-config --from-file=app.properties --dry-run=client -o yaml | kubectl apply -f -

# 备份与恢复
kubectl get configmap app-config -o yaml > app-config-backup.yaml
kubectl apply -f app-config-backup.yaml

# 删除
kubectl delete configmap app-config
kubectl delete configmap app-config --ignore-not-found
```

### 注意

1. **ConfigMap 是明文的,不要放敏感数据**。任何能 `kubectl get configmap` 的人都能直接读到内容,`kubectl describe` 甚至不会做任何遮掩,密码写在这里等同于公开。
2. **以环境变量方式注入的 ConfigMap 不会自动更新**。容器一旦启动,环境变量就固定了,改 ConfigMap 必须重启 Pod;而以卷方式挂载的会自动同步(默认约 1 分钟)。
3. **用 `subPath` 挂载的文件不会收到更新**。这是最隐蔽的坑 —— `subPath` 挂载的是文件本身而非目录,kubelet 的原子替换对它无效。若既要挂单个文件又要热更新,只能挂目录,或改用别的方案。
4. **ConfigMap 必须与使用它的 Pod 在同一命名空间**,不能跨命名空间引用。需要共享时得在每个命名空间各建一份,或用工具做同步。
5. **单个 ConfigMap 大小上限约 1MiB**。存大文件应改用对象存储或独立的卷;超过限制会在创建时被 apiserver 拒绝。
6. **`envFrom` 的 key 必须符合环境变量命名规范**。ConfigMap 里带点号或横线的 key(如 `app.properties`、`log-level`)用 `envFrom` 注入会被静默跳过,必须改用 `valueFrom.configMapKeyRef` 逐个指明,且能用 `-` 不能用 `.`。
7. **引用了不存在的 ConfigMap 会让 Pod 卡在 `CreateContainerConfigError`**。卷挂载方式则会卡在 `ContainerCreating`。生产环境建议加 `optional: true`,或确保 ConfigMap 先于工作负载部署。
8. **`immutable: true` 的 ConfigMap 只能删除重建**,而且删除前必须先删掉引用它的 Pod,否则会因「被使用中」而删不掉;好处是能避免误改并显著降低 apiserver 负载。
9. **挂载会覆盖挂载点目录下的原有内容**。把 ConfigMap 挂到 `/etc/nginx` 会隐藏镜像里原有的全部文件,正确做法是挂到 `/etc/nginx/conf.d` 这样的子目录。
10. **`kubectl create configmap --from-file` 对目录中的隐藏文件处理不一致**,以点开头的文件默认会被忽略,批量导入配置时要留意文件是否真的进去了。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `secret` — 存放敏感配置的同类资源
- `namespace` — ConfigMap的作用域边界
- `service` — 常与ConfigMap配合的配置项来源
- `kubeadm` — Kubernetes集群安装与生命周期管理工具

### 参考链接

- [ConfigMap 官方文档](https://kubernetes.io/docs/concepts/configuration/configmap/)
- [配置 Pod 使用 ConfigMap](https://kubernetes.io/docs/tasks/configure-pod-container/configure-pod-configmap/)
- [不可变 ConfigMap](https://kubernetes.io/docs/concepts/configuration/configmap/#configmap-immutable)
