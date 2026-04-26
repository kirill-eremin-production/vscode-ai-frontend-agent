import { ExternalLink } from 'lucide-react';
import { IconButton } from '@shared/ui';
import { vscode } from '@shared/api/vscode';

/**
 * Кнопка «открыть текущее представление агента в полноценной вкладке
 * редактора». Реальное создание/раскрытие webview-панели делает
 * extension host (см. `AgentPanel`), мы лишь шлём ему сигнал-намерение
 * через сообщение `openInTab`.
 *
 * Вынесено в отдельную фичу, потому что:
 *  - это самостоятельный пользовательский сценарий с собственной кнопкой;
 *  - его легко удалить/спрятать целиком, не задевая остальные фичи;
 *  - в будущем здесь может появиться model-слой (например, состояние
 *    «открыто/закрыто» или превью).
 */
export function OpenInTabButton() {
  return (
    <IconButton
      aria-label="Открыть в вкладке редактора"
      title="Открыть в вкладке редактора"
      icon={<ExternalLink size={14} aria-hidden />}
      onClick={() => vscode.postMessage({ type: 'openInTab' })}
    />
  );
}
