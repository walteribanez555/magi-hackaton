import * as vscode from 'vscode';

export interface MagiCodeConfig {
  magihubBaseUrl: string;
  telemetryUrl: string;
  dashboardUrl: string;
  projectId: string;
  repository: string;
  taskKey: string;
  developerEmail: string;
  addSessionTrailer: boolean;
  requestTimeoutSeconds: number;
}

export function readConfig(): MagiCodeConfig {
  const c = vscode.workspace.getConfiguration('magicode');
  return {
    magihubBaseUrl: (c.get<string>('magihubBaseUrl') || 'http://localhost:4010').trim(),
    telemetryUrl: (c.get<string>('telemetryUrl') || 'http://localhost:3000/api/v1').trim(),
    dashboardUrl: (c.get<string>('dashboardUrl') || 'http://localhost:4200').trim(),
    projectId: (c.get<string>('projectId') || '').trim(),
    repository: (c.get<string>('repository') || '').trim(),
    taskKey: (c.get<string>('taskKey') || '').trim().toUpperCase(),
    developerEmail: (c.get<string>('developerEmail') || '').trim().toLowerCase(),
    addSessionTrailer: c.get<boolean>('addSessionTrailer') ?? true,
    requestTimeoutSeconds: Math.max(10, c.get<number>('requestTimeoutSeconds') ?? 120),
  };
}
