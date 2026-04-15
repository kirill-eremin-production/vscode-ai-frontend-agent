import { useMessageLog } from '../model/useMessageLog';

/**
 * Виджет-журнал входящих сообщений от extension host.
 * Сам по себе ничего не отправляет — только подписывается через
 * `useMessageLog` и рендерит накопленный список в `<pre>`.
 *
 * Почему это отдельная фича, а не часть `ping-extension`:
 * журнал отображает события от ЛЮБОГО источника в host (не только
 * ответы на ping), поэтому привязывать его к конкретному отправителю
 * было бы неправильно — это нарушило бы single responsibility.
 */
export function MessageLog() {
  const log = useMessageLog();

  return <pre>{log.join('\n')}</pre>;
}
