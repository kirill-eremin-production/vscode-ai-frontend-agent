import { vscode } from '@shared/api/vscode';

/**
 * Кнопка-зонд, которая отправляет сообщение `ping` в extension host
 * и тем самым проверяет, что канал webview <-> host жив. Никакого
 * локального состояния у фичи нет: ответ (`pong`) принимает отдельная
 * фича `message-log`, потому что это другая ответственность.
 *
 * Почему это отдельная фича, а не просто кнопка внутри страницы:
 * по FSD каждая пользовательская «единица действия» живёт в своей
 * папке `features/*`, чтобы её можно было переиспользовать или удалить
 * вместе со всем её UI/моделью одним движением.
 */
export function PingButton() {
  // Обработчик клика намеренно тривиальный — вся логика общения
  // с внешним миром инкапсулирована в `vscode.postMessage`.
  const handleClick = () => {
    vscode.postMessage({ type: 'ping' });
  };

  return (
    <button type="button" onClick={handleClick}>
      Ping extension
    </button>
  );
}
