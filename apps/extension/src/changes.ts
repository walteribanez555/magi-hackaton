/**
 * Propuesta → aceptación: cálculo local de líneas, hashes y aristas con @magicode/metrics.
 * El resultado contiene solo conteos, rutas y hashes; el contenido se queda en el IDE.
 * Puro: no importa 'vscode'.
 */
import { analyzeChange, hashLine, normalizeLine, patchHash } from '@magicode/metrics';
import { countNonEmpty, lineChanges } from './diff';
import type { StoredChange } from './session';
import type { PayloadOf } from './telemetry';

export interface Proposal {
  change_id: string;
  ai_request_id: string;
  /** ruta relativa al repo */
  path: string;
  language?: string;
  originalText: string;
  proposedText: string;
  addedLines: string[];
  deletedLines: string[];
  /** ai_request_id de la petición que esta regenera */
  regenerates?: string;
}

export function makeProposal(args: Omit<Proposal, 'addedLines' | 'deletedLines'>): Proposal {
  const { addedLines, deletedLines } = lineChanges(args.originalText, args.proposedText);
  return { ...args, addedLines, deletedLines };
}

export function lineHashesOf(salt: string, lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    const n = normalizeLine(l);
    if (n.length > 0) out.push(hashLine(salt, n));
  }
  return out;
}

export function proposedPayload(salt: string, p: Proposal): PayloadOf<'code.proposed'> {
  return {
    change_id: p.change_id,
    ai_request_id: p.ai_request_id,
    files: [
      {
        path: p.path,
        ...(p.language ? { language: p.language.slice(0, 40) } : {}),
        added: countNonEmpty(p.addedLines),
        deleted: countNonEmpty(p.deletedLines),
      },
    ],
    patch_hash: patchHash([{ path: p.path, lineHashes: lineHashesOf(salt, p.addedLines) }]),
  };
}

export interface AcceptInput {
  salt: string;
  proposal: Proposal;
  /** contenido final aplicado (puede diferir de la propuesta si el usuario la editó) */
  finalText: string;
  /** texto del archivo justo antes de aplicar */
  baseText: string;
  edited: boolean;
  existingRepoHashes: ReadonlySet<string>;
  sessionAcceptedHashes: ReadonlySet<string>;
  weights?: Parameters<typeof analyzeChange>[0]['weights'];
  now?: Date;
}

export interface AcceptResult {
  payload: PayloadOf<'code.accepted'>;
  stored: StoredChange;
}

export function analyzeAcceptance(input: AcceptInput): AcceptResult {
  const { proposal: p } = input;
  const { addedLines, deletedLines } = lineChanges(input.baseText, input.finalText);
  const language = p.language?.slice(0, 40);
  const r = analyzeChange({
    salt: input.salt,
    files: [
      {
        path: p.path,
        ...(language ? { language } : {}),
        addedLines,
        deletedLines,
        // con "Editar y aceptar" se compara contra lo que propuso la IA → accepted_as_is / edited_before_accept
        ...(input.edited ? { proposedAddedLines: p.addedLines } : {}),
      },
    ],
    existingRepoHashes: input.existingRepoHashes,
    sessionAcceptedHashes: input.sessionAcceptedHashes,
    ...(input.weights ? { weights: input.weights } : {}),
  });
  const files = r.files.length > 0 ? r.files : [{ path: p.path, ...(language ? { language } : {}), added: 0, deleted: 0 }];
  return {
    payload: {
      change_id: p.change_id,
      ai_request_id: p.ai_request_id,
      files,
      patch_hash: r.patchHash,
      accepted_added_lines: r.acceptedAddedLines,
      accepted_deleted_lines: r.acceptedDeletedLines,
      dimensions: r.dimensions,
    },
    stored: {
      change_id: p.change_id,
      ai_request_id: p.ai_request_id,
      paths: files.map((f) => f.path),
      lineHashes: r.lineHashes,
      effectiveWeights: r.effectiveWeights,
      accepted_at: (input.now ?? new Date()).toISOString(),
      accepted_lines: r.acceptedAddedLines,
      effective_lines: r.dimensions.effective_lines,
    },
  };
}
