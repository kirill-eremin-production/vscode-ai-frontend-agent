import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type { TestInfo } from '@playwright/test';
import { launchVSCodeApp, closeAndAttachVideos, type IsolatedDirs } from '../fixtures/vscode';
import { AgentDriver } from './agent';
import type { FakeScenario } from './scenario';

/**
 * Высокоуровневые помощники для durability-тестов, которые сами
 * управляют жизненным циклом Electron-приложения (несколько запусков
 * подряд, рестарты с разными user-data-dir и т.п.).
 *
 * Стандартная фикстура `agent` рассчитана на одну сессию и держит
 * `Page`, который умирает вместе с приложением, поэтому durability
 * сценарии её обходят. Отсюда — этот модуль: тесту хочется писать
 * `withVSCodeSession(...)` и не думать о firstWindow / videos / close.
 */

/**
 * Запустить VS Code на заданных папках, дать тесту поработать с
 * `AgentDriver`'ом и гарантированно закрыть приложение в конце,
 * приложив видео к отчёту. Имя сессии используется в названии папки
 * с видео и префиксе аттача — удобно различать кадры в HTML-репортере.
 */
export async function withVSCodeSession(
  dirs: IsolatedDirs,
  testInfo: TestInfo,
  sessionName: string,
  fn: (agent: AgentDriver) => Promise<void>
): Promise<void> {
  const app = await launchVSCodeApp(dirs, testInfo, `video-${sessionName}`);
  try {
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    const agent = new AgentDriver(window, dirs.workspacePath, dirs.scenarioPath);
    await fn(agent);
  } finally {
    await closeAndAttachVideos(app, testInfo, `vscode-${sessionName}`);
  }
}

/**
 * Подготовить набор папок для «рестарта» VS Code на том же workspace.
 *
 *   - `userDataDir` и `extensionsDir` берём СВЕЖИЕ — это надёжный обход
 *     Electron singleton-локов (`SingletonLock`/`SingletonSocket` от
 *     убитой первой сессии могут не успеть удалиться, и второй процесс
 *     молча выходит при старте).
 *   - `workspacePath` и `scenarioPath` оставляем те же — durability
 *     проверяется именно по `.agents/runs/`, который живёт в workspace.
 *   - Сценарий fake-fetch'а перезаписываем, выкидывая `consumedResponses`
 *     первых ответов: счётчик callIndex в test-extension сбрасывается
 *     при активации, и без обрезки новая сессия снова получит уже
 *     отыгранный ответ.
 */
export function prepareRestart(
  previous: IsolatedDirs,
  options: { fullScenario: FakeScenario; consumedResponses: number }
): IsolatedDirs {
  fs.writeFileSync(
    previous.scenarioPath,
    JSON.stringify({
      responses: options.fullScenario.responses.slice(options.consumedResponses),
    }),
    'utf8'
  );

  const fresh = path.join(os.tmpdir(), `aiagent-e2e-restart-${crypto.randomUUID()}`);
  const userDataDir = path.join(fresh, 'user-data');
  const extensionsDir = path.join(fresh, 'extensions');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(extensionsDir, { recursive: true });

  return {
    workspacePath: previous.workspacePath,
    scenarioPath: previous.scenarioPath,
    userDataDir,
    extensionsDir,
  };
}
