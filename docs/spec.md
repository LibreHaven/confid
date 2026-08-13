# Spec: Confid — MVP（零留存 P2P 私密聊天）

> 版本 0.1 · 2026-08-13 · 状态：待审批

## Objective

为律师 / 医生 / 心理咨询师 / 顾问 与其客户提供**零留存 + 端到端加密**的 1v1 私密沟通。
MVP 交付一个可用的双人加密聊天闭环：创建会话 → 邀请链接 → 加入 → 加密握手 → 指纹验证 → 双向消息。

**零留存承诺（架构级硬约束）**：信令服务器只做 NAT 穿透握手（转发 SDP/ICE），不持久化任何数据、不记录消息内容；消息本身永不经过服务器（WebRTC DataChannel 直连）。

**成功标准（MVP）**：
- 两台不同网络环境下的浏览器可完成全流程（创建 → 加入 → 握手 → 消息往返）
- 信令服务器零留存可审计：无持久化存储、日志不含消息内容、重启即失全部状态
- 关闭页面后无历史残留（不落盘、无账号）
- client/signaling 全部测试、typecheck、lint、build 通过

## Tech Stack

| 组件 | 选型 | 版本 |
|---|---|---|
| 前端 | React + TypeScript + Vite | React 19 / TS 5 / Vite 6 |
| UI | Tailwind CSS + 自研组件（shadcn/ui 风格）| Tailwind 4 |
| 状态 | Zustand + useReducer（UI 状态机）| 5.x |
| P2P | 原生 WebRTC（RTCPeerConnection + DataChannel）| — |
| 加密 | Web Crypto：ECDH P-256 + HKDF-SHA256 + AES-GCM | — |
| 信令 | Go（单二进制，内存态 hub）| Go 1.23 |
| 测试 | Vitest（单测）+ Playwright（E2E）+ Go test | — |
| Lint | ESLint + Prettier + tsc --noEmit | — |
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

## Project Structure

```
p2p-chat-system/
├── docs/
│   └── spec.md              # 本文件
├── client/                  # React 前端
│   ├── src/
│   │   ├── app/             # 应用状态机、页面路由（create/join/chat）
│   │   ├── features/
│   │   │   ├── session/     # 会话生命周期（状态机）
│   │   │   ├── identity/    # 指纹展示/验证
│   │   │   └── chat/        # 消息列表、发送
│   │   ├── lib/
│   │   │   ├── crypto/      # ECDH/HKDF/AES-GCM 封装 + 指纹
│   │   │   ├── webrtc/      # RTCPeerConnection 封装（ICE/SDP/DataChannel）
│   │   │   └── signaling/   # WebSocket 信令客户端 + 协议编解码
│   │   └── components/      # 通用 UI 组件
│   └── tests/               # Vitest 单测（与 src 同构）
├── signaling/               # Go 信令服务器
│   ├── cmd/server/main.go
│   └── internal/
│       ├── hub/             # 会话/房间管理（纯内存，重启即失）
│       └── protocol/        # 信令消息类型（JSON over WebSocket）
└── e2e/                     # Playwright 双页面测试
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
- commit message：英文单行标题，conventional 前缀（`feat:`/`fix:`/`refactor:`）

## Testing Strategy

| 层级 | 工具 | 覆盖 |
|---|---|---|
| 单测（crypto） | Vitest | ECDH 握手向量、HKDF 派生、AES-GCM 加解密往返、指纹计算 |
| 单测（协议） | Vitest + Go test | 信令 JSON 编解码、非法消息拒绝（两端） |
| 单测（状态机） | Vitest | 会话状态机全路径（含异常：拒绝、超时、断连、重连）|
| E2E | Playwright | 双浏览器真实 P2P：创建→加入→握手→指纹确认→消息往返；刷新后无残留 |

覆盖率目标：`lib/crypto` 与 `lib/webrtc` 100%（语句级）；整体 ≥ 80%。

## Boundaries

- **Always**：提交前 `npm run build` + `npm test` + `npm run lint` + `go test ./...` 全绿；加密代码先写测试
- **Ask first**：新增第三方依赖；信令协议字段变更；任何触碰"零留存"承诺的改动（持久化、日志、消息内容处理）；CI 配置；部署架构
- **Never**：提交密钥/凭据；信令服务器持久化或记录消息内容；删除/禁用测试；向公开仓库写入本机路径、用户名、工作流文件名（PROJECT-CONTEXT.md、tasks/）

## Success Criteria（验收清单）

- [ ] E2E 全流程通过（双浏览器、双网络环境）
- [ ] 信令服务器：`go test ./...` 通过；代码审计可见无持久化、日志不含消息内容
- [ ] 指纹不一致时用户可识别并中止（防 MITM 路径有测试）
- [ ] 关闭/刷新页面后无历史残留
- [ ] 所有门禁全绿（build/test/lint/typecheck/vet）

## Open Questions

1. 产品正式命名（README 暂用 "LibreHaven Secure Chat"）
2. 托管部署细节（域名、服务器）——MVP 后置
3. 邀请链接过期策略（默认 30 分钟？）
