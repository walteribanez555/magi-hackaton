import * as nodePath from 'node:path';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { TaskKey, extractTaskKeys, type ProductivityEventType } from '@magicode/contracts';
import { outputHash } from '@magicode/metrics';
import { analyzeAcceptance, makeProposal, proposedPayload, type Proposal } from './changes';
import { analyzeCommit, computeReference, createAnnotatedTag, listNewCommits, readCommitDiff, readCommitHeader, tagExists } from './commits';
import { readConfig } from './config';
import { sessionSummary } from './format';
import {
  absoluteGitDir,
  currentBranch,
  defaultReferenceTag,
  headSha,
  hooksDir,
  isValidTagName,
  remoteUrl,
  repoRoot,
  repoSlugFromRemote,
  runGit,
  sanitizeRemoteUrl,
  toRepoPath,
} from './git';
import { hookStatus, installHook, removeSessionFile, writeSessionFile } from './hook';
import { createLogger, errorMessage, type Logger } from './log';
import { ProposalContentProvider } from './proposalProvider';
import { RepoHashIndex } from './repoIndex';
import {
  createSession,
  isResumable,
  markProcessed,
  recordCommitted,
  round2,
  sessionAcceptedHashes,
  SESSION_KEY,
  TASK_OVERRIDE_KEY,
  touch,
  type SessionState,
} from './session';
import {
  MAX_CONTEXT_CHARS,
  SmartAutoError,
  buildMessages,
  callSmartAuto,
  conformText,
  extractCodeBlock,
  fetchKeyIdentity,
  isLocalUrl,
  type SmartAutoResult,
} from './smartAuto';
import { TelemetryClient, type PayloadOf, type TelemetryContext } from './telemetry';
import { SessionTreeProvider, StatusBar, type ViewModel } from './views';

const SECRET_KEY = 'magicode.magihubApiKey';
const POLL_MS = 10_000;

interface RepoInfo {
  root: string;
  gitDir: string;
  repository: string;
  remote?: string;
}

type Decision = 'accept' | 'edit' | 'reject' | 'regenerate';

export class MagiCodeController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  readonly log: Logger;
  private readonly telemetry: TelemetryClient;
  private readonly proposals = new ProposalContentProvider();
  private readonly statusBar = new StatusBar();
  private readonly tree = new SessionTreeProvider();
  private apiKey: string | undefined;
  private repo: RepoInfo | undefined;
  private session: SessionState | undefined;
  private index: RepoHashIndex | undefined;
  private branch: string | undefined;
  private taskKey: string | undefined;
  private taskSource: ViewModel['taskSource'];
  private busy: string | undefined;
  private watchers: vscode.Disposable[] = [];
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private headCheck: Promise<void> = Promise.resolve();
  private headDebounce: ReturnType<typeof setTimeout> | undefined;
  private pendingEdit: { resolve: (accept: boolean) => void } | undefined;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly out: vscode.OutputChannel,
  ) {
    this.log = createLogger((l) => out.appendLine(l), () => [this.apiKey]);
    this.telemetry = new TelemetryClient({
      getBaseUrl: () => readConfig().telemetryUrl,
      getApiKey: () => this.getApiKey(),
      store: ctx.globalState,
      logger: this.log,
    });
    this.disposables.push(
      this.proposals,
      this.statusBar,
      this.tree,
      vscode.workspace.registerTextDocumentContentProvider('magicode-proposal', this.proposals),
      vscode.window.registerTreeDataProvider('magicode.sessionView', this.tree),
      ctx.secrets.onDidChange((e) => {
        if (e.key === SECRET_KEY) {
          this.apiKey = undefined;
          void this.getApiKey().then(() => this.refreshViews());
        }
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => this.onSaved(doc)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('magicode')) void this.onConfigChanged();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.init()),
    );
  }

  // ───────────────────────────── ciclo de vida ─────────────────────────────

  async init(): Promise<void> {
    await this.getApiKey();
    const repo = await this.detectRepo();
    if (repo?.root !== this.repo?.root) {
      this.stopWatcher();
      this.repo = repo;
      this.session = undefined;
      this.index = undefined;
    }
    if (!this.repo) {
      this.log.info('No hay repositorio Git abierto: la sesión se iniciará al abrir uno.');
      this.refreshViews();
      return;
    }
    this.log.info(`Repo: ${this.repo.root} (${this.repo.repository})`);
    await this.refreshBranch(false);
    if (!this.session) {
      const stored = this.ctx.workspaceState.get<SessionState>(SESSION_KEY);
      if (isResumable(stored, this.repo.root)) {
        this.session = stored;
        this.log.info(`Sesión reanudada ${stored.id}`);
        this.afterSessionStart();
      } else {
        if (stored) this.endStoredSession(stored, 'idle');
        await this.startSession(true);
      }
    }
    this.startWatcher();
    this.refreshViews();
  }

  private async detectRepo(): Promise<RepoInfo | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const candidates = folders.filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active?.scheme === 'file') candidates.unshift(nodePath.dirname(active.fsPath));
    for (const dir of candidates) {
      const root = await repoRoot(dir);
      if (!root) continue;
      const gitDir = (await absoluteGitDir(root)) ?? nodePath.join(root, '.git');
      const remote = await remoteUrl(root);
      const cfg = readConfig();
      const repository = (cfg.repository || repoSlugFromRemote(remote) || nodePath.basename(root)).slice(0, 256);
      return { root, gitDir, repository, ...(remote ? { remote: sanitizeRemoteUrl(remote) } : {}) };
    }
    return undefined;
  }

  private projectId(): string {
    const cfg = readConfig();
    if (cfg.projectId) return cfg.projectId.slice(0, 128);
    const repo = this.repo?.repository ?? 'magicode';
    return (repo.split('/').pop() || repo).slice(0, 128);
  }

  private contextFor(session: SessionState): TelemetryContext {
    return {
      session_id: session.id,
      project_id: this.projectId(),
      repository: this.repo?.repository ?? 'local',
      ...(this.branch ? { branch: this.branch.slice(0, 256) } : {}),
      ...(this.taskKey ? { task_key: this.taskKey } : {}),
    };
  }

  private emit<T extends ProductivityEventType>(type: T, payload: PayloadOf<T>, session = this.session): boolean {
    if (!session) return false;
    const ev = this.telemetry.track(this.contextFor(session), type, payload);
    this.refreshViews();
    return !!ev;
  }

  async startSession(auto = false): Promise<void> {
    if (!this.repo) {
      await this.init();
      if (!this.repo) {
        if (!auto) void vscode.window.showWarningMessage('MagiCode: abre una carpeta con un repositorio Git para iniciar una sesión.');
        return;
      }
      if (this.session) return; // init ya la inició
    }
    if (this.session && !auto) {
      const pick = await vscode.window.showWarningMessage(
        `Ya hay una sesión activa (${this.session.id.slice(0, 8)}). ¿Terminarla e iniciar una nueva?`,
        { modal: true },
        'Nueva sesión',
      );
      if (pick !== 'Nueva sesión') return;
      await this.endSession('user', true);
    }
    const head = await headSha(this.repo.root);
    await this.refreshBranch(false);
    this.session = createSession(this.repo.root, new Date(), head);
    await this.persist();
    this.emit('session.started', {
      editor: `vscode ${vscode.version}`.slice(0, 60),
      extension_version: String(this.ctx.extension.packageJSON.version ?? '0.0.0').slice(0, 30),
      ...(this.branch ? { branch: this.branch.slice(0, 256) } : {}),
      ...(head ? { head_sha: head } : {}),
    });
    this.log.info(`Sesión iniciada ${this.session.id}${auto ? ' (automática)' : ''}`);
    this.afterSessionStart();
    if (!auto) void vscode.window.showInformationMessage(`MagiCode: sesión ${this.session.id.slice(0, 8)} iniciada.`);
  }

  private afterSessionStart(): void {
    if (!this.session || !this.repo) return;
    this.index = new RepoHashIndex(this.session.salt, this.repo.root, this.log);
    void this.index.ensureBuilt();
    void this.syncSessionFile();
    this.startWatcher();
    this.refreshViews();
  }

  async endSession(reason: 'user' | 'window-closed' | 'idle' = 'user', silent = false): Promise<void> {
    const s = this.session;
    if (!s) {
      if (!silent) void vscode.window.showInformationMessage('MagiCode: no hay sesión activa.');
      return;
    }
    await this.checkHead(); // registra commits pendientes antes de cerrar
    this.emit('session.ended', { reason }, s);
    this.session = undefined;
    this.index = undefined;
    await this.ctx.workspaceState.update(SESSION_KEY, undefined);
    if (this.repo) await removeSessionFile(this.repo.gitDir).catch(() => undefined);
    void this.telemetry.flush(true);
    this.log.info(`Sesión terminada ${s.id} (${reason})`);
    this.refreshViews();
    if (!silent) void vscode.window.showInformationMessage(`MagiCode: sesión ${s.id.slice(0, 8)} terminada.`);
  }

  private endStoredSession(stored: SessionState, reason: 'idle' | 'window-closed'): void {
    this.telemetry.track(
      { session_id: stored.id, project_id: this.projectId(), repository: this.repo?.repository ?? 'local' },
      'session.ended',
      { reason },
    );
    this.log.info(`Sesión anterior ${stored.id} cerrada (${reason})`);
  }

  private async persist(): Promise<void> {
    if (this.session) {
      touch(this.session);
      await this.ctx.workspaceState.update(SESSION_KEY, this.session);
    }
    this.refreshViews();
  }

  private async ensureSession(): Promise<SessionState | undefined> {
    if (!this.session) await this.startSession(true);
    if (!this.session) void vscode.window.showWarningMessage('MagiCode: abre un repositorio Git para usar MagiCode.');
    return this.session;
  }

  // ───────────────────────────── API key ─────────────────────────────

  private async getApiKey(): Promise<string | undefined> {
    if (this.apiKey === undefined) this.apiKey = (await this.ctx.secrets.get(SECRET_KEY)) || undefined;
    return this.apiKey;
  }

  async configureApiKey(): Promise<void> {
    const cfg = readConfig();
    const key = await vscode.window.showInputBox({
      title: 'MagiCode: API key de MagiHub',
      prompt: `Se valida contra ${cfg.magihubBaseUrl}/v1/keys/self y se guarda en SecretStorage (nunca en settings ni en logs).`,
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'mh_…',
      validateInput: (v) => (v.trim().length < 8 ? 'La key parece demasiado corta' : undefined),
    });
    if (!key) return;
    const trimmed = key.trim();
    const res = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'MagiCode: validando API key…' },
      () => fetchKeyIdentity(cfg.magihubBaseUrl, trimmed),
    );
    if (!res.ok) {
      const pick = await vscode.window.showWarningMessage(
        `No se pudo validar la key: ${res.message}. ¿Guardarla de todos modos?`,
        { modal: true },
        'Guardar',
      );
      if (pick !== 'Guardar') return;
    }
    this.apiKey = trimmed;
    await this.ctx.secrets.store(SECRET_KEY, trimmed);
    if (res.ok) {
      const id = res.identity;
      this.log.info(`API key configurada: tenant ${id.tenant_id}, key ${id.key_id}${id.key_name ? ` (${id.key_name})` : ''}`);
      const models = id.governance?.allowed_models?.length ? ` · modelos: ${id.governance.allowed_models.join(', ')}` : '';
      void vscode.window.showInformationMessage(`MagiCode conectado a MagiHub: ${id.key_name ?? id.key_id} (tenant ${id.tenant_id})${models}`);
    }
    void this.telemetry.flush(true);
    if (!this.session) await this.init();
    this.refreshViews();
  }

  // ───────────────────────────── generar y aplicar ─────────────────────────────

  async generate(prefill?: { instruction: string; regenerates: string; uri: vscode.Uri }): Promise<void> {
    if (this.busy) {
      void vscode.window.showInformationMessage(`MagiCode está ocupado: ${this.busy}`);
      return;
    }
    const key = await this.getApiKey();
    if (!key) {
      const pick = await vscode.window.showWarningMessage('MagiCode: configura primero tu API key de MagiHub.', 'Configurar');
      if (pick) await this.configureApiKey();
      if (!(await this.getApiKey())) return;
    }
    const session = await this.ensureSession();
    if (!session || !this.repo) return;

    let editor = vscode.window.activeTextEditor;
    if (prefill) {
      const doc = await vscode.workspace.openTextDocument(prefill.uri);
      editor = await vscode.window.showTextDocument(doc, { preview: false });
    }
    if (!editor || editor.document.uri.scheme !== 'file') {
      void vscode.window.showWarningMessage('MagiCode: abre el archivo del repo que quieres modificar.');
      return;
    }
    const doc = editor.document;
    const repoPath = toRepoPath(this.repo.root, doc.uri.fsPath);
    if (!repoPath) {
      void vscode.window.showWarningMessage('MagiCode: el archivo no está dentro del repositorio Git de la sesión.');
      return;
    }
    const originalText = doc.getText();
    if (originalText.length > MAX_CONTEXT_CHARS) {
      void vscode.window.showWarningMessage(`MagiCode: el archivo es demasiado grande (${originalText.length} caracteres > ${MAX_CONTEXT_CHARS}).`);
      return;
    }
    const sel = editor.selection;
    const selection = sel.isEmpty
      ? undefined
      : { startLine: sel.start.line + 1, endLine: sel.end.line + 1, text: doc.getText(sel) };

    const instruction = await vscode.window.showInputBox({
      title: `MagiCode · Smart Auto → ${repoPath}${selection ? ` (líneas ${selection.startLine}–${selection.endLine})` : ''}`,
      prompt: prefill ? 'Regenerar: ajusta la instrucción si quieres' : 'Describe el cambio que quieres en este archivo',
      value: prefill?.instruction,
      placeHolder: 'p. ej. agrega una función clamp(x, min, max) con validación',
      ignoreFocusOut: true,
    });
    if (!instruction?.trim()) return;

    const cfg = readConfig();
    const messages = buildMessages({ path: repoPath, languageId: doc.languageId, fileContent: originalText, instruction, selection });
    const versionAtRequest = doc.version;

    let result: SmartAutoResult;
    this.setBusy('esperando a Smart Auto…');
    try {
      result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'MagiCode · Smart Auto', cancellable: true },
        async (progress, token) => {
          progress.report({ message: `generando cambio para ${repoPath}…` });
          const ac = new AbortController();
          const sub = token.onCancellationRequested(() => ac.abort());
          try {
            return await callSmartAuto({
              baseUrl: cfg.magihubBaseUrl,
              apiKey: (await this.getApiKey())!,
              messages,
              signal: ac.signal,
              timeoutMs: cfg.requestTimeoutSeconds * 1000,
              localId: randomUUID,
            });
          } finally {
            sub.dispose();
          }
        },
      );
    } catch (err) {
      this.setBusy(undefined);
      this.recordRequestFailure(session, err, prefill?.regenerates);
      return;
    }
    this.setBusy(undefined);

    const extracted = extractCodeBlock(result.content);
    const proposedText = extracted
      ? conformText(extracted.code, doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n', originalText.length === 0 || /\n$/.test(originalText))
      : undefined;
    session.stats.requests++;
    if (result.usage) session.stats.tokens_reported += result.usage.total_tokens;
    this.emit('ai.request.completed', {
      ai_request_id: result.requestId,
      ...(result.model ? { model: result.model } : {}),
      status: 'ok',
      latency_ms: result.latencyMs,
      ...(result.usage ? { usage: result.usage, usage_source: this.usageSource(result.simulated) } : {}),
      ...(extracted && extracted.code.trim() ? { output_hash: outputHash(extracted.code) } : {}),
      ...(prefill?.regenerates ? { regenerates: prefill.regenerates.slice(0, 128) } : {}),
    });
    this.log.info(
      `Smart Auto ok: request ${result.requestId} (${result.requestIdSource}) · modelo ${result.model ?? '?'} · ` +
        `${result.usage?.total_tokens ?? '?'} tokens · ${result.latencyMs} ms${result.simulated ? ' · SIMULADO' : ''}`,
    );
    await this.persist();

    if (!extracted || proposedText === undefined || !extracted.code.trim()) {
      void vscode.window.showWarningMessage('MagiCode: Smart Auto no devolvió código utilizable. Los tokens quedan registrados como exploración.');
      return;
    }
    if (!extracted.fenced) this.log.warn('La respuesta no traía bloque de código; se usó el texto completo.');
    if (extracted.truncated) void vscode.window.showWarningMessage('MagiCode: la respuesta parece truncada (bloque sin cerrar). Revisa el diff con cuidado.');
    if (proposedText === originalText) {
      void vscode.window.showInformationMessage('MagiCode: la propuesta no cambia el archivo.');
      return;
    }

    const proposal = makeProposal({
      change_id: randomUUID(),
      ai_request_id: result.requestId,
      path: repoPath,
      language: doc.languageId,
      originalText,
      proposedText,
      ...(prefill?.regenerates ? { regenerates: prefill.regenerates } : {}),
    });
    session.stats.proposed++;
    this.emit('code.proposed', proposedPayload(session.salt, proposal));
    await this.persist();

    const decision = await this.review(doc, proposal);
    await this.handleDecision(session, doc, proposal, decision, versionAtRequest, instruction);
  }

  private usageSource(simulated: boolean): 'magihub-mock' | 'magihub-response' {
    return simulated || isLocalUrl(readConfig().magihubBaseUrl) ? 'magihub-mock' : 'magihub-response';
  }

  private recordRequestFailure(session: SessionState, err: unknown, regenerates?: string): void {
    const e =
      err instanceof SmartAutoError ? err : new SmartAutoError(errorMessage(err), 'error', `local-${randomUUID()}`, 0);
    session.stats.requests++;
    if (e.status === 'error') session.stats.request_errors++;
    if (e.usage) session.stats.tokens_reported += e.usage.total_tokens;
    this.emit('ai.request.completed', {
      ai_request_id: e.requestId,
      ...(e.model ? { model: e.model } : {}),
      status: e.status,
      latency_ms: e.latencyMs,
      ...(e.usage ? { usage: e.usage, usage_source: this.usageSource(e.simulated) } : {}),
      ...(regenerates ? { regenerates: regenerates.slice(0, 128) } : {}),
    });
    void this.persist();
    if (e.status === 'cancelled') {
      this.log.info('Petición a Smart Auto cancelada por el usuario');
      return;
    }
    this.log.error('Smart Auto falló', e);
    void vscode.window.showErrorMessage(`MagiCode: ${e.message}`, 'Ver log').then((p) => p && this.out.show(true));
  }

  private async review(doc: vscode.TextDocument, p: Proposal): Promise<Decision> {
    const proposalUri = this.proposals.register(p.path, p.change_id, p.proposedText);
    const added = p.addedLines.filter((l) => l.trim()).length;
    const deleted = p.deletedLines.filter((l) => l.trim()).length;
    await vscode.commands.executeCommand(
      'vscode.diff',
      doc.uri,
      proposalUri,
      `MagiCode: ${nodePath.basename(p.path)} (actual ↔ propuesta Smart Auto)`,
      { preview: true },
    );
    type Item = vscode.QuickPickItem & { id: Decision };
    const items: Item[] = [
      { id: 'accept', label: '$(check) Aceptar', description: `aplica la propuesta (+${added} −${deleted})` },
      { id: 'edit', label: '$(edit) Editar y aceptar', description: 'abre la propuesta editable y aplica tu versión' },
      { id: 'reject', label: '$(close) Rechazar', description: 'descarta la propuesta' },
      { id: 'regenerate', label: '$(refresh) Regenerar', description: 'pide otra versión a Smart Auto' },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: `MagiCode · ${p.path}: +${added} −${deleted} líneas`,
      placeHolder: 'Revisa el diff y decide',
      ignoreFocusOut: true,
    });
    await this.closeDiff(proposalUri);
    this.proposals.release(proposalUri);
    return pick?.id ?? 'reject';
  }

  private async closeDiff(proposalUri: vscode.Uri): Promise<void> {
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    const target = tabs.filter(
      (t) =>
        (t.input instanceof vscode.TabInputTextDiff && t.input.modified.toString() === proposalUri.toString()) ||
        (t.input instanceof vscode.TabInputText && t.input.uri.toString() === proposalUri.toString()),
    );
    if (target.length) await vscode.window.tabGroups.close(target, true).then(undefined, () => undefined);
  }

  private async handleDecision(
    session: SessionState,
    doc: vscode.TextDocument,
    p: Proposal,
    decision: Decision,
    versionAtRequest: number,
    instruction: string,
  ): Promise<void> {
    switch (decision) {
      case 'accept':
        await this.applyAndRecord(session, doc, p, p.proposedText, false, versionAtRequest);
        return;
      case 'edit': {
        const edited = await this.editProposal(doc, p);
        if (edited === undefined) {
          this.reject(session, p, 'user');
          await this.persist();
          return;
        }
        await this.applyAndRecord(session, doc, p, edited, edited !== p.proposedText, versionAtRequest);
        return;
      }
      case 'regenerate':
        this.reject(session, p, 'superseded');
        await this.persist();
        await this.generate({ instruction, regenerates: p.ai_request_id, uri: doc.uri });
        return;
      default:
        this.reject(session, p, 'user');
        await this.persist();
    }
  }

  private reject(session: SessionState, p: Proposal, reason: 'user' | 'superseded'): void {
    session.stats.rejected++;
    this.emit('code.rejected', { change_id: p.change_id, ai_request_id: p.ai_request_id, reason });
    this.log.info(`Propuesta ${p.change_id.slice(0, 8)} rechazada (${reason})`);
  }

  /**
   * Abre la propuesta en un documento sin título editable; devuelve el texto final o undefined.
   * Se confirma con el botón ✓ del título del editor, el comando "Accept Edited Proposal" o la
   * notificación; cerrar el borrador o "Cancelar" lo descarta.
   */
  private async editProposal(doc: vscode.TextDocument, p: Proposal): Promise<string | undefined> {
    const scratch = await vscode.workspace.openTextDocument({ content: p.proposedText, language: doc.languageId });
    await vscode.window.showTextDocument(scratch, { preview: false, viewColumn: vscode.ViewColumn.Beside });
    await vscode.commands.executeCommand('setContext', 'magicode.editingProposal', true);
    const accepted = await new Promise<boolean>((resolve) => {
      const subs: vscode.Disposable[] = [];
      const done = (v: boolean) => {
        for (const d of subs) d.dispose();
        this.pendingEdit = undefined;
        resolve(v);
      };
      this.pendingEdit = { resolve: done };
      subs.push(
        vscode.workspace.onDidCloseTextDocument((d) => {
          if (d.uri.toString() === scratch.uri.toString()) done(false);
        }),
      );
      void vscode.window
        .showInformationMessage(`MagiCode: edita la propuesta para ${p.path} y pulsa "Aceptar edición" (o ✓ en el título del editor).`, 'Aceptar edición', 'Cancelar')
        .then((pick) => {
          if (pick === 'Aceptar edición') done(true);
          else if (pick === 'Cancelar') done(false);
          // notificación descartada sin elegir: sigue esperando al botón del editor
        });
    });
    await vscode.commands.executeCommand('setContext', 'magicode.editingProposal', false);
    const text = scratch.getText();
    if (!scratch.isClosed) {
      // cerrar el borrador sin preguntar por guardar
      await vscode.window.showTextDocument(scratch, { preview: false });
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
    if (!accepted) return undefined;
    const trailing = p.originalText.length === 0 || /\n$/.test(p.originalText);
    return conformText(text, doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n', trailing);
  }

  /** Resuelve el "Editar y aceptar" en curso (botones del título del editor). */
  resolvePendingEdit(accept: boolean): void {
    if (this.pendingEdit) this.pendingEdit.resolve(accept);
    else void vscode.window.showInformationMessage('MagiCode: no hay una propuesta en edición.');
  }

  private async applyAndRecord(
    session: SessionState,
    doc: vscode.TextDocument,
    p: Proposal,
    finalText: string,
    edited: boolean,
    versionAtRequest: number,
  ): Promise<void> {
    if (doc.isClosed) doc = await vscode.workspace.openTextDocument(doc.uri);
    if (doc.version !== versionAtRequest && doc.getText() !== p.originalText) {
      const go = await vscode.window.showWarningMessage(
        `${p.path} cambió desde que se pidió la propuesta. Aplicarla reemplaza el archivo completo.`,
        { modal: true },
        'Aplicar igualmente',
      );
      if (go !== 'Aplicar igualmente') {
        this.reject(session, p, 'user');
        await this.persist();
        return;
      }
    }
    const baseText = doc.getText();
    if (finalText === baseText) {
      void vscode.window.showInformationMessage('MagiCode: la versión final no cambia el archivo; se registra como rechazada.');
      this.reject(session, p, 'user');
      await this.persist();
      return;
    }
    // índice del repo ANTES de aplicar (redundancia existing_in_repo)
    const index = this.index;
    if (index && !index.ready) {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'MagiCode: indexando repo…' }, () => index.ensureBuilt());
    }
    const analysis = analyzeAcceptance({
      salt: session.salt,
      proposal: p,
      finalText,
      baseText,
      edited,
      existingRepoHashes: index?.snapshot() ?? new Set<string>(),
      sessionAcceptedHashes: sessionAcceptedHashes(session),
    });

    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(baseText.length)), finalText);
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) {
      void vscode.window.showErrorMessage('MagiCode: no se pudo aplicar el cambio al archivo.');
      return;
    }
    await doc.save();
    index?.setFile(p.path, finalText);

    session.changes.push(analysis.stored);
    session.stats.accepted++;
    session.stats.accepted_lines += analysis.payload.accepted_added_lines;
    session.stats.effective_lines = round2(session.stats.effective_lines + analysis.payload.dimensions.effective_lines);
    await this.persist();
    this.emit('code.accepted', analysis.payload);
    const d = analysis.payload.dimensions;
    this.log.info(
      `Cambio ${p.change_id.slice(0, 8)} aceptado${edited ? ' (editado)' : ''}: +${analysis.payload.accepted_added_lines} −${analysis.payload.accepted_deleted_lines} · ` +
        `importancia ${d.importance.score.toFixed(2)} · redundantes ${d.redundancy.redundant_lines} · mecánicas ${d.automation.mechanical_lines} · efectivas ${d.effective_lines}`,
    );
    void vscode.window.showInformationMessage(
      `MagiCode: cambio aplicado a ${p.path} (+${analysis.payload.accepted_added_lines} líneas, ${round2(d.effective_lines)} efectivas). Haz commit para registrarlo en Git.`,
    );
  }

  // ───────────────────────────── Git ─────────────────────────────

  private startWatcher(): void {
    if (!this.repo || this.watchers.length) return;
    const base = vscode.Uri.file(this.repo.gitDir);
    const fire = () => this.scheduleHeadCheck();
    for (const glob of ['HEAD', 'packed-refs', 'refs/**']) {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, glob));
      this.watchers.push(w, w.onDidChange(fire), w.onDidCreate(fire), w.onDidDelete(fire));
    }
    this.pollTimer = setInterval(fire, POLL_MS);
  }

  private stopWatcher(): void {
    for (const d of this.watchers) d.dispose();
    this.watchers = [];
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private scheduleHeadCheck(): void {
    if (this.headDebounce) clearTimeout(this.headDebounce);
    this.headDebounce = setTimeout(() => void this.checkHead(), 400);
  }

  /** Serializa las revisiones de HEAD (watcher + polling). */
  checkHead(): Promise<void> {
    this.headCheck = this.headCheck.then(() => this.doCheckHead()).catch((err) => this.log.error('Error revisando HEAD', err));
    return this.headCheck;
  }

  private async doCheckHead(): Promise<void> {
    if (!this.repo) return;
    await this.refreshBranch(true);
    const s = this.session;
    if (!s) return;
    const head = await headSha(this.repo.root);
    if (!head || head === s.last_head) return;
    const shas = await listNewCommits(this.repo.root, s.last_head, head);
    const since = Date.parse(s.started_at) - 60_000;
    let emitted = 0;
    for (const sha of shas) {
      if (s.processed_shas.includes(sha)) continue;
      markProcessed(s, sha);
      const header = await readCommitHeader(this.repo.root, sha);
      if (!header) continue;
      const committedMs = Date.parse(header.committedAt);
      if (Number.isFinite(committedMs) && committedMs < since) continue; // commits previos a la sesión
      const diff = await readCommitDiff(this.repo.root, header);
      const a = analyzeCommit(s, header, diff);
      this.log.debug(`Commit ${sha.slice(0, 8)}: ${a.payload.change_ids.length} cambios IA, trailer=${a.payload.has_session_trailer}`);
      if (!a.matched) continue;
      recordCommitted(s, a.payload.change_ids, a.matchedHashes);
      s.commits.push({
        sha,
        committed_at: header.committedAt,
        change_ids: a.payload.change_ids,
        ai_share: a.payload.automation.ai_share,
        ai_matched_lines: a.aiMatchedLines,
        has_session_trailer: a.payload.has_session_trailer,
      });
      s.stats.commits++;
      s.stats.ai_committed_lines += a.aiMatchedLines;
      this.emit('git.committed', {
        ...a.payload,
        ...(this.branch ? { branch: this.branch.slice(0, 256) } : {}),
        ...(this.repo.remote ? { remote_url: this.repo.remote.slice(0, 512) } : {}),
      });
      emitted++;
      this.log.info(
        `Commit ${sha.slice(0, 8)} registrado: ${a.payload.change_ids.length} cambios IA · ai_share ${(a.payload.automation.ai_share * 100).toFixed(0)}% · ` +
          `${a.payload.automation.ai_lost_lines} líneas IA perdidas`,
      );
    }
    s.last_head = head;
    await this.persist();
    void this.index?.refresh();
    if (emitted > 0) {
      void vscode.window.setStatusBarMessage(`$(git-commit) MagiCode: ${emitted} commit(s) con cambios IA registrados`, 5000);
    }
  }

  private async refreshBranch(notify: boolean): Promise<void> {
    if (!this.repo) return;
    const branch = await currentBranch(this.repo.root);
    const prevBranch = this.branch;
    const prevTask = this.taskKey;
    this.branch = branch;
    this.resolveTask();
    if (prevBranch !== this.branch || prevTask !== this.taskKey) {
      if (notify) this.log.info(`Rama: ${this.branch ?? '(detached)'} · tarea: ${this.taskKey ?? '—'}`);
      void this.syncSessionFile();
      this.refreshViews();
    }
  }

  private resolveTask(): void {
    const manual = this.ctx.workspaceState.get<string>(TASK_OVERRIDE_KEY);
    const setting = readConfig().taskKey;
    const inferred = extractTaskKeys(this.branch)[0];
    if (manual && TaskKey.safeParse(manual).success) {
      this.taskKey = manual;
      this.taskSource = 'manual';
    } else if (setting && TaskKey.safeParse(setting).success) {
      this.taskKey = setting;
      this.taskSource = 'setting';
    } else if (inferred && TaskKey.safeParse(inferred).success) {
      this.taskKey = inferred;
      this.taskSource = 'branch';
    } else {
      this.taskKey = undefined;
      this.taskSource = undefined;
    }
  }

  async setTask(): Promise<void> {
    const inferred = extractTaskKeys(this.branch)[0];
    const value = await vscode.window.showInputBox({
      title: 'MagiCode: tarea (Jira) de esta sesión',
      prompt: `Clave tipo MAG-123. Vacío = inferir de la rama${inferred ? ` (${inferred})` : ''} o del ajuste magicode.taskKey.`,
      value: this.taskSource === 'manual' ? this.taskKey : '',
      placeHolder: inferred ?? 'MAG-123',
      validateInput: (v) => (!v.trim() || TaskKey.safeParse(v.trim().toUpperCase()).success ? undefined : 'Formato esperado: PROYECTO-123'),
    });
    if (value === undefined) return;
    const key = value.trim().toUpperCase();
    await this.ctx.workspaceState.update(TASK_OVERRIDE_KEY, key || undefined);
    this.resolveTask();
    await this.syncSessionFile();
    this.refreshViews();
    void vscode.window.showInformationMessage(this.taskKey ? `MagiCode: tarea ${this.taskKey}` : 'MagiCode: sin tarea asociada');
  }

  private async syncSessionFile(): Promise<void> {
    if (!this.repo) return;
    try {
      if (this.session && readConfig().addSessionTrailer) await writeSessionFile(this.repo.gitDir, this.session.id, this.taskKey);
      else await removeSessionFile(this.repo.gitDir);
    } catch (err) {
      this.log.warn(`No se pudo escribir ${this.repo.gitDir}/magicode-session: ${errorMessage(err)}`);
    }
  }

  async installCommitHook(): Promise<void> {
    if (!this.repo) {
      void vscode.window.showWarningMessage('MagiCode: no hay repositorio Git abierto.');
      return;
    }
    const dir = await hooksDir(this.repo.root);
    if (!dir) {
      void vscode.window.showErrorMessage('MagiCode: no se pudo resolver la carpeta de hooks de Git.');
      return;
    }
    const status = await hookStatus(dir);
    let backup = false;
    if (status === 'foreign') {
      const pick = await vscode.window.showWarningMessage(
        `Ya existe un hook prepare-commit-msg en ${dir}. ¿Reemplazarlo? (se guarda una copia como prepare-commit-msg.magicode-backup)`,
        { modal: true },
        'Reemplazar',
      );
      if (pick !== 'Reemplazar') return;
      backup = true;
    }
    const path = await installHook(dir, { backup });
    await this.syncSessionFile();
    this.log.info(`Hook instalado en ${path}`);
    const hooksPath = await runGit(this.repo.root, ['config', '--get', 'core.hooksPath']);
    const extra = hooksPath.stdout.trim() ? ` (core.hooksPath = ${hooksPath.stdout.trim()})` : '';
    const off = readConfig().addSessionTrailer ? '' : ' Ojo: magicode.addSessionTrailer está desactivado, así que el hook no agregará nada.';
    void vscode.window.showInformationMessage(
      `MagiCode: hook prepare-commit-msg ${status === 'magicode' ? 'actualizado' : 'instalado'}${extra}. Los commits llevarán "MagiCode-Session: <id>"${this.taskKey ? ` y "MagiCode-Task: ${this.taskKey}"` : ''}.${off}`,
    );
  }

  async markReference(): Promise<void> {
    const s = await this.ensureSession();
    if (!s || !this.repo) return;
    await this.checkHead();
    const head = await headSha(this.repo.root);
    if (!head) {
      void vscode.window.showWarningMessage('MagiCode: el repo no tiene commits todavía.');
      return;
    }
    const tag = await vscode.window.showInputBox({
      title: 'MagiCode: marcar versión de referencia (demo)',
      prompt: `Crea un tag anotado en HEAD (${head.slice(0, 8)}) y mide qué líneas IA sobreviven. No se etiqueta como "despliegue".`,
      value: defaultReferenceTag(),
      ignoreFocusOut: true,
      validateInput: (v) => (isValidTagName(v.trim()) ? undefined : 'Nombre de tag inválido'),
    });
    if (!tag?.trim()) return;
    const name = tag.trim();
    try {
      if (await tagExists(this.repo.root, name)) {
        const pick = await vscode.window.showWarningMessage(`El tag ${name} ya existe. ¿Medir contra ese tag?`, { modal: true }, 'Usar existente');
        if (pick !== 'Usar existente') return;
      } else {
        await createAnnotatedTag(this.repo.root, name, `MagiCode: versión de referencia (demo)\n\nMagiCode-Session: ${s.id}${this.taskKey ? `\nMagiCode-Task: ${this.taskKey}` : ''}`);
      }
      const ref = await computeReference(this.repo.root, s, name);
      s.reference = {
        tag: name,
        sha: ref.sha,
        included_shas: ref.payload.included_shas,
        surviving_lines: ref.payload.surviving_lines,
        surviving_effective_lines: ref.payload.surviving_effective_lines,
        marked_at: new Date().toISOString(),
      };
      await this.persist();
      this.emit('reference.marked', ref.payload);
      this.log.info(
        `Referencia ${name} @ ${ref.sha.slice(0, 8)}: ${ref.payload.included_shas.length} commits de la sesión incluidos · ` +
          `${ref.payload.surviving_lines} líneas IA sobreviven (${ref.payload.surviving_effective_lines} efectivas)`,
      );
      const actions = this.repo.remote ? ['Publicar tag (git push)'] : [];
      const pick = await vscode.window.showInformationMessage(
        `MagiCode: versión de referencia (demo) ${name} @ ${ref.sha.slice(0, 8)} — ${ref.payload.surviving_lines} de ${s.stats.accepted_lines} líneas aceptadas sobreviven.`,
        ...actions,
      );
      if (pick) {
        const r = await runGit(this.repo.root, ['push', 'origin', `refs/tags/${name}`]);
        if (r.code === 0) void vscode.window.showInformationMessage(`MagiCode: tag ${name} publicado en origin.`);
        else void vscode.window.showErrorMessage(`MagiCode: git push falló: ${r.stderr.trim().slice(0, 200)}`);
      }
    } catch (err) {
      this.log.error('No se pudo marcar la versión de referencia', err);
      void vscode.window.showErrorMessage(`MagiCode: ${errorMessage(err)}`);
    }
  }

  // ───────────────────────────── UI ─────────────────────────────

  async showStats(): Promise<void> {
    if (!this.session) {
      const pick = await vscode.window.showInformationMessage('MagiCode: no hay sesión activa.', 'Iniciar sesión');
      if (pick) await this.startSession();
      return;
    }
    await this.checkHead();
    const detail = sessionSummary(this.session, {
      repository: this.repo?.repository,
      branch: this.branch,
      taskKey: this.taskKey,
      pendingTelemetry: this.telemetry.pending,
    });
    const pick = await vscode.window.showInformationMessage('MagiCode · estadísticas de la sesión', { modal: true, detail }, 'Abrir dashboard', 'Ver log');
    if (pick === 'Abrir dashboard') await this.openDashboard();
    if (pick === 'Ver log') this.out.show(true);
  }

  async openDashboard(): Promise<void> {
    const cfg = readConfig();
    let url: URL;
    try {
      url = new URL(cfg.dashboardUrl);
    } catch {
      void vscode.window.showErrorMessage(`MagiCode: magicode.dashboardUrl inválida (${cfg.dashboardUrl})`);
      return;
    }
    url.searchParams.set('project_id', this.projectId());
    if (this.repo) url.searchParams.set('repository', this.repo.repository);
    if (this.session) url.searchParams.set('session_id', this.session.id);
    if (this.taskKey) url.searchParams.set('task_key', this.taskKey);
    await vscode.env.openExternal(vscode.Uri.parse(url.toString()));
  }

  showLog(): void {
    this.out.show(true);
  }

  private setBusy(msg: string | undefined): void {
    this.busy = msg;
    this.refreshViews();
  }

  private refreshViews(): void {
    const vm: ViewModel = {
      hasKey: !!this.apiKey,
      session: this.session,
      repoRoot: this.repo?.root,
      repository: this.repo?.repository,
      branch: this.branch,
      taskKey: this.taskKey,
      taskSource: this.taskSource,
      pendingTelemetry: this.telemetry.pending,
      telemetryError: this.telemetry.lastError,
      busy: this.busy,
    };
    this.statusBar.update(vm);
    this.tree.update(vm);
    void vscode.commands.executeCommand('setContext', 'magicode.hasKey', vm.hasKey);
    void vscode.commands.executeCommand('setContext', 'magicode.hasSession', !!vm.session);
    void vscode.commands.executeCommand('setContext', 'magicode.hasRepo', !!vm.repoRoot);
  }

  private onSaved(doc: vscode.TextDocument): void {
    if (!this.repo || !this.index || doc.uri.scheme !== 'file') return;
    const p = toRepoPath(this.repo.root, doc.uri.fsPath);
    if (p && this.index.has(p)) this.index.setFile(p, doc.getText());
  }

  private async onConfigChanged(): Promise<void> {
    if (this.repo) {
      const cfg = readConfig();
      const remote = await remoteUrl(this.repo.root);
      this.repo.repository = (cfg.repository || repoSlugFromRemote(remote) || nodePath.basename(this.repo.root)).slice(0, 256);
    }
    this.resolveTask();
    await this.syncSessionFile();
    this.refreshViews();
  }

  /** Periódicamente refresca la UI (cola de telemetría). */
  startUiTicker(): void {
    const t = setInterval(() => this.refreshViews(), 5000);
    this.disposables.push({ dispose: () => clearInterval(t) });
  }

  async shutdown(): Promise<void> {
    this.stopWatcher();
    if (this.session) await this.ctx.workspaceState.update(SESSION_KEY, this.session);
    await this.telemetry.dispose();
  }

  dispose(): void {
    this.stopWatcher();
    if (this.headDebounce) clearTimeout(this.headDebounce);
    for (const d of this.disposables) d.dispose();
  }
}
