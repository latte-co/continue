import type { Effort } from "./protocol";
export const modelSelectionScope = (
  host: string,
  project: string | undefined,
  agent: string,
  model: string | null,
  effort: Effort | null,
  projectPath?: string,
) =>
  JSON.stringify(
    projectPath === undefined
      ? [host, project, agent, model, effort]
      : [host, project, projectPath, agent, model, effort],
  );
