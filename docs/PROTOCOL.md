# Confid 协议规范（Protocol Specification）

> 版本 0.1 · 2026-08-14 · 对应实现：`client/src/`（TS）+ `signaling/`（Go）
> 本文档是**零留存可审计**承诺的契约文本：任何实现必须与本文一致，任何改动须先改本文。

## 1. 概述

Confid 是零留存、端到端加密的 1v1 沟通工具。一次会话由三个阶段组成：

1. **信令**（WebSocket）：创建/加入房间、交换 SDP 与 ICE——由 Confid 服务器转发；
2. **传输**（WebRTC DataChannel）：点对点直连——消息与文件**永不经过服务器**；
3. **加密**（Web Crypto，浏览器内）：ECDH P-256 → HKDF-SHA256 → AES-GCM。

**零留存承诺的精确边界**：服务器只转发 SDP/ICE 与连接事件，不持久化任何数据；
日志仅含连接生命周期事件（IP、房间号、消息类型），**永不包含**消息内容、文件内容、
密钥材料或文件名。

## 2. 传输层

| 通道 | 协议 | 用途 |
|---|---|---|
| 信令 | WebSocket（生产 wss://，经 TLS 反代或直连） | 房间管理、SDP/ICE 中继 |
| 数据 | WebRTC DataChannel（ordered: true，DTLS 加密） | 消息、文件、公钥交换 |

信令端点：`/ws`。健康检查：`/healthz`（200 ok）。

## 3. 信令协议（WebSocket JSON）

### 3.1 消息信封

```json
{ "type": "<string>", "roomId": "<string, optional>", "code": "<string, optional>", "payload": "<opaque JSON, optional>" }
```

`payload` 对服务器是**不透明**的——SDP/ICE 原样转发，服务器不解析其内容（零留存关键设计）。

### 3.2 客户端 → 服务器

| type | 字段 | 语义 |
|---|---|---|
| `create` | — | 创建房间；服务器回 `created` |
| `join` | `roomId` | 加入房间；成功回 `joined`，失败回 `error` |
| `signal` | `payload` | 把 payload 转发给房间内另一端 |

### 3.3 服务器 → 客户端

| type | 字段 | 语义 |
|---|---|---|
| `created` | `roomId` | 房间已创建（6 位码） |
| `joined` | `roomId` | 加入成功 |
| `peer_joined` | — | 另一端已到达（触发创建端发起 offer） |
| `signal` | `payload` | 转发另一端的 payload |
| `peer_left` | — | 另一端已断开 |
| `error` | `code` | 见 3.4 |

### 3.4 错误码

| code | 触发 |
|---|---|
| `room_not_found` | join 不存在的房间（含**邀请已过期**的房间，不区分以不泄露存在性） |
| `room_full` | 房间已有 2 人（1v1 上限） |
| `not_in_room` | 未加入房间就发 signal |
| `malformed` | 消息无法解码 |

### 3.5 房间号

- 长度 6，字符集 `23456789abcdefghjkmnpqrstuvwxyz`（31 字符，排除易混淆 0/O/1/I/l）
- 空间 ≈ 8.9 亿；crypto/rand **拒绝采样**生成（无模偏差）
- **邀请 TTL 30 分钟**：创建后 30 分钟无人加入则房间被回收（后台 cleaner）；
  第二人加入后过期失效（活跃会话不受影响）

### 3.6 服务器行为约束（零留存实现要点）

- 纯内存 hub：进程重启即失全部房间与连接
- 不解析、不记录 `payload` 内容
- 每 IP 并发连接上限（默认 10，超限 429）——防连接洪水
- 所有响应带安全头（X-Frame-Options/nosniff/Referrer-Policy/CSP）

## 4. 会话状态机

双方各持一份状态机（纯 reducer，非法事件静默忽略——协议正确性守卫）：

```
idle → ready → creating → waiting ──peer_joined──→ handshaking(creator)
                    → joining ──joined/offer──→ handshaking(joiner)
handshaking ──keys ready──→ verifying ──verify(match)──→ active
                                        └─verify(mismatch)──→ failed
任意连接态 ──peer_left/error/timeout──→ closed | failed
failed/closed ──retry──→ idle
```

关键守卫：

- **角色编码在状态中**：`handshaking.role` 由进入路径决定（waiting→creator，joining→joiner），不可变更；offer 只由 creator 发出
- **传输层角色守卫**：offer 仅 joiner 处理、answer 仅 creator 处理、ice 双方处理（active 期容忍 trickle 尾包）——恶意方无法驱动本端 SDP 状态机
- 握手/验证超时 30s → `failed`（防死锁）

## 5. 密钥协商（端到端加密）

```
creator                                     joiner
  │ 生成随机 salt（16B hex），本地保存 ──offer 携带 salt──► 提取 salt
  │ DataChannel open → 双方互发 hello（ECDH P-256 公钥 JWK）
  │ ◄────────────── hello ──────────────►
  │ ECDH → HKDF-SHA256(salt, info) → AES-GCM-256 会话密钥
  │ 指纹 = SHA-256(SPKI 公钥) hex，4 字符分组，人工比对
```

- **salt 必须双方一致**：创建者随 offer 发送且本地保存——任一侧缺失/不一致则密钥发散（接收端对无 salt 的 offer 直接报错）
- 会话密钥 **non-extractable**（JS 不可导出）；`info = "confid/session/v1"` 绑定应用上下文
- 指纹显示**对方**的公钥指纹（两侧值不同是预期——各自显示对方的）；一致才能进入 `active`
- 帧格式：`{kind: "hello", data: "<JWK JSON 字符串>"}`

**MITM 模型**：若信令被劫持，攻击者可以替换 offer/hello 中的公钥，但无法伪造双方一致认可的指纹——人工比对是最终防线。**指纹不一致必须中止**。

## 6. DataChannel 应用协议

全部帧为 JSON 文本（binaryType 保持默认 text）。

### 6.1 消息帧

```json
{ "kind": "text", "data": "<base64: [12B 随机 nonce][AES-GCM 密文+tag]>" }
```

- 每条消息独立随机 nonce（12B，AES-GCM 推荐长度）
- 解密失败（篡改/错密钥）静默丢弃

### 6.2 文件传输帧

```json
{ "kind": "file-meta",  "data": { "id": "<uuid>", "name": "...", "size": 123, "mimeType": "application/pdf", "chunks": 4 } }
{ "kind": "file-chunk", "data": { "id": "<uuid>", "seq": 0, "data": "<base64 分片>" } }
```

- 分片 64KB/块（远低于浏览器单帧上限 ~256KB）；`chunks = ceil(size / 64KB)`
- **上限 100MB**：接收方拒绝超限的 `file-meta`（防恶意声明拖垮内存）
- 有序通道保证顺序；接收方校验 id 一致、seq 严格递增、块数不超声明——违规即终止传输并标记失败
- **背压**：发送方在通道缓冲 >1MB 时暂停（`bufferedamountlow`），慢速对端不会撑爆本端内存；阈值在**两侧**通道上设置（offerer 创建与 answerer 接收的通道一致）
- 文件**不经过服务器**：服务器对该帧内容完全不可见

## 7. 安全模型

### 7.1 信任边界

| 边界 | 参与方 | 保护 |
|---|---|---|
| 浏览器 ↔ 信令服务器 | 双方 | TLS（wss）；服务器仅见元数据 |
| 浏览器 ↔ 浏览器 | 两端 | DTLS（WebRTC）+ 应用层 AES-GCM |
| 密钥/消息 | 仅两端 | Web Crypto，服务器无解密材料 |

### 7.2 威胁与缓解

| 威胁 | 缓解 |
|---|---|
| 服务器被攻破（记录消息） | 消息/文件纯 P2P 不经过服务器；架构上无此数据可记录 |
| 信令劫持（MITM） | 指纹人工比对（不一致即拒绝） |
| 房间猜测/枚举 | 8.9 亿空间 + 30 分钟 TTL + 每 IP 连接限流 |
| 恶意 peer 畸形信令 | 状态机非法事件忽略 + 传输层角色守卫 + 帧校验 |
| 恶意 peer 超大文件声明 | file-meta 100MB 上限 |
| XSS | React 文本节点转义 + CSP（script-src 'self'） |
| 连接洪水 | 每 IP 并发上限 + ReadHeaderTimeout |
| 点击劫持 | X-Frame-Options: DENY + CSP frame-ancestors 'none' |

### 7.3 已知限制（有意为之）

- **无账号模型**：邀请链接即凭证——通过不安全渠道（明文邮件/短信）转发链接可能被截获；TTL 与随机性缓解，不消除
- **信令元数据可见**：服务器可观察连接时间、IP、房间号（零留存承诺的是内容，非元数据）
- **无前向秘密持久化**：会话密钥随页面关闭即失（零留存设计使然，也意味着无历史可被窃取）

### 7.4 第三方依赖透明化（STUN/TURN）

- 浏览器通过公共 STUN 服务器发现自身公网地址（当前列表，**全部经 RFC 5389 binding 实测验证**：Google ×2 `stun.l.google.com:19302` / `stun1.l.google.com:19302`、小米 `stun.miwifi.com:3478`——中国大陆可达性必需）
- **STUN 只做地址发现**：binding request/response 不承载任何消息/文件/密钥数据；数据面始终是浏览器间直连（或未来自建 TURN 中继的密文）
- **可见性**：STUN 服务器可观察用户公网 IP 与访问时间（与信令服务器同性质，第三方）；被攻陷的 STUN 最坏导致连接失败（DoS）或把候选指向攻击者——数据面 DTLS + AES-GCM 使其无法解密内容
- **自建部署可替换**：浏览器端 STUN 列表随前端构建分发；机构部署可构建自有 ICE 配置（含私有 TURN）替代公共列表
- **TURN 凭据**（启用时）：信令服务器持 Metered API Key（可创建/删除凭据，**仅服务端**环境变量），经 `GET /turn-credentials` 向浏览器发放凭据（60s 缓存；每 IP 限流 10 次/分钟防额度盗刷；未配置 503，前端降级纯 STUN）。TURN 中继 DTLS 加密流量，中继商无法解密内容；凭据泄漏不危及消息内容（最坏烧掉免费额度导致中继停用）
- **零留存承诺边界**：承诺覆盖信令服务器与协议；公共 STUN 的 IP 可见性属浏览器 WebRTC 标准行为，机构合规评估时应计入

## 8. 兼容性契约

- 协议版本通过 `SESSION_INFO`（HKDF info）与帧 kind 演进；不兼容改动须升 info 常量并同步本文档
- 部署要求：生产必须 wss（TLS），否则信令可被窃听、部分 WebCrypto 能力受限
