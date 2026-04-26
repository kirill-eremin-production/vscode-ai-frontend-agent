import type { Participant } from '@shared/runs/types';
import { Avatar } from '@shared/ui';
import { participantToRoleInfo } from '../lib/roles';

/**
 * Шапка чат-вью со списком аватаров участников сессии (#0041).
 *
 * Берёт `participants` из текущей `SessionSummary` и рисует горизонтальный
 * ряд `Avatar`'ов. Обновляется автоматически при live-апдейте `RunMeta`
 * (webview подписан на `runs.updated` через store) — новый
 * `participant_joined` приводит к добавлению участника в массив, отсюда
 * — к перерисовке этой шапки без перезагрузки.
 *
 * Дубли по роли подавляются (на случай legacy-данных): идентификатор —
 * `kind === 'user' ? 'user' : 'agent:<role>'`. В новых сессиях
 * `pullIntoRoom` (#0036) идемпотентен по роли, но защищаемся от старых
 * meta до миграции.
 */
export interface ParticipantsHeaderProps {
  participants: Participant[];
  /** Дополнительный класс — для встраивания в разные раскладки. */
  className?: string;
}

export function ParticipantsHeader(props: ParticipantsHeaderProps) {
  const unique = dedupeParticipants(props.participants);
  if (unique.length === 0) return null;

  return (
    <div
      className={
        'chat-participants flex items-center gap-1 px-3 py-1 border-b border-border-subtle ' +
        (props.className ?? '')
      }
      role="list"
      aria-label="Участники сессии"
      data-testid="chat-participants"
    >
      {unique.map((participant) => {
        const info = participantToRoleInfo(participant);
        const key = participant.kind === 'user' ? 'user' : `agent:${participant.role}`;
        return (
          <span key={key} role="listitem" data-participant-role={info.role} className="inline-flex">
            <Avatar role={info.role} size="sm" title={info.name} />
          </span>
        );
      })}
    </div>
  );
}

function dedupeParticipants(participants: Participant[]): Participant[] {
  const seen = new Set<string>();
  const result: Participant[] = [];
  for (const participant of participants) {
    const key = participant.kind === 'user' ? 'user' : `agent:${participant.role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(participant);
  }
  return result;
}
