import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, type AutomationRule } from '@magicode/contracts';
import { COMMIT_URL_UNKNOWN, commitUrl, commitUrlFromRemote, evaluateRules, needsMetrics, renderTemplate, seedRules, triggerRefFor } from '../rules.engine';
import { parseRuleUpsert } from '../task-sync.service';

const rule = (o: Partial<AutomationRule> & Pick<AutomationRule, 'trigger' | 'action'>): AutomationRule => ({
  rule_id: 'rule_aaaaaaaaaaaa',
  integration_id: 'int_aaaaaaaaaaaaaaaa',
  name: 'r',
  enabled: true,
  when: {},
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  ...o,
});

const deployRule = rule({
  rule_id: 'rule_deploy00000',
  trigger: 'deployment.success',
  when: { environment: 'production' },
  action: { kind: 'transition', to_status: 'Hecho', comment: 'Desplegado {{sha}} en {{environment}}. Tokens MagiHub: {{tokens}} · líneas efectivas: {{effective_lines}}.' },
});

const ctx = {
  task_key: 'MAG-123',
  trigger_ref: triggerRefFor('MAG-123', 'deploy:acme/shop:987'),
  status_category: 'in_progress' as const,
  environment: 'Production',
  vars: { sha: '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432', environment: 'production', tokens: 1500, effective_lines: 27.5 },
};

describe('renderTemplate', () => {
  it('sha corto (12), números legibles y placeholders desconocidos vacíos', () => {
    expect(renderTemplate('{{task_key}} {{ sha }} {{tokens}} {{effective_lines}} [{{nope}}]', { task_key: 'MAG-1', sha: 'abcdef0123456789', tokens: 1234567, effective_lines: 3.14159 })).toBe(
      'MAG-1 abcdef012345 1,234,567 3.1 []',
    );
  });
});

describe('evaluateRules', () => {
  it('planifica la acción renderizada con idempotency_key = rule_id:trigger_ref', () => {
    const { planned, skipped } = evaluateRules('deployment.success', { ...ctx, rules: [deployRule] });
    expect(skipped).toEqual([]);
    expect(planned).toEqual([
      {
        rule_id: 'rule_deploy00000',
        integration_id: 'int_aaaaaaaaaaaaaaaa',
        idempotency_key: 'rule_deploy00000:MAG-123|deploy:acme/shop:987',
        trigger_ref: 'MAG-123|deploy:acme/shop:987',
        action: { kind: 'transition', to_status: 'Hecho', comment: 'Desplegado 9f8e7d6c5b4a en production. Tokens MagiHub: 1,500 · líneas efectivas: 27.5.' },
      },
    ]);
  });

  it('el mismo hecho produce la misma clave (dedupe) y otro hecho una distinta', () => {
    const a = evaluateRules('deployment.success', { ...ctx, rules: [deployRule] }).planned[0]!.idempotency_key;
    const b = evaluateRules('deployment.success', { ...ctx, rules: [deployRule] }).planned[0]!.idempotency_key;
    const c = evaluateRules('deployment.success', { ...ctx, trigger_ref: triggerRefFor('MAG-123', 'deploy:acme/shop:988'), rules: [deployRule] }).planned[0]!.idempotency_key;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('filtra por trigger, enabled y when (environment / target_branch / from_status_category)', () => {
    const rules = [
      deployRule,
      rule({ rule_id: 'rule_off', enabled: false, trigger: 'deployment.success', action: { kind: 'comment', body_markdown: 'x' } }),
      rule({ rule_id: 'rule_pr', trigger: 'pr.merged', action: { kind: 'comment', body_markdown: 'x' } }),
    ];
    expect(evaluateRules('deployment.success', { ...ctx, environment: 'staging', rules }).skipped).toEqual([{ rule_id: 'rule_deploy00000', reason: 'environment ≠ production' }]);
    expect(evaluateRules('deployment.success', { ...ctx, rules }).planned.map((p) => p.rule_id)).toEqual(['rule_deploy00000']);

    const prRule = rule({ rule_id: 'rule_main', trigger: 'pr.merged', when: { target_branch: 'main', from_status_category: 'in_progress' }, action: { kind: 'comment', body_markdown: 'merged' } });
    expect(evaluateRules('pr.merged', { ...ctx, target_branch: 'develop', rules: [prRule] }).planned).toEqual([]);
    expect(evaluateRules('pr.merged', { ...ctx, target_branch: 'main', status_category: 'done', rules: [prRule] }).planned).toEqual([]);
    expect(evaluateRules('pr.merged', { ...ctx, target_branch: 'main', rules: [prRule] }).planned).toHaveLength(1);
  });

  it('{{commit_url}} sin remoto conocido → se planifica como skipped "commit_url desconocido" (no enlace roto)', () => {
    const link = rule({ rule_id: 'rule_link', trigger: 'commit.linked', action: { kind: 'remote_link', url: '{{commit_url}}', title: 'Commit {{sha}}', relation: 'commit' } });
    const res = evaluateRules('commit.linked', { ...ctx, vars: { sha: 'abc' }, rules: [link] });
    expect(res.planned).toEqual([
      expect.objectContaining({
        rule_id: 'rule_link',
        skip_reason: COMMIT_URL_UNKNOWN,
        action: { kind: 'remote_link', url: '{{commit_url}}', title: 'Commit abc', relation: 'commit' },
      }),
    ]);
    const ok = evaluateRules('commit.linked', { ...ctx, vars: { sha: 'abc', commit_url: commitUrl('github', 'acme/shop', 'abc1234') }, rules: [link] });
    expect(ok.planned[0]).toEqual(
      expect.objectContaining({ action: { kind: 'remote_link', url: 'https://github.com/acme/shop/commit/abc1234', title: 'Commit abc', relation: 'commit' } }),
    );
    expect(ok.planned[0]!.skip_reason).toBeUndefined();
  });

  it('otra plantilla de URL que no queda absoluta → regla omitida (no se encola)', () => {
    const link = rule({ rule_id: 'rule_dash', trigger: 'pr.merged', action: { kind: 'remote_link', url: '{{dashboard_url}}', title: 'Dashboard', relation: 'dashboard' } });
    const res = evaluateRules('pr.merged', { ...ctx, vars: {}, rules: [link] });
    expect(res.planned).toEqual([]);
    expect(res.skipped[0]!.reason).toMatch(/URL inválida/);
  });

  it('needsMetrics detecta {{tokens}}/{{effective_lines}}/{{criticality}}', () => {
    expect(needsMetrics([deployRule])).toBe(true);
    expect(needsMetrics([rule({ trigger: 'pr.opened', action: { kind: 'comment', body_markdown: 'PR {{pr_url}}' } })])).toBe(false);
  });
});

describe('seedRules / parseRuleUpsert / commitUrl', () => {
  it('seedRules = copia de DEFAULT_RULES (remote_link con {{commit_url}})', () => {
    const seeded = seedRules();
    expect(seeded).toEqual(DEFAULT_RULES);
    expect(seeded).not.toBe(DEFAULT_RULES);
    expect(seeded[0]!.action).toMatchObject({ kind: 'remote_link', url: '{{commit_url}}' });
    for (const r of seeded) expect(() => parseRuleUpsert(r)).not.toThrow();
  });

  it('commitUrlFromRemote (remote_url del Commit)', () => {
    const sha = '0d1a26e67d8f5eaf1f6ba5c57fc3c7d91ac0fd1c';
    expect(commitUrlFromRemote('https://github.com/acme/shop.git', sha)).toBe(`https://github.com/acme/shop/commit/${sha}`);
    expect(commitUrlFromRemote('git@github.com:acme/shop.git', sha)).toBe(`https://github.com/acme/shop/commit/${sha}`);
    expect(commitUrlFromRemote('https://ana@bitbucket.org/acme/payments.git', sha)).toBe(`https://bitbucket.org/acme/payments/commits/${sha}`);
    expect(commitUrlFromRemote('ssh://git@gitlab.com:22/g/sub/p.git', sha)).toBe(`https://gitlab.com/g/sub/p/-/commit/${sha}`);
    expect(commitUrlFromRemote('https://git.internal.example.com/acme/shop.git', sha)).toBe('');
    expect(commitUrlFromRemote(undefined, sha)).toBe('');
  });

  it('parseRuleUpsert usa el contrato (URL absoluta o plantilla {{…}})', () => {
    expect(() => parseRuleUpsert({ name: 'x', enabled: true, trigger: 'pr.merged', when: {}, action: { kind: 'remote_link', url: 'nota-url', title: 't', relation: 'commit' } })).toThrow();
    expect(parseRuleUpsert({ name: 'x', enabled: true, trigger: 'pr.merged', action: { kind: 'remote_link', url: '{{commit_url}}', title: 't', relation: 'commit' } }).action).toMatchObject({ url: '{{commit_url}}' });
    expect(() => parseRuleUpsert({ name: 'x', enabled: true, trigger: 'nope', action: { kind: 'comment', body_markdown: 'x' } })).toThrow();
    expect(parseRuleUpsert({ name: 'x', enabled: true, trigger: 'pr.merged', action: { kind: 'comment', body_markdown: 'PR {{pr_url}}' } }).when).toEqual({});
  });

  it('commitUrl por proveedor', () => {
    expect(commitUrl('bitbucket', 'acme/payments', 'c0ffee')).toBe('https://bitbucket.org/acme/payments/commits/c0ffee');
    expect(commitUrl('gitlab', 'g/sub/p', 'abc')).toBe('https://gitlab.com/g/sub/p/-/commit/abc');
    expect(commitUrl('jira', 'acme/shop', 'abc')).toBe('');
    expect(commitUrl('github', 'not a repo', 'abc')).toBe('');
  });
});
