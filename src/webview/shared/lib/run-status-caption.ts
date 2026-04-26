import type { RunMeta, ToolEvent } from '@shared/runs/types';
import type { Role } from '@shared/ui';

/**
 * Единый источник «осмысленных подписей» для лоадеров (#0022, US-23).
 *
 * Чистая функция: на вход — статус рана + хронология tool-событий
 * видимой сессии + роль, чью активность описываем. На выход —
 * `kind` (для цвета/иконки) + готовая русская подпись.
 *
 * Используется в шапке RunDetails, в подписях кнопок-агентов на
 * канвасе (#0024), и потенциально — в табах сессий. Один источник
 * правды, чтобы «архитектор думает…» в шапке и на канвасе совпадали.
 */
export type RunActivityKind =
  | 'idle'
  | 'thinking'
  | 'tool'
  | 'awaiting_user'
  | 'awaiting_human'
  | 'failed'
  | 'done';

export interface RunActivity {
  kind: RunActivityKind;
  label: string;
}

export interface DescribeRunActivityInput {
  meta: Pick<RunMeta, 'status'>;
  tools: ToolEvent[];
  role: Role;
}

const ROLE_LABEL: Record<Role, string> = {
  product: 'Продакт',
  architect: 'Архитектор',
  user: 'Вы',
  system: 'Система',
};

export function describeRunActivity(input: DescribeRunActivityInput): RunActivity {
  const { meta, tools, role } = input;
  const roleLabel = ROLE_LABEL[role] ?? role;

  switch (meta.status) {
    case 'draft':
      return { kind: 'idle', label: 'Готовлюсь к запуску…' };
    case 'awaiting_user_input':
      return { kind: 'awaiting_user', label: `${roleLabel} ждёт твой ответ` };
    case 'awaiting_human':
      return { kind: 'awaiting_human', label: 'Готово — твой ход' };
    case 'failed': {
      const reason = lastErrorReason(tools);
      return { kind: 'failed', label: reason ? `Ошибка: ${reason}` : 'Ошибка выполнения' };
    }
    case 'done':
    case 'compacted':
      return { kind: 'done', label: 'Завершено' };
    case 'running': {
      const pending = lastPendingToolCall(tools);
      if (pending) {
        return { kind: 'tool', label: `${roleLabel}: вызов \`${pending}\`…` };
      }
      return { kind: 'thinking', label: `${roleLabel} думает…` };
    }
    default:
      return { kind: 'idle', label: '' };
  }
}

/**
 * Имя последнего tool_call, для которого ещё не пришёл tool_result.
 * Если все calls завершены — undefined (значит модель «думает»,
 * а не ждёт результата тула).
 */
function lastPendingToolCall(tools: ToolEvent[]): string | undefined {
  const completed = new Set<string>();
  for (const event of tools) {
    if (event.kind === 'tool_result') completed.add(event.tool_call_id);
  }
  for (let i = tools.length - 1; i >= 0; i--) {
    const event = tools[i];
    if (event.kind !== 'assistant') continue;
    if (!event.tool_calls || event.tool_calls.length === 0) continue;
    for (let j = event.tool_calls.length - 1; j >= 0; j--) {
      const call = event.tool_calls[j];
      if (!completed.has(call.id)) return call.name;
    }
  }
  return undefined;
}

function lastErrorReason(tools: ToolEvent[]): string | undefined {
  for (let i = tools.length - 1; i >= 0; i--) {
    const event = tools[i];
    if (event.kind === 'tool_result' && event.error) return shorten(event.error);
    if (event.kind === 'system' && /ошибк|fail|fatal/i.test(event.message))
      return shorten(event.message);
  }
  return undefined;
}

function shorten(text: string, limit = 80): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine;
}
