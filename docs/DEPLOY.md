# 部署指南（self-hosted）

> 单进程部署：Go 二进制同时服务前端静态文件与 `/ws` 信令端点——一个容器、一个端口、零外部依赖。

## 架构

```
浏览器 (页面 + WebRTC)
   │  HTTPS (页面/静态) + WSS (信令)
   ▼
[ 反代（可选，TLS 终止）]
   ▼
Confid 单进程（:8787）
   ├── /          → 前端静态文件（dist）
   ├── /ws        → WebSocket 信令（纯内存，零持久化）
   └── /healthz   → 健康检查（200 ok）
```

- **消息永远不经过服务器**：WebRTC DataChannel 点对点直连；信令只转发 SDP/ICE。
- **零留存**：房间与连接全部在内存，进程退出即失；日志仅连接生命周期事件，不含消息内容。
- **前端 hash 路由**（`#/join/<code>`）：静态目录直出即可，无需 SPA fallback。

## Docker 部署

```bash
# 构建（多阶段：node 构建前端 → golang 构建二进制 → scratch 运行时，~20MB）
docker build -t confid .

# 运行（单容器单进程）
docker run -d --name confid -p 8787:8787 --restart unless-stopped confid

# 验证
curl -s localhost:8787/healthz   # → ok
```

打开 `http://localhost:8787/` 即可使用。

## TLS / WSS（生产必须）

信令走 `wss://` 才能保证端到端路径的机密性（浏览器要求安全上下文才启用部分 WebCrypto 能力）。最简单方案是 Caddy 反向代理（自动 Let's Encrypt）：

```caddyfile
confid.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

```bash
docker run -d --name caddy -p 80:80 -p 443:443 \
  -v $PWD/Caddyfile:/etc/caddy/Caddyfile \
  -v caddy_data:/data \
  -v caddy_config:/config \
  caddy:2
```

Caddy 自动终止 TLS（HTTPS + WSS），Confid 进程保持明文 HTTP 在 127.0.0.1 即可。
HSTS 由反代配置（或 Confid 直接 TLS 时自动发送）。

## 安全基线（内置）

| 控制 | 说明 |
|---|---|
| 每 IP 连接上限 | 默认 10 个并发 WebSocket（防连接洪水），超限返回 429 |
| 安全响应头 | X-Frame-Options: DENY / nosniff / Referrer-Policy / CSP（含 frame-ancestors 'none'） |
| HSTS | 仅当 Confid 自己终止 TLS 时发送（反代场景由反代配置） |
| Slowloris | ReadHeaderTimeout 10s |
| 邀请过期 | 房间 30 分钟无人加入自动回收（后台 cleaner，1 分钟粒度） |

## 运维注意

- **无持久化**：重启即清空所有房间与连接——设计使然（零留存承诺），也意味着无需备份数据库。
- **水平扩展**：当前为单实例设计（房间纯内存）。多实例需要共享房间状态，会触碰零留存承诺——1v1 场景下单实例可承载数千并发房间。
- **资源**：内存占用随活跃房间数线性增长；无磁盘写入（日志走 stdout，建议容器日志轮转）。
- **健康检查**：`/healthz` 返回 `ok`；配合编排系统（k8s/consul）做存活探测。

## 本地开发（非 Docker）

见 README「快速开始」：`go run ./cmd/server`（仅信令）+ `npm run dev`（Vite，代理 /ws）。
生产形态只需一条命令：`./signaling -addr :8787 -static ./client/dist`。
