import * as vscode from 'vscode';

/**
 * Ключ записи в `context.secrets`. Префикс `aiFrontendAgent.` нужен,
 * чтобы не пересечься с другими расширениями — секреты живут в общем
 * keystore VS Code, и коллизия имён означала бы перезапись чужого ключа.
 */
const SECRET_KEY = 'aiFrontendAgent.openRouterApiKey';

/**
 * Прочитать ключ OpenRouter из VS Code SecretStorage.
 * Возвращает undefined, если пользователь его ещё не задал; это
 * штатная ситуация при первом запуске расширения.
 */
export async function getOpenRouterKey(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  return context.secrets.get(SECRET_KEY);
}

/**
 * Сохранить ключ OpenRouter в SecretStorage. Если передать пустую
 * строку — ключ удаляется (полезно для команды «forget API key»,
 * если она появится позже).
 */
export async function setOpenRouterKey(
  context: vscode.ExtensionContext,
  key: string
): Promise<void> {
  if (key.length === 0) {
    await context.secrets.delete(SECRET_KEY);
    return;
  }
  await context.secrets.store(SECRET_KEY, key);
}

/**
 * Интерактивная команда: показать input box и сохранить введённый ключ.
 * Вынесена сюда, а не в `index.ts`, чтобы вся работа с этим секретом
 * (чтение/запись/UI) была сосредоточена в одном модуле.
 *
 * Возвращает true, если ключ сохранён; false — если пользователь
 * отменил ввод. Это позволяет вызывающему коду решать, нужно ли
 * сразу запускать действие, ради которого ключ запросили.
 */
export async function promptForOpenRouterKey(context: vscode.ExtensionContext): Promise<boolean> {
  // password: true — VS Code маскирует ввод и не показывает значение
  // в истории команд. ignoreFocusOut: true — окно не закроется, если
  // пользователь случайно переключился в другое приложение.
  const value = await vscode.window.showInputBox({
    title: 'OpenRouter API key',
    prompt: 'Введите ключ OpenRouter — он будет сохранён в VS Code SecretStorage',
    password: true,
    ignoreFocusOut: true,
    placeHolder: 'sk-or-...',
  });

  // Пустая строка от showInputBox возможна только если пользователь
  // нажал Enter на пустом поле — трактуем это как «не задавать ключ»,
  // чтобы не сохранить заведомо нерабочее значение.
  if (!value) {
    return false;
  }

  await setOpenRouterKey(context, value);
  return true;
}
