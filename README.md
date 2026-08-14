# Confid

> 零留存 + 端到端加密的专业沟通工具 —— 为律师、医生、心理咨询师、顾问与其客户的合规私密沟通而设计。

## 核心承诺

- **零留存**：信令服务器只做 NAT 穿透握手，不落日志、不存消息；消息本身纯 P2P 直连，从不经过服务器
- **端到端加密**：ECDH P-256 密钥交换 + HKDF 派生 + AES-GCM 加密，全部在浏览器内完成，服务器无可解密材料
- **无账号、无手机号**：客户侧打开即用，零门槛接入
- **身份验证**：双方公钥指纹（SHA-256）人工比对，防止中间人攻击
- **开源可审计**：AGPL-3.0，零留存承诺可被任何人验证

## 快速开始（开发）

```bash
# 1. 信令服务器（Go 1.23+）
cd signaling
GOPROXY=https://goproxy.cn,direct go run ./cmd/server -addr :8787

# 2. 前端（Node 22+）
cd client
npm install
npm run dev        # http://localhost:5173

# 3. 使用：页面点击"创建安全会话"，把邀请链接/会话码发给对方
```

## 快速开始（Docker，单进程部署）

```bash
# 构建并运行（同一进程服务前端 + 信令，详见 docs/DEPLOY.md）
docker build -t confid .
docker run -p 8787:8787 confid
# 打开 http://localhost:8787/
```

## 使用流程

1. 创建者点击「创建安全会话」，获得 6 位会话码与邀请链接（`#/join/<code>`）
2. 对方打开链接或输入会话码加入
3. 双方自动完成 WebRTC 握手与密钥交换，显示对方指纹
4. 口头比对指纹一致后确认，开始加密通信
5. 无账号、无历史落盘——刷新或关闭即无残留

## 测试

```bash
# 单元测试 + 类型检查 + lint（client）
cd client && npm run build && npm test && npm run lint

# 信令服务器
cd signaling && go vet ./... && go test ./...

# E2E（自动启动 signaling + vite；使用系统 Edge，无需下载浏览器）
cd e2e && npx playwright test
```

## 架构

```
client/src/
├── features/session/
│   ├── sessionMachine.ts   # 会话生命周期状态机（纯 reducer，协议正确性）
│   └── useSession.ts       # 编排：信令/WebRTC/加密 → 状态机事件
└── lib/
    ├── crypto/             # ECDH → HKDF → AES-GCM，指纹
    ├── webrtc/             # RTCPeerConnection/DataChannel 封装
    └── signaling/          # WebSocket 信令客户端 + 协议编解码

signaling/                  # Go 单二进制，纯内存房间注册表 + 消息转发
├── cmd/server
└── internal/
    ├── hub/                # 房间管理（重启即失，零持久化）
    ├── protocol/           # 信令消息契约
    └── server/             # WebSocket 传输
```

**协议要点**（详见 [docs/PROTOCOL.md](docs/PROTOCOL.md)——零留存可审计的契约文本，及 [docs/DEPLOY.md](docs/DEPLOY.md)）：

- 信令（WS JSON）：`create/created/join/joined/peer_joined/signal/peer_left/error`，房间码 6 位去混淆字符
- 密钥协商：创建者生成随机盐随 offer 传输（双方共用）→ DataChannel 建立后互换公钥 → 各自派生 AES-GCM 会话密钥
- 状态机：`idle → ready → creating/waiting | joining → handshaking(creator|joiner) → verifying → active | failed | closed`

## License

AGPL-3.0 —— 代码公开可审计，零留存承诺可验证。
