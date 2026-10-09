# 鸿蒙模拟器 → 宿主机 网络可达性 spike 结论

> 状态：**已完成**。结论：**`127.0.0.1` 不通，必须用宿主机局域网 IP 或 `hdc rport`。**
> 实测日期：2026-10-07 ｜ 设备：`Pura 90 Pro`（x86_64）｜ hdc 3.2.0f

## 为什么必须做

这条不通，鸿蒙端的**演示**就是零 —— 网络端口实现与自检都要跟着改。
另外它直接决定网络层 URL 怎么写、以及 `verify-ohos.mjs` 要不要加一条前置步骤。

## 环境

- 模拟器实例：`Pura 90 Pro`（`phone_all_x86` 镜像）
  ```
  "D:/software/DevEco Studio/tools/emulator/Emulator.exe" -start "Pura 90 Pro" \
    -instancePath "C:/Users/Administrator/AppData/Local/Huawei/Emulator/deployed" \
    -imageRoot "C:/Users/Administrator/AppData/Local/Huawei/Sdk"
  ```
- 宿主机 server：`node:http` 监听 `0.0.0.0:3901`，任意路径返回 `pong-from-host`
- 宿主机 IP：`192.168.1.6`（WLAN）

> 端口用 3901 而不是计划原文的 3001 —— 本机 3001 已被一个反向代理占着
> （访问它返回 `502 upstream connect failed`）。spike 要的是"确认有宿主机的可达通路"，
> 用确定空闲的端口能排除"代理在中间捣鬼"这个变量。

## ① 不加 `ohos.permission.INTERNET`（基线）

`module.json5` 当时**一条 `requestPermissions` 都没有**。三种 URL 全部：

```
[NETPROBE] url=http://127.0.0.1:3901/ping  ok=false throw code=201 msg=Permission denied
[NETPROBE] url=http://192.168.1.6:3901/ping ok=false throw code=201 msg=Permission denied
[NETPROBE] url=http://localhost:3901/ping   ok=false throw code=201 msg=Permission denied
```

**`code=201 Permission denied`** —— 这是"权限确实必需"的反向证据。
`INTERNET` 属 `system_grant`（安装即授予、无弹窗），但**不声明就是不通**。

## ② 加权限之后（三种方式）

`module.json5` 加：
```json5
"requestPermissions": [{ "name": "ohos.permission.INTERNET" }]
```

| 方式 | URL | 结果 | 判定 |
|---|---|---|---|
| a 直连 loopback | `http://127.0.0.1:3901/ping` | ❌ `code=2300007` Failed to connect | **不通** |
| a' `localhost` | `http://localhost:3901/ping` | ❌ `code=2300007` Failed to connect | **不通** |
| **b 局域网 IP** | `http://192.168.1.6:3901/ping` | ✅ `code=200 body=pong-from-host` | **通** |
| **c rport 后 loopback** | 先 `hdc rport tcp:3901 tcp:3901` → `http://127.0.0.1:3901/ping` | ✅ `code=200 body=pong-from-host` | **通** |

**核心事实：鸿蒙模拟器没有 Android 那种 `10.0.2.2` 映射宿主机。**
`127.0.0.1` 指向模拟器自己 → 必须走宿主机的**局域网 IP**，或用 `hdc rport` 打通。
**别照搬 Android 的结论。**

`hdc rport` 语法（`hdc -h` 原文）：
```
rport remotenode localnode   - Reserve remote traffic to local host
```
本次即 `hdc rport tcp:3901 tcp:3901`；`hdc fport ls` 可确认：
`127.0.0.1:5555    tcp:3901 tcp:3901    [Reverse]`。

## ③ 反向断言（证明 ② 的 ✅ 不是假绿）

关掉宿主机 server 后重起应用：

```
[NETPROBE] url=http://127.0.0.1:3901/ping  ok=false throw code=2300056 msg=Failed to receive data from the peer
[NETPROBE] url=http://192.168.1.6:3901/ping ok=false throw code=2300028 msg=Operation timeout
[NETPROBE] url=http://localhost:3901/ping   ok=false throw code=2300056 msg=Failed to receive data from the peer
```

**三处全 ❌，且失败码不同**，两种通路的失败模式可区分：
- rport 路径（`127.0.0.1`/`localhost`）`2300056` —— TCP 连上了（连到 hdc server），peer 拿不到数据
- 直连局域网 IP `2300028` —— TCP 都连不上，超时

## ④ 明文 `http://` 有没有被平台策略拦？

**没有。** 方式 b 直接以 `http://192.168.1.6:3901` 明文成功返回 200 ——
鸿蒙模拟器上**没有**等价 Android cleartext 的拦截。所以网络层**不需要**配 `network_config`
白名单（除非真机有别的策略，本结论只覆盖模拟器）。

## 演示时用哪一种

**主用 c（`hdc rport`），备选 b（局域网 IP）。**

| | 优点 | 代价 |
|---|---|---|
| **c rport** ✅ 推荐 | 地址稳定（恒为 `127.0.0.1`）；不动 Windows 防火墙；与"navigate 也跑在宿主机"的实际情况天然对齐 | 每次起模拟器后要跑一次 `hdc rport` → **要写进 `verify-ohos.mjs` 前置步骤** |
| b 局域网 IP | 零前置步骤 | IP 是 DHCP 分配的，**换网络就失效**；且要处理防火墙入站 |

→ 因此鸿蒙壳的地址**要可配置**，并在 `verify-ohos.mjs` 里自动建立 rport，
不要把一个局域网 IP 硬编码进产品代码。

## 复现方式

```bash
# 宿主机
node -e "require('http').createServer((q,r)=>{r.end('pong-from-host')}).listen(3901,'0.0.0.0')"
# 建立反向转发（备选通路）
hdc rport tcp:3901 tcp:3901
# 起应用后抓证据
hdc shell hilog -x | grep NETPROBE
```

## 顺带产出

`entry/src/main/module.json5` 已加 `ohos.permission.INTERNET`（本卡独立 commit）。
