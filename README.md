# @flowot/nx-sx

CLI package for launching a visible Git Bash window on Windows and closing it when the parent CLI receives an exit signal.

## Usage

```bash
npx @flowot/nx-sx happy C:
```

Arguments:

- First argument: command to run inside Git Bash
- Second argument: working directory, optional

Examples:

```bash
npx @flowot/nx-sx happy C:
npx @flowot/nx-sx happy
npx @flowot/nx-sx "npm run dev" D:\chat\bro_chat
npm run nx-sx -- happy
npm run nx-sx -- "npm run dev" D:\chat\bro_chat
```

If the path is omitted, the CLI uses the caller's current working directory.

## Behavior

- Validates the command before launch
- Resolves Git Bash automatically on Windows
- Launches a visible `cmd.exe` hosted Git Bash window
- Keeps the CLI process alive
- Listens for exit signals such as `SIGINT`, `SIGTERM`, and `SIGBREAK`
- Closes the launched window tree on shutdown

## Notes

- Native Windows visible terminal windows do not have OS-level sandbox isolation
- This package marks the launch mode as `unsandboxed-window`
- The package still applies application-layer command validation before launch
