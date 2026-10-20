/**
 * Regla ÚNICA de "desplegado" (etapa `deployed` del embudo y TaskListItem.deployed).
 * Un commit cuenta como desplegado si existe un Deployment `success` del mismo repositorio cuyo SHA:
 *   1. es el SHA del commit, o
 *   2. es el merge_sha / head_sha de un PullRequest cuya rama origen contiene el commit
 *      (Commit.branch o Commit.remote_branch = PR.source_branch) — desplegar el merge commit cuenta.
 * SHAs por prefijo (Bitbucket manda SHAs cortos de 12). Sin ancestros reales ⇒ el llamador marca
 * la etapa como estimated.
 */

export interface DeployCommitRef {
  repository: string;
  sha: string;
  branch?: string | null;
  remote_branch?: string | null;
}

export interface DeployPrRef {
  repository: string;
  source_branch?: string | null;
  merge_sha?: string | null;
  head_sha?: string | null;
}

export interface DeployEvidenceRef {
  repository: string;
  sha: string;
  state?: string;
  deployment_id?: string;
}

/** Comparación de SHAs por prefijo (≥ 7 caracteres). */
export const shaPrefixEq = (a: string | null | undefined, b: string | null | undefined): boolean => {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
};

export const sameRepository = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/** SHAs que, desplegados, implican el despliegue del commit (el suyo + merge/head de sus PRs). */
export function deployableShas(commit: DeployCommitRef, prs: DeployPrRef[]): string[] {
  const branches = [commit.branch, commit.remote_branch].filter((b): b is string => !!b);
  const out = [commit.sha];
  for (const pr of prs) {
    if (!sameRepository(pr.repository, commit.repository) || !pr.source_branch || !branches.includes(pr.source_branch)) continue;
    if (pr.merge_sha) out.push(pr.merge_sha);
    if (pr.head_sha) out.push(pr.head_sha);
  }
  return out;
}

/** Deployments success que prueban el despliegue del commit (vacío ⇒ no desplegado). */
export function deploymentsOfCommit(commit: DeployCommitRef, deployments: DeployEvidenceRef[], prs: DeployPrRef[]): DeployEvidenceRef[] {
  const shas = deployableShas(commit, prs);
  return deployments.filter(
    (d) => d.state === 'success' && sameRepository(d.repository, commit.repository) && shas.some((s) => shaPrefixEq(s, d.sha)),
  );
}

export const isCommitDeployed = (commit: DeployCommitRef, deployments: DeployEvidenceRef[], prs: DeployPrRef[]): boolean =>
  deploymentsOfCommit(commit, deployments, prs).length > 0;
