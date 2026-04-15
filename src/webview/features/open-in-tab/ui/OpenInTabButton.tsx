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
  const handleClick = () => {
    vscode.postMessage({ type: 'openInTab' });
  };

  return (
    <button type="button" onClick={handleClick}>
      Open in editor tab
    </button>
  );
}
