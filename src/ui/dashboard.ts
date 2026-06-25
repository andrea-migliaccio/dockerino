import { spawn, ChildProcess } from 'node:child_process';
import blessed from 'neo-blessed';
import { Container, ContainerStats } from '../types.js';
import { listContainers, getContainerStats, startContainer, stopContainer, restartContainer, removeContainer, removeImage, detectShell, inspectContainer, listVolumes, removeVolume, inspectVolume } from '../docker/commands.js';
import { Image, Volume } from '../types.js';

const STATE_COLORS: Record<string, string> = {
  running: 'green',
  exited: 'red',
  paused: 'yellow',
  restarting: 'yellow',
  dead: 'red',
  created: 'white',
};

/** Minimum terminal width to show stats as inline columns */
const WIDE_THRESHOLD = 120;

/** Tab definition */
interface Tab {
  id: string;
  label: string;
  shortcutKey: string;   // single char for Alt+<key>
  shortcutIndex: number; // position of the shortcut char in label
}

const TABS: Tab[] = [
  { id: 'containers', label: 'Containers', shortcutKey: 'c', shortcutIndex: 0 },
  { id: 'images',     label: 'Images',     shortcutKey: 'i', shortcutIndex: 0 },
  { id: 'volumes',    label: 'Volumes',    shortcutKey: 'v', shortcutIndex: 0 },
];

/** A row in the display list — either a compose group header or a container */
interface DisplayRow {
  type: 'header' | 'container';
  composeProject?: string;
  container?: Container;
}

/**
 * Main dashboard — adaptive table layout.
 *
 * Wide (≥120 cols): stats as columns
 * ┌─ Containers ──────────────────────────────────────────────────────┐
 * │ STATE   NAME              IMAGE             STATUS    CPU  MEM   │
 * │ ▼ my-project                                                     │
 * │   ├─ web                  nginx:latest      Up 2h    1.2% 45M   │
 * │   └─ db                   postgres:16       Up 2h    3.1% 120M  │
 * │ standalone                alpine:3.19       Exited                │
 * ├───────────────────────────────────────────────────────────────────┤
 * │ ↑↓ Navigate  s Start  S Stop  r Restart  d Remove  R Refresh    │
 * └───────────────────────────────────────────────────────────────────┘
 *
 * Narrow (<120 cols): detail panel at the bottom
 * ┌─ Containers ──────────────────────────────┐
 * │ STATE   NAME            IMAGE     STATUS  │
 * ├─ Detail ──────────────────────────────────┤
 * │ CPU: 1.2%  MEM: 45Mi (12%)  NET: 1.2kB   │
 * ├───────────────────────────────────────────┤
 * │ ↑↓ Navigate  s Start  ...                 │
 * └───────────────────────────────────────────┘
 *
 * Keys: ↑↓/j/k navigate, s start, S stop, r restart,
 *        d remove (exited only), R refresh, q/Esc quit
 */
export function createDashboard(): blessed.Widgets.Screen {
  const screen = blessed.screen({
    smartCSR: true,
    title: 'dockerino',
  });

  // --- Tab bar ---
  const tabBar = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: '100%',
    height: 1,
    tags: true,
    style: { fg: 'white', bg: 'default' },
  });

  let activeTab = 0;

  function renderTabBar(): void {
    const parts = TABS.map((tab, i) => {
      const before = tab.label.slice(0, tab.shortcutIndex);
      const key = tab.label[tab.shortcutIndex];
      const after = tab.label.slice(tab.shortcutIndex + 1);
      const highlighted = `${before}{yellow-fg}{underline}${key}{/underline}{/yellow-fg}${after}`;
      if (i === activeTab) {
        return ` {bold}{white-bg}{black-fg} ${highlighted} {/black-fg}{/white-bg}{/bold}`;
      }
      return ` {gray-fg} ${highlighted} {/gray-fg}`;
    });
    tabBar.setContent(parts.join(''));
    safeRender();
  }

  function switchTab(index: number): void {
    if (index < 0 || index >= TABS.length || index === activeTab) return;
    closePopup();
    activeTab = index;
    renderTabBar();
    // Show/hide panels based on active tab
    if (TABS[activeTab].id === 'containers') {
      tableBox.show();
      imagesBox.hide();
      volumesBox.hide();
      updateLayout();
      renderTable();
      renderDetail();
      tableList.focus();
    } else if (TABS[activeTab].id === 'images') {
      tableBox.hide();
      detailBox.hide();
      volumesBox.hide();
      imagesBox.show();
      imagesList.focus();
      void refreshImages();
    } else if (TABS[activeTab].id === 'volumes') {
      tableBox.hide();
      detailBox.hide();
      imagesBox.hide();
      volumesBox.show();
      volumesList.focus();
      void refreshVolumes();
    }
    safeRender();
  }

  // --- Containers tab: main table ---
  const tableBox = blessed.box({
    parent: screen,
    label: ' Containers ',
    top: 1,
    left: 0,
    width: '100%',
    height: '100%-2',
    border: { type: 'line' },
    style: { border: { fg: 'blue' } },
  });

  const tableList = blessed.list({
    parent: tableBox,
    top: 0,
    left: 0,
    width: '100%-2',
    height: '100%-2',
    keys: true,
    vi: true,
    mouse: true,
    scrollable: true,
    scrollbar: { style: { bg: 'blue' } },
    style: {
      fg: 'white',
      selected: { fg: 'black', bg: 'cyan' },
    },
    tags: true,
  });

  // --- Detail panel (narrow mode only) ---
  const detailBox = blessed.box({
    parent: screen,
    label: ' Detail ',
    bottom: 1,
    left: 0,
    width: '100%',
    height: 5,
    border: { type: 'line' },
    style: { border: { fg: 'blue' } },
    tags: true,
    hidden: true,
  });

  // --- Images tab ---
  const imagesBox = blessed.box({
    parent: screen,
    label: ' Images ',
    top: 1,
    left: 0,
    width: '100%',
    height: '100%-2',
    border: { type: 'line' },
    style: { border: { fg: 'blue' } },
    hidden: true,
  });

  const imagesList = blessed.list({
    parent: imagesBox,
    top: 0,
    left: 0,
    width: '100%-2',
    height: '100%-2',
    keys: true,
    vi: true,
    mouse: true,
    scrollable: true,
    scrollbar: { style: { bg: 'blue' } },
    style: {
      fg: 'white',
      selected: { fg: 'black', bg: 'cyan' },
    },
    tags: true,
  });

  async function refreshImages(): Promise<void> {
    try {
      const { listImages } = await import('../docker/commands.js');
      images = await listImages();
      const header = ` {bold}${pad('REPOSITORY', 30)} ${pad('TAG', 20)} ${pad('ID', 15)} ${pad('SIZE', 12)}{/bold}`;
      const rows = images.map((img) =>
        ` ${pad(img.repository, 30)} ${pad(img.tag, 20)} ${pad(img.id.slice(0, 12), 15)} ${pad(img.size, 12)}`
      );
      imagesList.setItems([header, ...rows]);
      if (rows.length > 0) imagesList.select(1);
      safeRender();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      imagesList.setItems([` {red-fg}Error: ${msg}{/red-fg}`]);
      safeRender();
    }
  }

  function selectedImage(): Image | undefined {
    const idx = (imagesList as unknown as { selected: number }).selected;
    if (idx < 1 || idx > images.length) return undefined; // 0 is header
    return images[idx - 1];
  }

  // --- Volumes tab ---
  const volumesBox = blessed.box({
    parent: screen,
    label: ' Volumes ',
    top: 1,
    left: 0,
    width: '100%',
    height: '100%-2',
    border: { type: 'line' },
    style: { border: { fg: 'blue' } },
    hidden: true,
  });

  const volumesList = blessed.list({
    parent: volumesBox,
    top: 0,
    left: 0,
    width: '100%-2',
    height: '100%-2',
    keys: true,
    vi: true,
    mouse: true,
    scrollable: true,
    scrollbar: { style: { bg: 'blue' } },
    style: {
      fg: 'white',
      selected: { fg: 'black', bg: 'cyan' },
    },
    tags: true,
  });

  async function refreshVolumes(): Promise<void> {
    try {
      volumes = await listVolumes();
      const header = ` {bold}${pad('NAME', 40)} ${pad('DRIVER', 12)} ${pad('SCOPE', 10)}{/bold}`;
      const rows = volumes.map((v) =>
        ` ${pad(v.name, 40)} ${pad(v.driver, 12)} ${pad(v.scope, 10)}`
      );
      volumesList.setItems([header, ...rows]);
      if (rows.length > 0) volumesList.select(1);
      safeRender();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      volumesList.setItems([` {red-fg}Error: ${msg}{/red-fg}`]);
      safeRender();
    }
  }

  function selectedVolume(): Volume | undefined {
    const idx = (volumesList as unknown as { selected: number }).selected;
    if (idx < 1 || idx > volumes.length) return undefined;
    return volumes[idx - 1];
  }

  // --- Status bar ---
  const STATUS_KEYS = ' {bold}↑↓{/} Navigate  {bold}s{/} Start  {bold}S{/} Stop  {bold}r{/} Restart  {bold}del{/} Remove  {bold}d{/} Details  {bold}l{/} Logs  {bold}h{/} Shell  {bold}R{/} Refresh  {bold}q{/} Quit';
  const IMAGES_STATUS_KEYS = ' {bold}↑↓{/} Navigate  {bold}del{/} Delete  {bold}d{/} Details  {bold}R{/} Refresh  {bold}q{/} Quit';
  const VOLUMES_STATUS_KEYS = ' {bold}↑↓{/} Navigate  {bold}del{/} Delete  {bold}d{/} Details  {bold}R{/} Refresh  {bold}q{/} Quit';
  const statusBar = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    tags: true,
    style: { fg: 'white', bg: 'blue' },
    content: STATUS_KEYS,
  });

  // --- State ---
  let containers: Container[] = [];
  let stats: ContainerStats[] = [];
  let displayRows: DisplayRow[] = [];
  let selectedIdx = 0;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let shellActive = false;
  let images: Image[] = [];
  let volumes: Volume[] = [];
  let popupOpen = false;
  let activePopup: blessed.Widgets.BoxElement | null = null;
  let popupCleanup: (() => void) | null = null;

  /** Restore focus to the active tab's list */
  function refocusActiveList(): void {
    const id = TABS[activeTab].id;
    if (id === 'containers') tableList.focus();
    else if (id === 'images') imagesList.focus();
    else if (id === 'volumes') volumesList.focus();
  }

  /** Close any open popup */
  function closePopup(): void {
    if (activePopup) {
      if (popupCleanup) { popupCleanup(); popupCleanup = null; }
      popupOpen = false;
      activePopup.detach();
      activePopup = null;
      refocusActiveList();
      safeRender();
    }
  }

  /** Guarded render — does nothing while shell is active */
  function safeRender(): void {
    if (!shellActive) screen.render();
  }

  /** Returns the status bar text for the currently active tab */
  function activeStatusKeys(): string {
    const id = TABS[activeTab].id;
    if (id === 'images') return IMAGES_STATUS_KEYS;
    if (id === 'volumes') return VOLUMES_STATUS_KEYS;
    return STATUS_KEYS;
  }

  /** Flash an error in the status bar, then restore normal keys */
  function flashError(msg: string): void {
    statusBar.style.bg = 'red';
    statusBar.setContent(` {bold}Error:{/bold} ${msg}`);
    safeRender();
    setTimeout(() => { statusBar.style.bg = 'blue'; statusBar.setContent(activeStatusKeys()); safeRender(); }, 3000);
  }

  tableList.on('select item', (_item: blessed.Widgets.BoxElement, index: number) => {
    selectedIdx = index;
    renderDetail();
  });

  // --- Helpers ---

  function isWide(): boolean {
    return (screen.width as number) >= WIDE_THRESHOLD;
  }

  function statsFor(c: Container): ContainerStats | undefined {
    return stats.find((s) => s.id === c.id || s.name === c.name);
  }

  function pad(s: string, n: number): string {
    return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);
  }

  /** Build hierarchical row model: compose groups then standalone */
  function buildDisplayRows(list: Container[]): DisplayRow[] {
    const rows: DisplayRow[] = [];
    const groups = new Map<string, Container[]>();
    const standalone: Container[] = [];

    for (const c of list) {
      if (c.composeProject) {
        let g = groups.get(c.composeProject);
        if (!g) { g = []; groups.set(c.composeProject, g); }
        g.push(c);
      } else {
        standalone.push(c);
      }
    }

    for (const [project, members] of groups) {
      rows.push({ type: 'header', composeProject: project });
      for (const c of members) {
        rows.push({ type: 'container', container: c, composeProject: project });
      }
    }
    for (const c of standalone) {
      rows.push({ type: 'container', container: c });
    }
    return rows;
  }

  function headerLine(wide: boolean): string {
    let h = ` {bold}${pad('STATE', 10)} ${pad('NAME', 22)} ${pad('IMAGE', 25)} ${pad('STATUS', 18)}`;
    if (wide) h += ` ${pad('CPU', 8)} ${pad('MEMORY', 22)} ${pad('NET I/O', 18)}`;
    return h + '{/bold}';
  }

  function formatRow(row: DisplayRow, wide: boolean): string {
    if (row.type === 'header') {
      // Align compose project name with the NAME column (after STATE)
      return ` ${pad('', 10)} {bold}{cyan-fg}▼ ${row.composeProject}{/cyan-fg}{/bold}`;
    }

    const c = row.container!;
    const color = STATE_COLORS[c.state] ?? 'white';
    const prefix = row.composeProject ? '├─ ' : '';
    const displayName = c.composeService ?? c.name;

    let line = ` {${color}-fg}${pad(c.state.toUpperCase(), 10)}{/${color}-fg}`
      + ` ${pad(prefix + displayName, 22)}`
      + ` ${pad(c.image, 25)}`
      + ` ${pad(c.status, 18)}`;

    if (wide) {
      const s = statsFor(c);
      if (s) {
        const cpu = parseFloat(s.cpuPercent) || 0;
        const mem = parseFloat(s.memPercent) || 0;
        const cpuC = cpu > 80 ? 'red' : cpu > 50 ? 'yellow' : 'green';
        const memC = mem > 80 ? 'red' : mem > 50 ? 'yellow' : 'green';
        line += ` {${cpuC}-fg}${pad(s.cpuPercent, 8)}{/${cpuC}-fg}`;
        line += ` {${memC}-fg}${pad(s.memUsage, 22)}{/${memC}-fg}`;
        line += ` ${pad(s.netIO, 18)}`;
      } else if (c.state === 'running') {
        line += ` ${pad('…', 8)} ${pad('…', 22)} ${pad('…', 18)}`;
      }
    }
    return line;
  }

  // --- Layout ---

  function updateLayout(): void {
    if (TABS[activeTab].id !== 'containers') return;
    if (isWide()) {
      detailBox.hide();
      tableBox.height = '100%-2';  // tab bar + status bar
    } else {
      detailBox.show();
      tableBox.height = '100%-8';  // tab bar + detail(5+border) + status bar
    }
  }

  // --- Rendering ---

  function renderTable(): void {
    const wide = isWide();
    displayRows = buildDisplayRows(containers);

    const items = [headerLine(wide), ...displayRows.map((r) => formatRow(r, wide))];
    tableList.setItems(items);
    selectedIdx = Math.max(1, Math.min(selectedIdx, items.length - 1));
    tableList.select(selectedIdx);
    safeRender();
  }

  function renderDetail(): void {
    if (isWide()) return;

    const row = displayRows[selectedIdx - 1]; // -1 for header line
    if (!row || row.type === 'header') {
      detailBox.setContent(' Select a container to see stats');
      safeRender();
      return;
    }
    const c = row.container!;
    const s = statsFor(c);
    if (!s) {
      detailBox.setContent(c.state === 'running'
        ? ` {bold}${c.name}{/bold}  Stats loading…`
        : ` {bold}${c.name}{/bold}  Container not running`);
      safeRender();
      return;
    }

    const cpu = parseFloat(s.cpuPercent) || 0;
    const mem = parseFloat(s.memPercent) || 0;
    const cpuC = cpu > 80 ? 'red' : cpu > 50 ? 'yellow' : 'green';
    const memC = mem > 80 ? 'red' : mem > 50 ? 'yellow' : 'green';
    detailBox.setContent([
      ` {bold}${c.name}{/bold}  (${c.image})`,
      ` CPU: {${cpuC}-fg}${s.cpuPercent}{/${cpuC}-fg}    MEM: {${memC}-fg}${s.memUsage} (${s.memPercent}){/${memC}-fg}    PIDs: ${s.pids}`,
      ` NET: ${s.netIO}    I/O: ${s.blockIO}`,
    ].join('\n'));
    safeRender();
  }

  async function refresh(): Promise<void> {
    if (shellActive) return;
    try {
      const [newContainers, newStats] = await Promise.all([
        listContainers(true),
        getContainerStats().catch(() => [] as ContainerStats[]),
      ]);
      containers = newContainers;
      stats = newStats;
      updateLayout();
      renderTable();
      renderDetail();
      statusBar.setContent(activeStatusKeys());
      safeRender();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      flashError(msg);
    }
  }

  function selectedContainer(): Container | undefined {
    const row = displayRows[selectedIdx - 1];
    return row?.type === 'container' ? row.container : undefined;
  }

  async function runAction(action: (id: string) => Promise<void>, label: string): Promise<void> {
    closePopup();
    const c = selectedContainer();
    if (!c) return;
    statusBar.setContent(` ${label} ${c.name}...`);
    safeRender();
    try {
      await action(c.id);
      await refresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      flashError(msg);
    }
  }

  // screen.leave() / screen.enter() exist in neo-blessed but are missing from @types/blessed
  const screenAny = screen as unknown as { leave(): void; enter(): void };

  // --- Shell ---
  async function openShell(): Promise<void> {
    closePopup();
    const c = selectedContainer();
    if (!c || c.state !== 'running') return;

    statusBar.setContent(` Detecting shell for ${c.name}...`);
    safeRender();

    let shell: string;
    try {
      shell = await detectShell(c.id);
    } catch {
      statusBar.setContent(` {red-fg}{bold}Error:{/bold} cannot detect shell{/red-fg}`);
      safeRender();
      return;
    }

    // Block all rendering and release stdin so docker exec gets full terminal control
    shellActive = true;
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    screenAny.leave();
    process.stdin.pause();
    process.stdout.write(`\x1b[2J\x1b[H`); // clear screen
    process.stdout.write(`Connecting to ${c.name} (${shell})...\r\n`);

    const ps = spawn('docker', ['exec', '-it', c.id, shell], {
      stdio: 'inherit',
    });

    function restoreScreen(): void {
      shellActive = false;
      process.stdin.resume();
      screenAny.enter();
      // Immediately render old data so user doesn't see a black screen
      screen.render();
      // Then refresh in background
      refreshTimer = setInterval(() => { void refresh(); }, 5000);
      void refresh();
    }

    ps.on('exit', restoreScreen);

    ps.on('error', (err) => {
      restoreScreen();
      statusBar.setContent(` {red-fg}{bold}Error:{/bold} ${err.message}{/red-fg}`);
      screen.render();
      setTimeout(() => { statusBar.setContent(activeStatusKeys()); screen.render(); }, 3000);
    });
  }

  // --- Detail popup ---
  function showDetailPopup(title: string, lines: string[]): void {
    closePopup();
    popupOpen = true;
    const maxH = (screen.height as number) - 2;
    const wantH = lines.length + 4; // +2 border, +1 empty line, +1 hint
    const popupH = Math.min(wantH, maxH);
    const scrollable = wantH > maxH;
    const hint = scrollable ? '{gray-fg}↑↓ Scroll  Esc/Enter to close{/gray-fg}' : '{gray-fg}Esc/Enter to close{/gray-fg}';
    const allLines = [...lines, '', hint];

    const popup = blessed.box({
      parent: screen,
      label: ` ${title} `,
      top: 'center',
      left: 'center',
      width: '70%',
      height: popupH,
      border: { type: 'line' },
      style: { border: { fg: 'cyan' }, fg: 'white', bg: 'black' },
      tags: true,
      content: allLines.join('\n'),
      padding: { left: 1, right: 1, top: 0, bottom: 0 },
      scrollable,
      keys: scrollable,
      vi: scrollable,
      mouse: scrollable,
      scrollbar: scrollable ? { style: { bg: 'cyan' } } : undefined,
    });

    screen.render();
    const close = () => {
      popupOpen = false;
      activePopup = null;
      popup.detach();
      refocusActiveList();
      safeRender();
    };
    popup.key(['escape', 'enter', 'q', 'd'], close);
    activePopup = popup;
    popup.focus();
  }

  async function showContainerDetails(): Promise<void> {
    const c = selectedContainer();
    if (!c) return;
    const s = statsFor(c);
    const lines: string[] = [
      `{bold}Name:{/bold}     ${c.name}`,
      `{bold}ID:{/bold}       ${c.id}`,
      `{bold}Image:{/bold}    ${c.image}`,
      `{bold}State:{/bold}    ${c.state.toUpperCase()}`,
      `{bold}Status:{/bold}   ${c.status}`,
      `{bold}Ports:{/bold}    ${c.ports || '—'}`,
      `{bold}Created:{/bold}  ${c.created}`,
    ];
    if (c.size) lines.push(`{bold}Size:{/bold}     ${c.size}`);
    if (c.composeProject) {
      lines.push(`{bold}Compose:{/bold}  ${c.composeProject} / ${c.composeService ?? '—'}`);
    }
    if (s) {
      lines.push('');
      lines.push(`{bold}CPU:{/bold}      ${s.cpuPercent}`);
      lines.push(`{bold}Memory:{/bold}   ${s.memUsage} (${s.memPercent})`);
      lines.push(`{bold}Net I/O:{/bold}  ${s.netIO}`);
      lines.push(`{bold}Block IO:{/bold} ${s.blockIO}`);
      lines.push(`{bold}PIDs:{/bold}     ${s.pids}`);
    }

    // Fetch inspect data (mounts + env)
    try {
      const info = await inspectContainer(c.id);
      if (info.mounts.length > 0) {
        lines.push('');
        lines.push(`{bold}{underline}Volumes / Mounts{/underline}{/bold}`);
        for (const m of info.mounts) {
          const rw = m.rw ? 'rw' : 'ro';
          lines.push(`  ${m.type}  ${m.source} → ${m.destination}  (${rw})`);
        }
      }
      if (info.env.length > 0) {
        lines.push('');
        lines.push(`{bold}{underline}Environment{/underline}{/bold}`);
        for (const e of info.env) {
          lines.push(`  ${e}`);
        }
      }
    } catch {
      lines.push('');
      lines.push(`{red-fg}Could not fetch inspect data{/red-fg}`);
    }

    showDetailPopup('Container Details', lines);
  }

  function showImageDetails(): void {
    const img = selectedImage();
    if (!img) return;
    const lines: string[] = [
      `{bold}Repository:{/bold}  ${img.repository}`,
      `{bold}Tag:{/bold}         ${img.tag}`,
      `{bold}ID:{/bold}          ${img.id}`,
      `{bold}Size:{/bold}        ${img.size}`,
      `{bold}Created:{/bold}     ${img.created}`,
    ];
    showDetailPopup('Image Details', lines);
  }

  async function showVolumeDetails(): Promise<void> {
    const v = selectedVolume();
    if (!v) return;
    const lines: string[] = [
      `{bold}Name:{/bold}       ${v.name}`,
      `{bold}Driver:{/bold}     ${v.driver}`,
      `{bold}Scope:{/bold}      ${v.scope}`,
      `{bold}Mountpoint:{/bold} ${v.mountpoint}`,
    ];

    try {
      const info = await inspectVolume(v.name);
      if (info.createdAt) lines.push(`{bold}Created:{/bold}    ${info.createdAt}`);
      const labelEntries = Object.entries(info.labels);
      if (labelEntries.length > 0) {
        lines.push('');
        lines.push(`{bold}{underline}Labels{/underline}{/bold}`);
        for (const [k, val] of labelEntries) {
          lines.push(`  ${k} = ${val}`);
        }
      }
      const optEntries = Object.entries(info.options);
      if (optEntries.length > 0) {
        lines.push('');
        lines.push(`{bold}{underline}Options{/underline}{/bold}`);
        for (const [k, val] of optEntries) {
          lines.push(`  ${k} = ${val}`);
        }
      }
      lines.push('');
      if (info.usedBy.length > 0) {
        lines.push(`{bold}{underline}Used by containers{/underline}{/bold}`);
        for (const name of info.usedBy) {
          lines.push(`  ${name}`);
        }
      } else {
        lines.push(`{gray-fg}Not used by any container{/gray-fg}`);
      }
    } catch {
      lines.push('');
      lines.push(`{red-fg}Could not fetch volume details{/red-fg}`);
    }

    showDetailPopup('Volume Details', lines);
  }

  // --- Logs viewer ---
  function openLogs(): void {
    const c = selectedContainer();
    if (!c || c.state !== 'running') return;

    closePopup();
    popupOpen = true;

    const allLogLines: string[] = [];
    let filterText = '';
    let logProcess: ChildProcess | null = null;

    // Main popup box
    const logPopup = blessed.box({
      parent: screen,
      label: ` Logs: ${c.name} `,
      top: 1,
      left: 1,
      width: '100%-2',
      height: '100%-2',
      border: { type: 'line' },
      style: { border: { fg: 'cyan' }, fg: 'white', bg: 'black' },
      tags: true,
    });

    // Filter prompt
    const filterLabel = blessed.box({
      parent: logPopup,
      top: 0,
      left: 0,
      width: 10,
      height: 1,
      tags: true,
      content: ' {bold}Filter:{/bold}',
      style: { fg: 'white', bg: 'black' },
    });

    const filterInput = blessed.textbox({
      parent: logPopup,
      top: 0,
      left: 10,
      width: '100%-12',
      height: 1,
      style: { fg: 'white', bg: 'black', focus: { fg: 'white', bg: 'black' } },
      inputOnFocus: true,
    });

    // Separator
    const separator = blessed.line({
      parent: logPopup,
      top: 1,
      left: 0,
      width: '100%-2',
      orientation: 'horizontal',
      style: { fg: 'cyan' },
    });

    // Log content area
    const logBox = blessed.log({
      parent: logPopup,
      top: 2,
      left: 0,
      width: '100%-2',
      height: '100%-4',
      keys: true,
      vi: true,
      mouse: true,
      scrollable: true,
      scrollbar: { style: { bg: 'cyan' } },
      tags: true,
      style: { fg: 'white', bg: 'black' },
    });

    // Hint bar at bottom
    const logHint = blessed.box({
      parent: logPopup,
      bottom: 0,
      left: 0,
      width: '100%-2',
      height: 1,
      tags: true,
      style: { fg: 'gray', bg: 'black' },
      content: ' {bold}/{/} Filter  {bold}Esc{/} Close  {bold}↑↓{/} Scroll',
    });

    function applyFilter(): void {
      (logBox as unknown as { setItems?: (items: string[]) => void });
      // Clear and re-add filtered lines
      logBox.setContent('');
      const filtered = filterText
        ? allLogLines.filter((l) => l.toLowerCase().includes(filterText.toLowerCase()))
        : allLogLines;
      for (const line of filtered) {
        logBox.add(line);
      }
      logBox.setScrollPerc(100);
      screen.render();
    }

    // Start docker logs
    logProcess = spawn('docker', ['logs', '-f', '--tail', '500', c.id]);

    function onData(data: Buffer): void {
      const text = data.toString('utf-8');
      const newLines = text.split('\n');
      // Last element may be empty from trailing newline
      if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
      for (const line of newLines) {
        allLogLines.push(line);
        if (!filterText || line.toLowerCase().includes(filterText.toLowerCase())) {
          logBox.add(line);
        }
      }
      // Cap buffer at 5000 lines
      while (allLogLines.length > 5000) allLogLines.shift();
      logBox.setScrollPerc(100);
      screen.render();
    }

    logProcess.stdout?.on('data', onData);
    logProcess.stderr?.on('data', onData);

    function closeLogs(): void {
      if (logProcess) {
        logProcess.kill();
        logProcess = null;
      }
      popupCleanup = null;
      popupOpen = false;
      activePopup = null;
      logPopup.detach();
      refocusActiveList();
      safeRender();
    }

    popupCleanup = () => {
      if (logProcess) { logProcess.kill(); logProcess = null; }
    };

    // '/' focuses the filter input
    logBox.key(['/'], () => {
      filterInput.focus();
      screen.render();
    });

    logPopup.key(['/'], () => {
      filterInput.focus();
      screen.render();
    });

    // Escape from filter input: apply filter and go back to log view
    filterInput.on('cancel', () => {
      filterText = filterInput.getValue();
      applyFilter();
      logBox.focus();
    });

    // Enter/submit from filter input: apply filter and go back to log view
    filterInput.on('submit', () => {
      filterText = filterInput.getValue();
      applyFilter();
      logBox.focus();
    });

    // Escape from log box: close the popup
    logBox.key(['escape', 'q'], closeLogs);
    logPopup.key(['escape', 'q'], closeLogs);

    logProcess.on('error', (err) => {
      logBox.add(`{red-fg}Error: ${err.message}{/red-fg}`);
      screen.render();
    });

    logProcess.on('exit', () => {
      logBox.add('{gray-fg}--- Log stream ended ---{/gray-fg}');
      screen.render();
    });

    activePopup = logPopup;
    logBox.focus();
    screen.render();
  }

  // --- Key bindings: containers tab ---
  tableList.key(['s'], () => { void runAction(startContainer, 'Starting'); });
  tableList.key(['S'], () => { void runAction(stopContainer, 'Stopping'); });
  tableList.key(['r'], () => { void runAction(restartContainer, 'Restarting'); });
  tableList.key(['delete'], () => {
    const c = selectedContainer();
    if (c && c.state === 'exited') {
      void runAction((id) => removeContainer(id, false), 'Removing');
    }
  });
  tableList.key(['d'], () => { void showContainerDetails(); });
  tableList.key(['l'], () => { openLogs(); });
  tableList.key(['h'], () => { void openShell(); });
  tableList.key(['R'], () => { closePopup(); void refresh(); });

  // --- Key bindings: images tab ---
  imagesList.key(['delete'], () => {
    closePopup();
    const img = selectedImage();
    if (!img) return;
    const name = img.repository !== '<none>' ? `${img.repository}:${img.tag}` : img.id.slice(0, 12);
    statusBar.setContent(` Deleting ${name}...`);
    safeRender();
    void removeImage(img.id).then(() => refreshImages()).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      flashError(msg);
    });
  });
  imagesList.key(['d'], () => { showImageDetails(); });
  imagesList.key(['R'], () => { closePopup(); void refreshImages(); });

  // --- Key bindings: volumes tab ---
  volumesList.key(['delete'], () => {
    closePopup();
    const v = selectedVolume();
    if (!v) return;
    statusBar.setContent(` Deleting volume ${v.name}...`);
    safeRender();
    void removeVolume(v.name).then(() => refreshVolumes()).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      flashError(msg);
    });
  });
  volumesList.key(['d'], () => { void showVolumeDetails(); });
  volumesList.key(['R'], () => { closePopup(); void refreshVolumes(); });

  // --- Global key bindings ---
  screen.key(['q', 'escape'], () => {
    if (popupOpen) return; // let the popup handle it
    if (refreshTimer) clearInterval(refreshTimer);
    screen.destroy();
    process.exit(0);
  });

  // Tab switching: Alt+1..Alt+N and Alt+<shortcut letter>
  for (let i = 0; i < TABS.length; i++) {
    screen.key([`M-${i + 1}`], () => switchTab(i));
    screen.key([`M-${TABS[i].shortcutKey}`], () => switchTab(i));
  }

  screen.on('resize', () => {
    renderTabBar();
    if (TABS[activeTab].id === 'containers') {
      updateLayout(); renderTable(); renderDetail();
    }
  });

  // Update status bar on tab switch
  tableList.on('focus', () => { statusBar.setContent(STATUS_KEYS); safeRender(); });
  imagesList.on('focus', () => { statusBar.setContent(IMAGES_STATUS_KEYS); safeRender(); });
  volumesList.on('focus', () => { statusBar.setContent(VOLUMES_STATUS_KEYS); safeRender(); });

  tableList.focus();
  renderTabBar();
  updateLayout();
  void refresh();
  refreshTimer = setInterval(() => { void refresh(); }, 5000);

  return screen;
}
