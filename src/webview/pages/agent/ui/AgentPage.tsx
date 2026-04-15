import { MessageLog } from '@features/message-log';
import { OpenInTabButton } from '@features/open-in-tab';
import { PingButton } from '@features/ping-extension';

/**
 * Главная (и пока единственная) страница webview-агента.
 *
 * По FSD страница — это композиция фич и виджетов в готовый layout.
 * Она НЕ должна содержать собственной бизнес-логики, не должна знать
 * о внутреннем устройстве фич и не должна напрямую звать VS Code API.
 * Если страница начинает «думать» — это сигнал, что логику пора
 * вынести в новую фичу или в `model/` существующей.
 *
 * Структура намеренно тривиальная: заголовок + кнопки + журнал.
 * Дальнейшее усложнение (роутинг, табы, сайдбары) делается ровно
 * здесь — добавлением виджетов или подстраниц, а не разрастанием фич.
 */
export function AgentPage() {
  return (
    <main className="app">
      <h1>AI Frontend Agent</h1>
      <p>React 19 scaffold готов. Дальше — собственный UI агента.</p>
      <PingButton />
      <OpenInTabButton />
      <MessageLog />
    </main>
  );
}
