import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  const provider = new AgentViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('aiFrontendAgent.sidebarView', provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aiFrontendAgent.openPanel', () => {
      AgentPanel.createOrShow(context.extensionUri);
    })
  );
}

export function deactivate() {}

function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'main.js')
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'main.css')
  );
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>AI Frontend Agent</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return {
    enableScripts: true,
    localResourceRoots: [
      vscode.Uri.joinPath(extensionUri, 'out', 'webview'),
      vscode.Uri.joinPath(extensionUri, 'media'),
    ],
  };
}

class AgentViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = webviewOptions(this.extensionUri);
    webviewView.webview.html = getHtml(webviewView.webview, this.extensionUri);

    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === 'ping') {
        webviewView.webview.postMessage({ type: 'pong', at: Date.now() });
      } else if (msg?.type === 'openInTab') {
        vscode.commands.executeCommand('aiFrontendAgent.openPanel');
      }
    });
  }
}

class AgentPanel {
  public static current: AgentPanel | undefined;
  public static readonly viewType = 'aiFrontendAgent.panel';

  public static createOrShow(extensionUri: vscode.Uri) {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (AgentPanel.current) {
      AgentPanel.current.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      AgentPanel.viewType,
      'AI Frontend Agent',
      column,
      { ...webviewOptions(extensionUri), retainContextWhenHidden: true }
    );

    AgentPanel.current = new AgentPanel(panel, extensionUri);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri
  ) {
    panel.webview.html = getHtml(panel.webview, extensionUri);

    panel.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === 'ping') {
        panel.webview.postMessage({ type: 'pong', at: Date.now() });
      } else if (msg?.type === 'openInTab') {
        panel.reveal();
      }
    });

    panel.onDidDispose(() => {
      AgentPanel.current = undefined;
    });
  }
}