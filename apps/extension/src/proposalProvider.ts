import * as vscode from 'vscode';

export const PROPOSAL_SCHEME = 'magicode-proposal';

/** Documentos virtuales (solo lectura) con la propuesta de la IA, para `vscode.diff`. Viven solo en memoria. */
export class ProposalContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  /** Registra una propuesta y devuelve su URI (`magicode-proposal:/<ruta>?<change_id>`). */
  register(repoPath: string, changeId: string, content: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: PROPOSAL_SCHEME, path: `/${repoPath}`, query: changeId });
    this.contents.set(uri.toString(), content);
    this.emitter.fire(uri);
    return uri;
  }

  release(uri: vscode.Uri): void {
    this.contents.delete(uri.toString());
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  dispose(): void {
    this.contents.clear();
    this.emitter.dispose();
  }
}
