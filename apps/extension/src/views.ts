import * as vscode from 'vscode';
import { TOKENS_NOTE, compact, developerLabel, fmt, modelLabel, per100 } from './format';
import type { SessionState } from './session';

export interface ViewModel {
  hasKey: boolean;
  session?: SessionState;
  repoRoot?: string;
  repository?: string;
  branch?: string;
  taskKey?: string;
  taskSource?: 'manual' | 'setting' | 'branch';
  developer?: string;
  developerName?: string;
  developerSource?: 'setting' | 'git';
  pendingTelemetry: number;
  telemetryError?: string;
  busy?: string;
}

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('magicode.status', vscode.StatusBarAlignment.Left, 50);

  constructor() {
    this.item.name = 'MagiCode';
    this.item.show();
  }

  update(vm: ViewModel): void {
    const item = this.item;
    if (!vm.hasKey) {
      item.text = '$(key) MagiCode: configurar key';
      item.command = 'magicode.configureApiKey';
      item.tooltip = 'Configura tu API key de MagiHub (se guarda en SecretStorage)';
      return;
    }
    if (!vm.session) {
      item.text = vm.repoRoot ? '$(sparkle) MagiCode · sin sesión' : '$(sparkle) MagiCode · sin repo Git';
      item.command = vm.repoRoot ? 'magicode.startSession' : undefined;
      item.tooltip = vm.repoRoot ? 'Iniciar sesión MagiCode' : 'Abre una carpeta con un repositorio Git';
      return;
    }
    const st = vm.session.stats;
    const task = vm.taskKey ? ` · ${vm.taskKey}` : '';
    const spin = vm.busy ? '$(loading~spin) ' : '';
    item.text = `${spin}$(sparkle) MagiCode${task} · ${compact(st.tokens_reported)} tok · ${fmt(st.accepted_lines)} líneas`;
    item.command = 'magicode.showStats';
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**MagiCode** · sesión \`${vm.session.id.slice(0, 8)}\`\n\n`);
    md.appendMarkdown(`$(repo) ${vm.repository ?? '—'} · $(git-branch) ${vm.branch ?? '(detached)'}`);
    md.appendMarkdown(vm.taskKey ? ` · $(tasklist) ${vm.taskKey}\n\n` : '\n\n');
    md.appendMarkdown(`$(account) ${developerLabel(vm.developer, vm.developerName)}\n\n`);
    md.appendMarkdown(`**${fmt(st.tokens_reported)} tokens** — ${TOKENS_NOTE}\n\n`);
    if (st.last_model) md.appendMarkdown(`$(hubot) ${modelLabel(st)}\n\n`);
    md.appendMarkdown(`${st.accepted} aceptados · ${fmt(st.accepted_lines)} líneas · ${fmt(st.effective_lines, 1)} efectivas\n\n`);
    if (vm.pendingTelemetry > 0) md.appendMarkdown(`$(cloud-upload) ${vm.pendingTelemetry} eventos pendientes de envío\n\n`);
    if (vm.telemetryError) md.appendMarkdown(`$(warning) Telemetría: ${vm.telemetryError}\n\n`);
    if (vm.busy) md.appendMarkdown(`$(loading~spin) ${vm.busy}`);
    item.tooltip = md;
  }

  dispose(): void {
    this.item.dispose();
  }
}

class StatItem extends vscode.TreeItem {
  constructor(label: string, description: string, icon: string, tooltip?: string, command?: vscode.Command) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.tooltip = tooltip ?? `${label}: ${description}`;
    if (command) this.command = command;
  }
}

export class SessionTreeProvider implements vscode.TreeDataProvider<StatItem>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private vm: ViewModel = { hasKey: false, pendingTelemetry: 0 };

  update(vm: ViewModel): void {
    this.vm = vm;
    this.emitter.fire();
  }

  getTreeItem(e: StatItem): vscode.TreeItem {
    return e;
  }

  getChildren(): StatItem[] {
    const vm = this.vm;
    // sin key / sin sesión → la vista muestra el contenido de viewsWelcome (package.json)
    if (!vm.hasKey || !vm.session) return [];
    const s = vm.session;
    const st = s.stats;
    const taskSrc = vm.taskSource === 'manual' ? 'manual' : vm.taskSource === 'setting' ? 'ajuste' : 'inferida de la rama';
    const items = [
      new StatItem('Sesión', s.id.slice(0, 8), 'pulse', `Sesión ${s.id}\nDesde ${new Date(s.started_at).toLocaleString('es')}`),
      new StatItem('Repositorio', vm.repository ?? '—', 'repo', vm.repoRoot),
      new StatItem('Rama', vm.branch ?? '(detached)', 'git-branch'),
      new StatItem(
        'Developer',
        vm.developer ?? vm.developerName ?? '—',
        'account',
        vm.developer
          ? `${developerLabel(vm.developer, vm.developerName)} (${vm.developerSource === 'setting' ? 'ajuste magicode.developerEmail' : 'git config user.email'})`
          : 'Sin email: configura git config user.email o el ajuste magicode.developerEmail',
      ),
      new StatItem('Tarea', vm.taskKey ?? '—', 'tasklist', vm.taskKey ? `Tarea ${vm.taskKey} (${taskSrc})` : 'Sin tarea: usa "MagiCode: Set Task" o una rama tipo feature/MAG-123-…', {
        command: 'magicode.setTask',
        title: 'Set Task',
      }),
      new StatItem('Peticiones', `${st.requests}${st.request_errors ? ` (${st.request_errors} error)` : ''}`, 'cloud'),
      new StatItem('Modelo', st.last_model ?? '—', 'hubot', `Modelo enrutado por Smart Auto: ${modelLabel(st)}`),
      new StatItem('Tokens reportados', fmt(st.tokens_reported), 'symbol-number', `Tokens ${TOKENS_NOTE}`),
      new StatItem('Propuestos', String(st.proposed), 'lightbulb'),
      new StatItem('Aceptados', String(st.accepted), 'check'),
      new StatItem('Rechazados', String(st.rejected), 'close'),
      new StatItem('Líneas aceptadas', fmt(st.accepted_lines), 'diff-added'),
      new StatItem(
        'Líneas efectivas',
        fmt(st.effective_lines, 1),
        'star-full',
        `Σ peso(kind)×peso(tier) de líneas no redundantes ni mecánicas.\nTokens / 100 líneas efectivas (estimado): ${per100(st.tokens_reported, st.effective_lines)}`,
      ),
      new StatItem('Commits', `${st.commits} · ${fmt(st.ai_committed_lines)} líneas IA`, 'git-commit'),
      new StatItem(
        'Referencia',
        s.reference ? `${s.reference.tag} · ${fmt(s.reference.surviving_lines)} sobreviven` : '—',
        'tag',
        s.reference ? `Versión de referencia (demo) ${s.reference.tag} @ ${s.reference.sha}` : 'Usa "MagiCode: Mark Reference Version"',
      ),
      new StatItem('Telemetría', vm.pendingTelemetry ? `${vm.pendingTelemetry} pendientes` : 'al día', 'cloud-upload', vm.telemetryError),
    ];
    return items;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
