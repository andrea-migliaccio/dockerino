# 🐳 dockerino

A **Terminal User Interface (TUI)** for Docker. Manage containers, images, and volumes from a beautiful interactive terminal dashboard — no GUI needed.

![License](https://img.shields.io/github/license/andrea/dockerino)
![npm](https://img.shields.io/npm/v/dockerino)
![Node](https://img.shields.io/node/v/dockerino)

## Features

- **Containers** — Start, stop, restart, remove, inspect, view logs, open shell
- **Images** — List, delete, inspect details
- **Volumes** — List, delete, inspect with usage info
- **Docker Compose** — Automatic grouping by Compose project
- **Adaptive layout** — Wide terminals show inline stats columns; narrow terminals show a detail panel
- **Live stats** — CPU, memory, network I/O updated every 5 seconds
- **Log viewer** — Streaming logs with real-time text filtering
- **Interactive shell** — Open a shell inside any running container
- **Tab navigation** — Switch between Containers, Images, and Volumes with `Alt+C/I/V`

## Quick start

Run directly without installing:

```bash
npx dockerino
```

## Installation

Or install globally:

```bash
npm install -g dockerino
```

## Requirements

- **Node.js** ≥ 18
- **Docker CLI** (`docker`) available in your `PATH`
- Docker daemon running

## Usage

```bash
dockerino
```

### Keyboard shortcuts

#### Containers tab

| Key     | Action                      |
| ------- | --------------------------- |
| `↑` `↓` | Navigate                    |
| `s`     | Start container             |
| `S`     | Stop container              |
| `r`     | Restart container           |
| `Del`   | Remove container (exited)   |
| `d`     | Show container details      |
| `l`     | Open log viewer             |
| `h`     | Open shell in container     |
| `R`     | Refresh                     |

#### Images / Volumes tabs

| Key     | Action         |
| ------- | -------------- |
| `↑` `↓` | Navigate       |
| `Del`   | Delete         |
| `d`     | Show details   |
| `R`     | Refresh        |

#### Global

| Key              | Action              |
| ---------------- | -------------------- |
| `Alt+C`          | Containers tab       |
| `Alt+I`          | Images tab           |
| `Alt+V`          | Volumes tab          |
| `Alt+1/2/3`      | Switch tab by number |
| `q` / `Esc`      | Quit                 |

## Development

```bash
git clone https://github.com/andrea/dockerino.git
cd dockerino
npm install
npm run build
npm start
```

### Scripts

| Command          | Description                  |
| ---------------- | ---------------------------- |
| `npm run build`  | Compile TypeScript           |
| `npm run dev`    | Watch mode                   |
| `npm start`      | Run dockerino                |
| `npm run lint`   | Lint with ESLint             |

## Architecture

```
src/
  index.ts           # Entry point, bootstrap TUI
  ui/                # Blessed components (dashboard, layout)
  docker/            # Docker CLI interaction
    commands.ts      # Async wrappers around docker commands
    parser.ts        # Output parsing (JSON/text)
  types.ts           # TypeScript interfaces
bin/
  dockerino.ts       # CLI entry point
```

All Docker interaction happens via `child_process.execFile` / `spawn` with argument arrays (no shell interpolation), communicating with the local `docker` CLI. No Docker Engine API or HTTP calls.

## Contributing

Contributions are welcome! Feel free to open issues and pull requests.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
