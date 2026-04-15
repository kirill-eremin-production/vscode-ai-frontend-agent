# AI Frontend Agent

VS Code extension providing an AI Frontend Agent UI as a sidebar webview.

## Features

- Sidebar view in the Activity Bar
- Command `AI Frontend Agent: Open in Tab` to open the agent in an editor tab

## Development

```bash
nvm use
npm install
npm run build
```

Press `F5` in VS Code to launch the Extension Development Host.

## Packaging

```bash
npm run package
```

Produces a `.vsix` file that can be installed via:

```bash
code --install-extension vscode-ai-frontend-agent-<version>.vsix
```
