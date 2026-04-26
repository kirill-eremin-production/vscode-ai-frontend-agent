import { ArrowRight } from 'lucide-react';
import { Avatar } from '@shared/ui';
import { formatJoinTime, resolveRoleByName } from '../lib/roles';

/**
 * Компактная строка-системка в ленте чата: «→ <Роль> присоединился в HH:MM»
 * (#0041).
 *
 * Рисуется отдельным маленьким элементом (не bubble), чтобы не «шуметь»
 * рядом с обычными сообщениями: тонкий шрифт, мутед-цвет, small-аватар
 * слева для визуального якоря роли. Источник — событие
 * `participant_joined` из `tools.jsonl`, добавленное `pullIntoRoom`
 * (#0036).
 */
export interface ParticipantJoinedRowProps {
  /** Имя роли как в журнале (`'architect'`, `'programmer'`, …). */
  role: string;
  /** ISO-метка момента входа. */
  at: string;
}

export function ParticipantJoinedRow(props: ParticipantJoinedRowProps) {
  const info = resolveRoleByName(props.role);
  const time = formatJoinTime(props.at);
  return (
    <div
      className="chat-participant-joined flex items-center gap-1 text-[11px] text-muted px-1 py-0.5"
      data-participant-joined-role={info.role}
      data-testid="chat-participant-joined"
    >
      <ArrowRight size={12} aria-hidden />
      <Avatar role={info.role} size="sm" title={info.name} />
      <span>
        {info.name} присоединился в {time}
      </span>
    </div>
  );
}
