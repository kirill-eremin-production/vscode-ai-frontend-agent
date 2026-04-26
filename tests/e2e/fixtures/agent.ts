import { test as vscodeTest } from './vscode';
import { AgentDriver } from '../dsl/agent';

/**
 * Композитная фикстура поверх `vscode.ts`: добавляет `agent` —
 * декларативный driver, через который пишутся сами тесты.
 *
 * Это главная точка импорта для специй: `import { test, expect } from '../fixtures/agent';`
 * Низкоуровневые `vscodeWindow`/`workspacePath`/`scenarioPath` остаются
 * доступными — пригодятся для сложных кейсов (например, прямого
 * чтения файла, которое не покрыто DSL).
 */

export const test = vscodeTest.extend<{ agent: AgentDriver }>({
  agent: async ({ vscodeWindow, workspacePath, scenarioPath }, use) => {
    const agent = new AgentDriver(vscodeWindow, workspacePath, scenarioPath);
    await use(agent);
  },
});

export { expect } from '@playwright/test';
