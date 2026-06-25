# Dockerino

TUI (Terminal User Interface) per Docker, distribuito come pacchetto npm. Offre un'interfaccia "grafica" nel terminale per gestire container, immagini, volumi, network, log e Docker Compose — in alternativa alla CLI classica di Docker.

## Stack

- **Language**: TypeScript (strict mode)
- **TUI framework**: [blessed](https://github.com/chjj/blessed) / [neo-blessed](https://github.com/embark-framework/neo-blessed)
- **Docker interaction**: spawn di comandi `docker` CLI (`child_process.execFile` / `spawn`) — NO Docker Engine API, NO dockerode
- **Package manager**: npm
- **Distribution**: pacchetto npm globale (`npm install -g dockerino`), entry point binario via `bin` in `package.json`

## Build & Test

```bash
npm install --before=$(date -d '-7 days' --iso-8601=seconds)
npm run build        # compila TypeScript
npm test             # esegue i test
npm run lint         # controllo stile
```

## Architecture

```
src/
  index.ts           # entry point, bootstrap della TUI
  ui/                # componenti blessed (layout, widget, schermate)
  docker/            # modulo per interazione con Docker CLI
    commands.ts      # funzioni che eseguono comandi docker via spawn
    parser.ts        # parsing dell'output docker (JSON/text)
  compose/           # gestione Docker Compose
  utils/             # utility condivise
bin/
  dockerino.ts       # entry point CLI (shebang, arg parsing)
```

## Conventions

- **Docker CLI output**: usare sempre `--format json` (o `--format '{{json .}}'`) quando disponibile, per semplificare il parsing. Fallback a parsing testuale solo quando il formato JSON non è supportato.
- **Spawn sicuro**: usare `execFile` / `spawn` con array di argomenti, MAI `exec` con stringhe interpolate (rischio command injection).
- **Error handling Docker**: i comandi docker possono fallire per daemon non in esecuzione, permessi insufficienti, o risorse inesistenti. Mostrare errori leggibili nella TUI, mai stack trace raw.
- **Encoding**: assumere UTF-8 per stdout/stderr di docker.
- **TUI lifecycle**: ogni schermata blessed deve fare cleanup (`screen.destroy()`) all'uscita per ripristinare il terminale.
- **No network in runtime**: dockerino comunica solo col processo `docker` locale, nessuna chiamata HTTP/API esterna.

## Key Patterns

- Ogni comando Docker è wrappato in una funzione async che restituisce dati tipizzati (es. `listContainers(): Promise<Container[]>`).
- I widget blessed sono componenti riutilizzabili con interfaccia consistente.
- La navigazione tra schermate usa un semplice router/stack.
