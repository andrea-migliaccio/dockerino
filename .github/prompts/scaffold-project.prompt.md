---
description: "Scaffold the dockerino project: package.json, tsconfig, directory structure, bin entry point, and dev dependencies. Use when starting fresh or resetting the project foundation."
agent: "agent"
tools: [read, edit, search, execute]
---

Scaffold the dockerino project from scratch. Read [AGENTS.md](../../AGENTS.md) for the full project spec and conventions.

## Requirements

1. **package.json** with:
   - `name: "dockerino"`, `type: "module"`
   - `bin` entry pointing to `dist/bin/dockerino.js`
   - Scripts: `build` (tsc), `dev` (tsc --watch), `start` (node dist/index.js), `lint` (eslint), `test`
   - Dependencies: `neo-blessed`
   - DevDependencies: `typescript`, `@types/node`, `@types/blessed`, `eslint`, `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`

2. **tsconfig.json** with strict mode, ES2022 target, NodeNext module, `outDir: "dist"`, `rootDir: "src"`, source maps enabled

3. **Directory structure** matching the architecture in AGENTS.md:
   ```
   src/
     index.ts
     types.ts
     ui/
     docker/
     compose/
     utils/
   bin/
     dockerino.ts    # #!/usr/bin/env node shebang + import of ../src/index
   ```

4. **bin/dockerino.ts** with proper shebang for npm global install

5. **.gitignore** excluding `node_modules/`, `dist/`

6. Run `npm install --before=$(date -d '-7 days' --iso-8601=seconds)` after creating files

Do NOT overwrite files that already exist — skip them and report what was skipped.
