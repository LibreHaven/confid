import { useEffect, useRef, useState } from 'react';
import { useSession, type ChatMessage } from './features/session/useSession';
import type { SessionState } from './features/session/sessionMachine';
import { MAX_FILE_BYTES } from './lib/fileTransfer';

// Interaction contract (see docs/spec.md conventions):
//   home    --[create]--> creating --[created]--> waiting --[peer joined]--> handshaking
//   home    --[join code]--> joining --[joined/offer]--> handshaking
//   handshaking --[keys ready]--> verifying --[match?]--> active | failed
//   active  --[peer left/error]--> closed | failed
//   failed/closed --[retry]--> idle(home)

export default function App() {
  const { state, messages, localFingerprint, actions } = useSession();
  const { joinRoom, retry } = actions;

  // Join on invite links (#/join/<roomId>), including hash navigation to a
  // NEW link from a finished session in the same tab.
  useEffect(() => {
    const tryJoinFromHash = () => {
      const match = window.location.hash.match(/#\/join\/([0-9a-z]+)/);
      if (!match || !match[1]) return;
      const phase = state.phase;
      const joinable =
        phase === 'idle' || phase === 'ready' || phase === 'failed' || phase === 'closed';
      // Consume the hash either way: a joinable state joins immediately; a
      // mid-session state ignores the link but must not leave it lingering
      // (it would auto-join on the next RETRY back to idle).
      window.history.replaceState(null, '', window.location.pathname);
      if (!joinable) return;
      if (phase === 'failed' || phase === 'closed') {
        retry(); // terminal states must reset before joining again
      }
      void joinRoom(match[1]);
    };
    tryJoinFromHash();
    window.addEventListener('hashchange', tryJoinFromHash);
    return () => window.removeEventListener('hashchange', tryJoinFromHash);
  }, [joinRoom, retry, state.phase]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 p-4 text-slate-100">
      <div className="w-full max-w-lg">
        <header className="mb-6 text-center">
          <h1 className="text-3xl font-semibold tracking-tight">Confid</h1>
          <p className="mt-1 text-sm text-slate-400">零留存 · 端到端加密 · 专业沟通</p>
        </header>
        <main>
          <View
            state={state}
            messages={messages}
            localFingerprint={localFingerprint}
            actions={actions}
          />
        </main>
        <footer className="mt-8 text-center text-xs text-slate-600">
          消息仅在两台设备间传输，服务器不存储任何内容
        </footer>
      </div>
    </div>
  );
}

interface ViewProps {
  state: SessionState;
  messages: ChatMessage[];
  localFingerprint: string | null;
  actions: ReturnType<typeof useSession>['actions'];
}

function View({ state, messages, localFingerprint, actions }: ViewProps) {
  switch (state.phase) {
    case 'idle':
    case 'ready':
      return <Home actions={actions} />;
    case 'creating':
      return <StatusCard title="正在创建安全会话…" />;
    case 'waiting':
      return <Waiting inviteUrl={state.inviteUrl} actions={actions} />;
    case 'joining':
      return <StatusCard title="正在加入安全会话…" />;
    case 'handshaking':
      return <StatusCard title="正在建立加密通道…" />;
    case 'verifying':
      return (
        <Verify
          localFingerprint={localFingerprint ?? ''}
          remoteFingerprint={state.remoteFingerprint}
          actions={actions}
        />
      );
    case 'active':
      return <Chat messages={messages} actions={actions} />;
    case 'failed':
      return (
        <StatusCard
          title="会话失败"
          detail={state.reason}
          actionLabel="重试"
          onAction={actions.retry}
        />
      );
    case 'closed':
      return (
        <StatusCard
          title="会话已结束"
          detail={state.reason}
          actionLabel="新建会话"
          onAction={actions.retry}
        />
      );
  }
}

function Home({ actions }: { actions: ViewProps['actions'] }) {
  const [roomInput, setRoomInput] = useState('');

  const join = () => {
    const id = roomInput.trim().toLowerCase();
    if (id) void actions.joinRoom(id);
  };

  return (
    <div className="space-y-6 rounded-2xl border border-slate-800 bg-slate-900 p-8">
      <p className="text-sm leading-relaxed text-slate-400">
        为律师、医生、顾问与其客户的敏感沟通而设计。无需账号，消息直接点对点加密传输，
        服务器不落任何记录。
      </p>
      <button
        onClick={() => void actions.createRoom()}
        className="w-full rounded-xl bg-emerald-600 py-3 font-medium text-white transition hover:bg-emerald-500"
      >
        创建安全会话
      </button>
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-slate-800" />
        <span className="text-xs text-slate-500">或</span>
        <div className="h-px flex-1 bg-slate-800" />
      </div>
      <div className="space-y-3">
        <input
          value={roomInput}
          onChange={(e) => setRoomInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && join()}
          placeholder="输入 6 位会话码"
          className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm outline-none placeholder:text-slate-600 focus:border-emerald-500"
        />
        <button
          onClick={join}
          disabled={!roomInput.trim()}
          className="w-full rounded-xl border border-slate-700 py-3 font-medium text-slate-200 transition hover:border-emerald-600 hover:text-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          加入会话
        </button>
      </div>
    </div>
  );
}

function Waiting({
  inviteUrl,
  actions,
}: {
  inviteUrl: string;
  actions: ViewProps['actions'];
}) {
  const [copied, setCopied] = useState(false);
  const roomId = inviteUrl.split('#/join/')[1] ?? '';

  const copy = async () => {
    await navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-5 rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center">
      <p className="text-sm text-slate-400">安全会话已创建，等待对方加入</p>
      <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950 p-4">
        <p
          data-testid="room-code"
          className="font-mono text-2xl tracking-[0.3em] text-emerald-400"
        >
          {roomId}
        </p>
        <p className="mt-2 break-all text-xs text-slate-500">{inviteUrl}</p>
      </div>
      <button
        onClick={() => void copy()}
        className="w-full rounded-xl bg-emerald-600 py-3 font-medium text-white transition hover:bg-emerald-500"
      >
        {copied ? '已复制' : '复制邀请链接'}
      </button>
      <p className="text-xs text-slate-600">把链接发给对方；会话码 30 分钟内有效</p>
      <button
        onClick={actions.retry}
        className="text-xs text-slate-500 underline-offset-2 hover:text-slate-300 hover:underline"
      >
        取消
      </button>
    </div>
  );
}

function Verify({
  localFingerprint,
  remoteFingerprint,
  actions,
}: {
  localFingerprint: string;
  remoteFingerprint: string;
  actions: ViewProps['actions'];
}) {
  return (
    <div className="space-y-5 rounded-2xl border border-slate-800 bg-slate-900 p-8">
      <h2 className="text-lg font-medium">验证对方身份</h2>
      <p className="text-sm text-slate-400">
        请与对方口头比对以下指纹。指纹不一致时切勿继续。
      </p>
      <div className="space-y-3 rounded-xl bg-slate-950 p-4 font-mono text-xs">
        <div>
          <p className="mb-1 text-slate-500">对方指纹</p>
          <p className="break-all text-emerald-400">{remoteFingerprint}</p>
        </div>
        <div>
          <p className="mb-1 text-slate-500">你的指纹</p>
          <p className="break-all text-slate-300">{localFingerprint}</p>
        </div>
      </div>
      <div className="flex gap-3">
        <button
          data-testid="verify-mismatch"
          onClick={() => actions.verifyFingerprint(false)}
          className="flex-1 rounded-xl border border-red-900 py-3 font-medium text-red-400 transition hover:bg-red-950"
        >
          不一致，拒绝
        </button>
        <button
          data-testid="verify-match"
          onClick={() => actions.verifyFingerprint(true)}
          className="flex-1 rounded-xl bg-emerald-600 py-3 font-medium text-white transition hover:bg-emerald-500"
        >
          一致，开始通信
        </button>
      </div>
    </div>
  );
}

function Chat({
  messages,
  actions,
}: {
  messages: ChatMessage[];
  actions: ViewProps['actions'];
}) {
  const [draft, setDraft] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    void actions.sendMessage(text);
    setDraft('');
  };

  const pickFile = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      window.alert(`文件超过上限（${formatBytes(MAX_FILE_BYTES)}）`);
      return;
    }
    void actions.sendFile(file);
    if (fileInput.current) fileInput.current.value = '';
  };

  return (
    <div className="flex h-[26rem] flex-col rounded-2xl border border-slate-800 bg-slate-900">
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="h-2 w-2 rounded-full bg-emerald-500" />
          <span className="text-slate-300">加密通道已建立</span>
        </div>
        <span className="text-xs text-slate-500">端到端加密</span>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="pt-16 text-center text-sm text-slate-600">
            会话开始——发送第一条消息
          </p>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            data-testid={m.kind === 'file' ? 'file-message' : 'message'}
            className={`flex ${m.own ? 'justify-end' : 'justify-start'}`}
          >
            {m.kind === 'text' ? (
              <div
                className={`max-w-[75%] rounded-2xl px-4 py-2 text-sm ${
                  m.own
                    ? 'rounded-br-sm bg-emerald-700 text-white'
                    : 'rounded-bl-sm bg-slate-800 text-slate-200'
                }`}
              >
                {m.text}
              </div>
            ) : (
              <FileCard m={m} />
            )}
          </div>
        ))}
      </div>
      <div className="flex gap-2 border-t border-slate-800 p-3">
        <input
          ref={fileInput}
          type="file"
          data-testid="file-input"
          className="hidden"
          onChange={(e) => pickFile(e.target.files)}
        />
        <button
          data-testid="file-button"
          onClick={() => fileInput.current?.click()}
          title="发送文件（最大 100MB）"
          className="rounded-xl border border-slate-700 px-3 font-medium text-slate-300 transition hover:border-emerald-600 hover:text-emerald-400"
        >
          📎
        </button>
        <input
          data-testid="message-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="输入消息…"
          className="flex-1 rounded-xl border border-slate-700 bg-slate-950 px-4 py-2.5 text-sm outline-none placeholder:text-slate-600 focus:border-emerald-500"
        />
        <button
          data-testid="send-button"
          onClick={send}
          disabled={!draft.trim()}
          className="rounded-xl bg-emerald-600 px-5 font-medium text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          发送
        </button>
      </div>
    </div>
  );
}

/** File message card: name, size, progress, and a download link when done. */
function FileCard({ m }: { m: Extract<ChatMessage, { kind: 'file' }> }) {
  const stateLabel =
    m.state === 'sending'
      ? '发送中'
      : m.state === 'receiving'
        ? '接收中'
        : m.state === 'complete'
          ? '已完成'
          : '传输失败';
  return (
    <div
      data-testid="file-card"
      className={`w-64 rounded-2xl border px-4 py-3 text-sm ${
        m.own
          ? 'rounded-br-sm border-emerald-900 bg-emerald-800/40 text-white'
          : 'rounded-bl-sm border-slate-700 bg-slate-800 text-slate-200'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-lg">📄</span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium" title={m.name}>
            {m.name}
          </p>
          <p className="text-xs opacity-70">
            {formatBytes(m.size)}
            {m.state !== 'failed' && ` · ${stateLabel} ${Math.round(m.progress * 100)}%`}
            {m.state === 'failed' && ` · ${stateLabel}`}
          </p>
        </div>
      </div>
      {m.state === 'complete' && m.url && (
        <a
          data-testid="file-download"
          href={m.url}
          download={m.name}
          className="mt-2 block rounded-lg bg-emerald-600 py-1.5 text-center text-xs font-medium text-white transition hover:bg-emerald-500"
        >
          下载文件
        </a>
      )}
    </div>
  );
}

/** Human-readable byte size (KB/MB). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function StatusCard({
  title,
  detail,
  actionLabel,
  onAction,
}: {
  title: string;
  detail?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center">
      <p className="font-medium text-slate-200">{title}</p>
      {detail && <p className="text-sm text-slate-500">{detail}</p>}
      {actionLabel && onAction && (
        <button
          onClick={onAction}
          className="rounded-xl bg-emerald-600 px-6 py-2.5 font-medium text-white transition hover:bg-emerald-500"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
