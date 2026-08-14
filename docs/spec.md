# Spec: Confid — MVP（零留存 P2P 私密聊天）

> 版本 0.1 · 2026-08-13 · **状态：已批准并发布（v0.1.0，2026-08-14）**
> 本文是 MVP 的初始契约。实现演进与协议细节见
> [PROTOCOL.md](PROTOCOL.md)（协议规范）与 [DEPLOY.md](DEPLOY.md)（部署）。

## Objective

为律师 / 医生 / 心理咨询师 / 顾问 与其客户提供**零留存 + 端到端加密**的 1v1 私密沟通。
MVP 交付一个可用的双人加密聊天闭环：创建会话 → 邀请链接 → 加入 → 加密握手 → 指纹验证 → 双向消息。
**已全部交付（v0.1.0）**，并额外完成：P2P 文件传输（律师发合同场景）、CI 自动化、单进程 Docker 部署。

**零留存承诺（架构级硬约束）**：信令服务器只做 NAT 穿透握手（转发 SDP/ICE），不持久化任何数据、不记录消息内容；消息本身永不经过服务器（WebRTC DataChannel 直连）。

**成功标准（MVP）**：
- [x] 两台不同网络环境下的浏览器可完成全流程（创建 → 加入 → 握手 → 消息往返）
- [x] 信令服务器零留存可审计：无持久化存储、日志不含消息内容、重启即失全部状态
- [x] 关闭页面后无历史残留（不落盘、无账号）
- [x] client/signaling 全部测试、typecheck、lint、build 通过

## Tech Stack

| 组件 | 选型 | 版本 |
|---|---|---|
| 前端 | React + TypeScript + Vite | React 19 / TS 5 / Vite 6 |
| UI | Tailwind CSS + 自研组件 | Tailwind 4 |
| 状态 | useReducer（UI 状态机；原计划 Zustand 未采用） | — |
| P2P | 原生 WebRTC（RTCPeerConnection + DataChannel） | — |
| 加密 | Web Crypto：ECDH P-256 + HKDF-SHA256 + AES-GCM | — |
| 信令 | Go（单二进制，内存态 hub） | Go 1.23 |
| 测试 | Vitest（单测）+ Playwright（E2E）+ Go test | — |
| Lint | ESLint + Prettier + tsc --noEmit | — |
| CI | GitHub Actions（build/test/lint/vet/E2E/docker） | — |
| License | AGPL-3.0 | — |

## Commands

```bash
# 前端
cd client && npm install
npm run dev          # Vite dev server (默认 5173)
npm run build        # tsc --noEmit && vite build
npm test             # vitest run
npm run lint         # eslint + prettier --check

# 信令服务器
cd signaling
go run ./cmd/server          # 默认 :8787
go test ./...
go vet ./...

# E2E（需 client dev + signaling 已启动）
cd e2e && npx playwright test
```

## Project Structure（实际，v0.1.0）

```
confid/
├── docs/
│   ├── spec.md              # 本文件（MVP 契约）
│   ├── PROTOCOL.md          # 协议规范（零留存审计契约）
│   └── DEPLOY.md            # 部署指南
├── client/                  # React 前端
│   ├── src/
│   │   ├── App.tsx          # 视图路由（按状态机 phase）+ UI 组件
│   │   ├── features/session/
│   │   │   ├── sessionMachine.ts   # 会话状态机（纯 reducer，协议正确性）
│   │   │   ├── sessionMachine.test.ts
│   │   │   └── useSession.ts       # 编排：信令/WebRTC/加密/文件传输 → 状态机事件
│   │   └── lib/
│   │       ├── crypto.ts    # ECDH → HKDF → AES-GCM，指纹
│   │       ├── webrtc.ts    # RTCPeerConnection/DataChannel 封装（含背压阈值）
│   │       ├── signaling.ts # WebSocket 信令客户端 + 协议编解码
│   │       ├── fileTransfer.ts # 文件分片/重组/校验（纯逻辑）
│   │       └── base64.ts    # 二进制 <-> base64（共享）
│   └── tests/setup.ts       # jsdom WebCrypto 注入
├── signaling/               # Go 单二进制，纯内存房间注册表 + 消息转发
│   ├── cmd/server           # -addr / -static flag、cleaner、TLS 超时
│   └── internal/
│       ├── hub/             # 房间管理（TTL 过期、限流配合）
│       ├── protocol/        # 信令消息契约
│       └── server/          # WebSocket 传输 + 静态托管 + 安全头 + 每 IP 限流
├── e2e/                     # Playwright 双页面测试 + qa-dogfood.mjs
├── .github/workflows/ci.yml # CI（build/test/lint/vet/E2E/docker）
└── Dockerfile               # 单进程镜像（前端+信令）
```

## Code Style

- TypeScript `strict: true` + `noUncheckedIndexedAccess`；禁止 `any`（例外需注释理由）
- React：函数组件 + hooks；无类组件
- 开发惯例：
  - **p2p 连接生命周期**（creating → waiting → handshaking → verifying → active / failed / closed，含超时与重连）用显式状态机建模：命名状态 + 事件 + 守卫 + 失败恢复（协议正确性要求）
  - **UI 交互状态**：产出 Interaction Contract（状态/事件/转换表，可很小），实现机制按复杂度选（useState/useReducer/库），不一律状态机化
  - 禁魔数（具名常量 + 注释）
  - 加密/握手/协议代码先写测试（TDD）
  - 提交前 build/test/lint/vet 全绿
- Go：标准库优先；错误必须处理（不吞错）；无全局可变状态（hub 由 server 持有）
- commit message：英文单行标题，conventional 前缀（`feat:`/`fix:`/`refactor:`/`docs:`/`ci:`），**无 body**（与仓库历史一致）

## Testing Strategy

| 层级 | 工具 | 覆盖 |
|---|---|---|
| 单测（crypto） | Vitest | ECDH 握手向量、HKDF 派生、AES-GCM 加解密往返、指纹计算 |
| 单测（协议） | Vitest + Go test | 信令 JSON 编解码、非法消息拒绝（两端） |
| 单测（状态机） | Vitest | 会话状态机全路径（含异常：拒绝、超时、断连、重连）+ `acceptsSignal` 角色守卫 |
| 单测（文件传输） | Vitest | 分片/重组字节保真、meta 校验、乱序/超量拒绝 |
| 集成（server） | Go test | 创建者/加入者断开双向通知、房间 TTL、静态托管、安全头、每 IP 限流 |
| E2E | Playwright | 双浏览器真实 P2P：创建→加入→握手→指纹确认→消息往返→文件传输字节级校验 |
| 探索性 QA | qa-dogfood.mjs | 17 项场景（XSS/emoji/长消息/指纹拒绝/重入/断线/刷新） |

## Boundaries

- **Always**：提交前 `npm run build` + `npm test` + `npm run lint` + `go test ./...` 全绿；加密代码先写测试；commit 单行无 body
- **Ask first**：新增第三方依赖；信令协议字段变更；任何触碰"零留存"承诺的改动（持久化、日志、消息内容处理）；CI 配置；部署架构；群组/多设备等产品方向改动（需先决策）
- **Never**：提交密钥/凭据；信令服务器持久化或记录消息内容；删除/禁用测试；向公开仓库写入本机路径、用户名、工作流文件名（PROJECT-CONTEXT.md、tasks/）

## Success Criteria（验收清单）

- [x] E2E 全流程通过（双浏览器、双网络环境）
- [x] 信令服务器：`go test ./...` 通过；代码审计可见无持久化、日志不含消息内容
- [x] 指纹不一致时用户可识别并中止（防 MITM 路径有测试）
- [x] 关闭/刷新页面后无历史残留
- [x] 所有门禁全绿（build/test/lint/typecheck/vet）

## Open Questions

1. 产品正式命名（暂用 "Confid"；README 曾用 "LibreHaven Secure Chat"）
2. ~~托管部署细节~~ → **已解决**（docs/DEPLOY.md：单进程 Docker + Caddy 反代）
3. ~~邀请链接过期策略（默认 30 分钟？）~~ → **已实现**（hub InviteTTL=30min，第二人加入后失效）
4. 群组 / 多设备：产品方向决策（群组=mesh 重构；多设备=与零留存/无账号承诺冲突），需求验证前不启动
