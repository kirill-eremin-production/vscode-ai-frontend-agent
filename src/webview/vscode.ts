interface VSCodeApi {
  postMessage(message: unknown): void;
  getState<T = unknown>(): T | undefined;
  setState<T>(state: T): void;
}

declare function acquireVsCodeApi(): VSCodeApi;

export const vscode: VSCodeApi = acquireVsCodeApi();