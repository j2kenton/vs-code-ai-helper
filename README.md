# VS Code AI Helper

A VS Code extension for helping developers utilize AI tools and LLMs in their work.

## Marketplace

Install from the Visual Studio Marketplace:

https://marketplace.visualstudio.com/items?itemName=j2kenton.vs-code-ai-helper

## Features

🚧 **Under Development** 🚧

Planned features:

- AI-powered code assistance
- LLM integration for code generation
- Intelligent code completion
- Code explanation and documentation

## Screenshots

| Command Palette | Task Planning |
| --- | --- |
| ![AI Helper commands in the Command Palette](images/screenshots/screenshot-1.jpeg) | ![Task planning prompt](images/screenshots/screenshot-2.jpeg) |

## Requirements

- VS Code 1.85.0 or higher
- Node.js 18.x or higher

## Development

### Setup

```bash
# Install dependencies
pnpm install

# Compile the extension
pnpm run compile
```

### Running the Extension

1. Press `F5` to open a new VS Code window with the extension loaded
2. Run the command `AI Helper: Hello World` from the Command Palette (`Ctrl+Shift+P`)

### Available Scripts

| Script | Description |
|--------|-------------|
| `pnpm run compile` | Compile the extension |
| `pnpm run watch` | Watch for changes and recompile |
| `pnpm run package` | Package the extension for production |
| `pnpm run lint` | Run ESLint |
| `pnpm run lint:fix` | Run ESLint with auto-fix |
| `pnpm run test` | Run tests |

## Project Structure

```
vs-code-ai-helper/
├── .vscode/           # VS Code configuration
│   ├── launch.json    # Debug configurations
│   └── tasks.json     # Build tasks
├── src/
│   └── extension.ts   # Extension entry point
├── dist/              # Compiled output (git-ignored)
├── package.json       # Extension manifest
├── tsconfig.json      # TypeScript configuration
├── .eslintrc.json     # ESLint configuration
└── esbuild.js         # Build configuration
```

## License

MIT
