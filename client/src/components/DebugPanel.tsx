import type { DebugEvent, SessionDebug } from '../features/session/useSession';
import type { SessionState } from '../features/session/sessionMachine';

// DebugPanel renders protocol/ICE diagnostics for the current session.
// Only mounted in debug mode (see lib/debugMode.ts); styled to be read by
// a developer, not a user — it deliberately looks like instrumentation.
export function DebugPanel({
  debug,
  state,
}: {
  debug: SessionDebug;
  state: SessionState;
}) {
  const { ice, connectionState, gatheringState, events } = debug;
  const lastEvents = events.slice(-12).reverse();
  return (
    <details
      open
      className="border-t border-slate-800 bg-slate-950/80 px-4 py-2 font-mono text-[11px] leading-5 text-slate-500"
      data-testid="debug-panel"
    >
      <summary className="cursor-pointer select-none text-slate-400">
        Debug · {state.phase}
        {state.phase === 'failed' || state.phase === 'closed' ? ` · ${state.reason}` : ''}
      </summary>
      <div className="mt-1 grid grid-cols-2 gap-x-6 gap-y-0.5 sm:grid-cols-4">
        <span>phase: {state.phase}</span>
        <span>conn: {connectionState}</span>
        <span>gather: {gatheringState}</span>
        <span>
          ice: host {ice.host} / srflx {ice.srflx} / relay {ice.relay} / ? {ice.unknown}
        </span>
      </div>
      <ol className="mt-1 max-h-40 overflow-y-auto" data-testid="debug-events">
        {lastEvents.map((ev: DebugEvent, i: number) => (
          <li key={`${ev.t}-${i}`} className="truncate">
            <span className="text-slate-600">{ev.t}ms</span> {ev.event}
            {ev.detail ? <span className="text-slate-600"> · {ev.detail}</span> : null}
          </li>
        ))}
        {lastEvents.length === 0 && <li>(no events yet)</li>}
      </ol>
    </details>
  );
}
