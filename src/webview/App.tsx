import { useEffect, useState } from 'react';
import { vscode } from './vscode';

type IncomingMessage = { type: 'pong'; at: number };

export function App() {
  const [log, setLog] = useState<string[]>([]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<IncomingMessage>) => {
      setLog((prev) => [...prev, JSON.stringify(event.data)]);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return (
    <main className="app">
      <h1>AI Frontend Agent</h1>
      <p>React 19 scaffold готов. Дальше — собственный UI агента.</p>
      <button onClick={() => vscode.postMessage({ type: 'ping' })}>Ping extension</button>
      <button onClick={() => vscode.postMessage({ type: 'openInTab' })}>Open in editor tab</button>
      <pre>{log.join('\n')}</pre>
    </main>
  );
}