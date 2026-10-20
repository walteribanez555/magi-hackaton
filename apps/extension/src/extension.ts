import * as vscode from 'vscode';
import { MagiCodeController } from './controller';

let controller: MagiCodeController | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const out = vscode.window.createOutputChannel('MagiCode');
  context.subscriptions.push(out);
  const c = new MagiCodeController(context, out);
  controller = c;
  context.subscriptions.push(c);

  const register = (id: string, fn: () => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async () => {
        try {
          await fn();
        } catch (err) {
          c.log.error(`Comando ${id} falló`, err);
          void vscode.window.showErrorMessage(`MagiCode: ${(err as Error).message ?? String(err)}`);
        }
      }),
    );

  register('magicode.configureApiKey', () => c.configureApiKey());
  register('magicode.startSession', () => c.startSession());
  register('magicode.endSession', () => c.endSession('user'));
  register('magicode.generate', () => c.generate());
  register('magicode.markReference', () => c.markReference());
  register('magicode.installHook', () => c.installCommitHook());
  register('magicode.showStats', () => c.showStats());
  register('magicode.openDashboard', () => c.openDashboard());
  register('magicode.setTask', () => c.setTask());
  register('magicode.showLog', () => c.showLog());
  register('magicode.acceptEditedProposal', () => c.resolvePendingEdit(true));
  register('magicode.cancelEditedProposal', () => c.resolvePendingEdit(false));

  c.startUiTicker();
  c.log.info(`MagiCode ${String(context.extension.packageJSON.version)} activo en VS Code ${vscode.version}`);
  await c.init().catch((err) => c.log.error('Inicialización falló', err));
}

export async function deactivate(): Promise<void> {
  // La sesión NO se cierra al cerrar la ventana: se reanuda al volver (máx. 8 h de inactividad);
  // si expira, se emite session.ended{reason: idle}. La cola de telemetría queda persistida.
  await controller?.shutdown();
  controller = undefined;
}
