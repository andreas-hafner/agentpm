import { Command } from 'commander';

import {
  AgentPmService,
  type InstallOptions,
  type ProviderInstalledSkillRecord,
  type ProviderSkillSearchResult,
  type UpdateOptions,
} from '@agentpm/core';
import { createPromptApi, promptToConfirm } from '@agentpm/ui';

type AgentId = 'codex' | 'claude' | 'generic';

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

const KNOWN_AGENTS: AgentId[] = ['codex', 'claude', 'generic'];

function parseAgents(value: string | undefined): AgentId[] | undefined {
  if (!value) {
    return undefined;
  }
  const requested = value
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  const invalid = requested.filter(
    (part) => !KNOWN_AGENTS.includes(part as AgentId),
  );
  if (invalid.length > 0) {
    throw new Error(
      `Unknown agent(s): ${invalid.join(', ')}. Use one of: ${KNOWN_AGENTS.join(', ')}.`,
    );
  }
  return requested as AgentId[];
}

const BRAND_LINES = [
  '    _                    _   ____  __  __',
  '   / \\   __ _  ___ _ __ | |_|  _ \\|  \\/  |',
  "  / _ \\ / _` |/ _ \\ '_ \\| __| |_) | |\\/| |",
  ' / ___ \\ (_| |  __/ | | | |_|  __/| |  | |',
  '/_/   \\_\\__, |\\___|_| |_|\\__|_|   |_|  |_|',
  '        |___/',
];

function colorize(text: string, code: number): string {
  if (!process.stdout.isTTY || process.env.NO_COLOR) {
    return text;
  }
  return `\u001B[${code}m${text}\u001B[0m`;
}

// Premium palette styles (ANSI codes)
const style = {
  cyan: (t: string) => colorize(t, 36),
  green: (t: string) => colorize(t, 32),
  yellow: (t: string) => colorize(t, 33),
  red: (t: string) => colorize(t, 31),
  gray: (t: string) => colorize(t, 90),
  bold: (t: string) => colorize(t, 1),
  underline: (t: string) => colorize(t, 4),
  magenta: (t: string) => colorize(t, 35),
};

const symbols = {
  success: colorize('✔', 32),
  info: colorize('ℹ', 36),
  warning: colorize('⚠', 33),
  error: colorize('✖', 31),
  arrow: colorize('➤', 36),
  star: colorize('★', 33),
  bullet: colorize('▪', 90),
};

function brandBlock(): string {
  const logo = BRAND_LINES.map((line) => style.cyan(line)).join('\n');
  return `\n${logo}\n\n  ${style.bold(style.cyan('AgentPM'))} ${style.gray('—')} ${style.bold('Project-aware AI skill orchestration')}\n`;
}

function section(title: string): void {
  console.log(`\n${style.bold(style.cyan(title))}`);
}

function resolveScope(flags: {
  global?: boolean;
  project?: boolean;
  workspace?: boolean;
}): InstallOptions['scope'] {
  if (flags.global) {
    return 'global';
  }
  if (flags.project) {
    return 'project';
  }
  if (flags.workspace) {
    return 'workspace';
  }
  return undefined;
}

function resolveTarget(value?: string): InstallOptions['target'] {
  if (!value) {
    return undefined;
  }
  if (value === 'codex' || value === 'claude' || value === 'generic') {
    return value;
  }
  throw new Error('--target must be one of: codex, claude, generic');
}

function printInspection(
  report: Awaited<ReturnType<AgentPmService['inspect']>>,
): void {
  section('Source');
  console.log(
    `  ${symbols.bullet} locator      : ${style.bold(report.locator)}`,
  );
  console.log(
    `  ${symbols.bullet} installable  : ${report.installable ? style.green('yes') : style.red('no')}`,
  );

  section('Trust');
  const trustColor = report.trust.trusted ? 32 : 33;
  console.log(
    `  ${symbols.bullet} status       : ${colorize(report.trust.trusted ? 'trusted' : 'untrusted', trustColor)} (${style.bold(report.trust.score.toString())}/100)`,
  );
  for (const reason of report.trust.reasons) {
    console.log(`    ${style.gray('-')} ${reason}`);
  }

  section('Detected');
  if (report.groups.length === 0) {
    console.log(`  ${symbols.warning} no components detected`);
  }
  for (const group of report.groups) {
    console.log(
      `  ${symbols.success} ${style.green(group.label)} (${group.entries.length} entries)`,
    );
  }

  section('Compatibility');
  for (const compatibility of report.compatibleAdapters) {
    const statusSymbol = compatibility.compatible
      ? symbols.success
      : symbols.warning;
    console.log(
      `  ${statusSymbol} ${style.bold(compatibility.adapter)} (compatibility score: ${style.bold(compatibility.score.toString())}/100)`,
    );
    for (const reason of compatibility.reasons) {
      console.log(`    ${style.gray('-')} ${reason}`);
    }
  }

  section('Entries');
  for (const group of report.groups) {
    for (const entry of group.entries) {
      console.log(
        `  ${symbols.arrow} ${style.bold(entry.name)} ${style.gray('→')} ${style.underline(entry.relativePath)}`,
      );
    }
  }

  if (report.scripts.length > 0) {
    section('Risks');
    for (const script of report.scripts) {
      console.log(
        `  ${symbols.warning} custom install script found: ${style.yellow(script.relativePath)}`,
      );
    }
  }

  if (report.warnings.length > 0) {
    section('Warnings');
    for (const warning of report.warnings) {
      console.log(`  ${symbols.warning} ${style.yellow(warning)}`);
    }
  }
  console.log('');
}

function printRuntimeContext(
  graph: Awaited<ReturnType<AgentPmService['resolveRuntimeContext']>>,
): void {
  section('Runtime');
  console.log(`  ${symbols.bullet} Root Workspace : ${style.bold(graph.cwd)}`);
  if (graph.configPath) {
    console.log(
      `  ${symbols.bullet} Config File    : ${style.bold(graph.configPath)}`,
    );
  }

  for (const layer of ['global', 'project', 'temporary'] as const) {
    const entries = graph.layers[layer];
    section(`${layer[0]!.toUpperCase()}${layer.slice(1)}`);
    if (entries.length === 0) {
      console.log(`  ${style.gray('-')} no entries active in this layer`);
      continue;
    }
    for (const entry of entries) {
      const source = entry.sourceLocator
        ? ` [source: ${entry.sourceLocator}]`
        : '';
      const pathSummary = entry.sourceRelativePath
        ? ` ${style.gray('→')} ${entry.sourceRelativePath}`
        : '';
      console.log(
        `  ${symbols.success} ${style.bold(entry.name)}${pathSummary}${style.gray(source)}`,
      );
      for (const warning of entry.warnings) {
        console.log(`    ${symbols.warning} ${style.yellow(warning)}`);
      }
    }
  }

  if (graph.warnings.length > 0) {
    section('Warnings');
    for (const warning of graph.warnings) {
      console.log(`  ${symbols.warning} ${style.yellow(warning)}`);
    }
  }
  console.log('');
}

function printUpdates(
  previews: Awaited<ReturnType<AgentPmService['previewUpdates']>>,
): void {
  if (previews.length === 0) {
    console.log(`\n${symbols.info} No installed skills or assets detected.`);
    return;
  }

  section('Skill Update Preview');
  for (const preview of previews) {
    const revisionSummary =
      preview.currentRevision && preview.candidateRevision
        ? `${style.bold(preview.currentRevision.slice(0, 7))} ${style.gray('→')} ${style.bold(preview.candidateRevision.slice(0, 7))}`
        : 'n/a';
    const statusText = preview.changed
      ? style.yellow('update available')
      : style.green('up to date');
    const statusSymbol = preview.changed ? symbols.warning : symbols.success;

    console.log(
      `  ${statusSymbol} ${style.bold(preview.install.name)}: ${statusText} (${revisionSummary})`,
    );
    if (preview.changed) {
      console.log(
        `    ${symbols.bullet} Risk Profile: ${style.bold(preview.risk)}`,
      );
      for (const diff of preview.diff) {
        console.log(
          `      ${style.gray('-')} ${style.cyan(diff.kind.padEnd(8))} : ${diff.path}`,
        );
      }
      for (const warning of preview.warnings) {
        console.log(`      ${symbols.warning} ${style.yellow(warning)}`);
      }
    }
  }
  console.log('');
}

function printDoctor(
  issues: Awaited<ReturnType<AgentPmService['doctor']>>,
): void {
  if (issues.length === 0) {
    console.log(
      `\n${symbols.success} Doctor found no issues. Your environment is perfectly healthy!`,
    );
    return;
  }

  section('Doctor Diagnosis');
  for (const issue of issues) {
    const isError = issue.severity === 'error';
    const severitySymbol = isError ? symbols.error : symbols.warning;
    const severityText = isError
      ? style.red(issue.severity.toUpperCase())
      : style.yellow(issue.severity.toUpperCase());

    console.log(
      `  ${severitySymbol} [${severityText}] ${style.bold(issue.code)}: ${issue.message}`,
    );
    if (issue.path) {
      console.log(`    ${style.gray('Path   :')} ${issue.path}`);
    }
    if (issue.remedy) {
      console.log(`    ${style.gray('Remedy :')} ${style.green(issue.remedy)}`);
    }
  }
  console.log('');
}

function printRefreshResults(
  results: Awaited<ReturnType<AgentPmService['refreshSources']>>,
): void {
  if (results.length === 0) {
    console.log(`\n${symbols.info} No sources configured.\n`);
    return;
  }

  section('Source Refresh');
  for (const result of results) {
    console.log(
      `  ${symbols.success} ${style.bold(result.source.displayName)} ${style.gray(`(${result.indexedEntries} entries indexed)`)}`,
    );
  }
  console.log('');
}

function printCacheCleanResult(
  result: Awaited<ReturnType<AgentPmService['cleanCache']>>,
): void {
  if (result.removedEntries === 0) {
    console.log(
      `\n${symbols.success} Cache is already clean. Active install caches and the searchable source index were preserved.\n`,
    );
    return;
  }

  section(result.dryRun ? 'Cache Clean Preview' : 'Cache Clean');
  console.log(
    `  ${symbols.success} ${result.dryRun ? 'Would remove' : 'Removed'} ${style.bold(result.removedEntries.toString())} unused Git checkout cache item(s).`,
  );
  console.log(
    `  ${symbols.bullet} Preserved active install caches and the searchable source index.`,
  );
  for (const removedPath of result.removedPaths) {
    console.log(`    ${style.gray('-')} ${removedPath}`);
  }
  console.log('');
}

function printDoctorFixes(
  actions: Awaited<ReturnType<AgentPmService['planDoctorFixes']>>,
  issues: Awaited<ReturnType<AgentPmService['doctor']>> = [],
): void {
  if (actions.length === 0) {
    console.log(`\n${symbols.info} No safe automatic fixes are available.\n`);
    const unsupported = issues.filter((issue) => issue.severity === 'error');
    for (const issue of unsupported) {
      console.log(
        `  ${symbols.bullet} ${issue.code}: no automated fix is available; ${issue.remedy}`,
      );
    }
    if (unsupported.length > 0) {
      console.log('');
    }
    return;
  }

  section('Planned Fixes');
  for (const action of actions) {
    console.log(`  ${symbols.warning} ${style.yellow(action.description)}`);
  }
  const fixedInstallIds = new Set(
    actions.flatMap((action) =>
      action.code === 'remove-install-record' ? [action.installId] : [],
    ),
  );
  const fixedSourceIds = new Set(
    actions.flatMap((action) =>
      action.code === 'remove-source' ? [action.sourceId] : [],
    ),
  );
  const unsupported = issues.filter((issue) => {
    if (issue.severity !== 'error') {
      return false;
    }
    if (issue.installId && fixedInstallIds.has(issue.installId)) {
      return false;
    }
    if (
      issue.sourceId &&
      fixedSourceIds.has(issue.sourceId) &&
      (issue.code === 'source-missing' || issue.code === 'source-unavailable')
    ) {
      return false;
    }
    return true;
  });
  if (unsupported.length > 0) {
    section('Manual Review');
    for (const issue of unsupported) {
      console.log(
        `  ${symbols.bullet} ${issue.code}: no automated fix is available; ${issue.remedy}`,
      );
    }
  }
  console.log('');
}

function printSourceEntries(
  result: Awaited<ReturnType<AgentPmService['listSourceEntries']>>,
): void {
  section('Source Skills');
  console.log(
    `  ${symbols.bullet} source       : ${style.bold(result.sourceDisplayName)}`,
  );
  console.log(
    `  ${symbols.bullet} locator      : ${result.sourceLocator}`,
  );
  console.log(
    `  ${symbols.bullet} persisted    : ${result.persisted ? style.green('yes') : style.yellow('no')}`,
  );

  if (result.entries.length === 0) {
    console.log(`\n  ${symbols.info} No installable skills were found.\n`);
    return;
  }

  console.log('');
  for (const entry of result.entries) {
    console.log(
      `  ${symbols.success} ${style.bold(entry.name)} ${style.gray('·')} ${(entry.adapter ?? 'unknown').padEnd(7)} ${entry.path ?? entry.repo}`,
    );
  }
  console.log('');
}

function printProviderEntries(results: ProviderSkillSearchResult[]): void {
  section('Public Skills');
  if (results.length === 0) {
    console.log(`  ${symbols.info} No public skills found.\n`);
    return;
  }

  for (const entry of results) {
    const installs = entry.installs
      ? `${style.cyan(entry.installs)} ${style.gray('installs')}`
      : style.gray('installs unknown');
    console.log(
      `  ${symbols.success} ${style.bold(entry.skillSelector)} ${style.gray('·')} ${installs}`,
    );
    console.log(
      `    ${style.gray('repo')} ${style.cyan(entry.source)} ${style.gray('→')} ${entry.installLocator}`,
    );
    if (entry.url) {
      console.log(`    ${style.gray('url ')} ${entry.url}`);
    }
  }
  console.log(
    `\n  ${symbols.info} Install with ${style.bold('agentpm skills install <owner/repo@skill>')}` +
      ` ${style.gray('or')} ${style.bold('agentpm skills install <query>')}\n`,
  );
}

function printInstalledProviderSkills(results: ProviderInstalledSkillRecord[]): void {
  section('Installed Public Skills');
  if (results.length === 0) {
    console.log(`  ${symbols.info} No skills.sh installs found.\n`);
    return;
  }

  for (const entry of results) {
    console.log(
      `  ${symbols.success} ${style.bold(entry.skillSelector ?? entry.name)} ${style.gray('·')} ${entry.scope}`,
    );
    if (entry.source) {
      console.log(`    ${style.gray('repo')} ${style.cyan(entry.source)}`);
    }
    console.log(`    ${style.gray('path')} ${entry.targetPath}`);
  }
  console.log('');
}

async function withService<T>(
  callback: (service: AgentPmService) => Promise<T>,
  options: {
    statusMessages?: boolean;
  } = {},
): Promise<T> {
  const service = new AgentPmService({
    prompts: createPromptApi(),
    onStatus:
      options.statusMessages === false
        ? undefined
        : (message) => {
            console.log(`${symbols.info} ${message}`);
          },
  });
  try {
    return await callback(service);
  } finally {
    service.close();
  }
}

const program = new Command();
const rawCliArgs = process.argv.slice(2);
program
  .name('agentpm')
  .description('Git-native skill and agent asset manager')
  .version('0.7.0')
  .exitOverride()
  .showHelpAfterError(false)
  .addHelpText('beforeAll', brandBlock())
  .addHelpText(
    'afterAll',
    `
Examples:
  agentpm source add git@github.com:company/skills.git
  agentpm source skills github:company/private-skills
  agentpm skills search typescript
  agentpm skills install wshobson/agents@typescript-advanced-types --project
  agentpm search pdf --refresh
  agentpm install --from github:company/private-skills
  agentpm sync
  agentpm update --refresh
  agentpm doctor --fix
  agentpm cache clean --dry-run
  agentpm target add production git@github.com:company/skills.git --default
  agentpm push --all
`,
  );

const source = program
  .command('source')
  .alias('sources')
  .description('Manage sources');

const skillsCmd = program
  .command('skills')
  .description('Search and import public skills through the skills.sh CLI bridge');

skillsCmd
  .command('search')
  .argument('<query>', 'Search query for skills.sh')
  .option('--json', 'Print machine-readable JSON')
  .action(async (query: string, flags: { json?: boolean }) => {
    const results = await withService(
      (service) => service.searchProviderSkills(query),
    );
    if (flags.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }
    printProviderEntries(results);
  });

skillsCmd
  .command('install')
  .argument(
    '<source-or-selector>',
    'Provider selector like owner/repo@skill, or a repo/url plus --skill',
  )
  .option('--skill <name>', 'Skill name when passing a repo or URL', collect, [])
  .option('--global', 'Install to the global native target')
  .option('--project', 'Install to the current project')
  .option('--workspace', 'Install to a workspace root')
  .option('--workspace-root <path>', 'Explicit workspace root')
  .option(
    '--target <target>',
    'Install only entries for codex, claude, or generic',
  )
  .option('--yes', 'Accept safe install prompts automatically')
  .action(
    async (
      sourceOrSelector: string,
      flags: InstallOptions & {
        global?: boolean;
        project?: boolean;
        workspace?: boolean;
        workspaceRoot?: string;
        skill?: string[];
        target?: string;
        yes?: boolean;
      },
    ) => {
      const installs = await withService(
        (service) =>
          service.installProviderSkill(sourceOrSelector, {
            scope: resolveScope(flags),
            workspaceRoot: flags.workspaceRoot,
            skills: flags.skill,
            target: resolveTarget(flags.target),
            yes: flags.yes,
          }),
      );
      for (const install of installs) {
        console.log(
          `\n${symbols.success} ${style.bold('Installed')} ${style.green(install.name)} ${style.gray('→')} ${style.underline(install.targetPath)}`,
        );
      }
      console.log('');
    },
  );

skillsCmd
  .command('list')
  .option('--json', 'Print machine-readable JSON')
  .action(async (flags: { json?: boolean }) => {
    const installs = await withService(
      (service) => Promise.resolve(service.listProviderSkillInstalls()),
    );
    if (flags.json) {
      console.log(JSON.stringify(installs, null, 2));
      return;
    }
    printInstalledProviderSkills(installs);
  });

skillsCmd
  .command('remove')
  .argument('<name-or-selector>', 'Installed skill name or owner/repo@skill selector')
  .option('--purge', 'Also purge unused cache data')
  .action(async (identifier: string, flags: { purge?: boolean }) => {
    const removed = await withService(
      (service) => service.removeProviderSkill(identifier, { purge: Boolean(flags.purge) }),
    );
    const selector =
      typeof removed.metadata.providerSkillSelector === 'string'
        ? removed.metadata.providerSkillSelector
        : removed.name;
    console.log(
      `\n${symbols.success} ${style.bold('Removed')} ${style.green(selector)}\n`,
    );
  });

skillsCmd
  .command('update')
  .argument('[skills...]', 'Optional installed skill names or owner/repo@skill selectors')
  .option('--yes', 'Confirm risky remaps automatically')
  .action(
    async (identifiers: string[], flags: { yes?: boolean }) => {
      await withService(async (service) => {
        const previews = await service.updateProviderSkills(identifiers, {
          apply: false,
        });
        if (previews.length === 0) {
          console.log(`\n${symbols.info} No skills.sh installs found.\n`);
          return;
        }
        printUpdates(previews);

        const changed = previews.filter((preview) => preview.changed);
        if (changed.length === 0) {
          return;
        }

        if (!flags.yes) {
          const confirmed = await promptToConfirm(
            'Do you want to update these skills.sh installs? [y/N]',
            changed.map((preview) => {
              const selector =
                typeof preview.install.metadata.providerSkillSelector === 'string'
                  ? preview.install.metadata.providerSkillSelector
                  : preview.install.name;
              return `${selector}: ${preview.currentRevision?.slice(0, 7) ?? 'n/a'} -> ${preview.candidateRevision?.slice(0, 7) ?? 'n/a'}`;
            }),
          );
          if (!confirmed) {
            console.log(`\n${symbols.info} Update skipped.\n`);
            return;
          }
        }

        const applied = await service.updateProviderSkills(identifiers, {
          apply: true,
          yes: Boolean(flags.yes),
        } satisfies UpdateOptions);
        printUpdates(applied);
        const updatedCount = applied.filter(
          (preview) =>
            preview.changed &&
            preview.nextLinkTarget &&
            !preview.warnings.includes('Skipped by user.'),
        ).length;
        console.log(
          `\n${symbols.success} ${style.bold('Update complete')} ${style.gray(`(${updatedCount} skills.sh item(s) updated)`)}\n`,
        );
      });
    },
  );

source
  .command('add')
  .argument('<locator>', 'Git URL, local folder, or registry index path')
  .action(async (locator: string) => {
    const result = await withService((service) => service.addSource(locator));
    console.log(
      `\n${symbols.success} ${style.bold('Added source')} ${style.cyan(result.source.displayName)} ${style.gray(`(${result.indexedEntries} entries indexed)`)}\n`,
    );
  });

source.command('list').action(async () => {
  const sources = await withService((service) =>
    Promise.resolve(service.listSources()),
  );
  if (sources.length === 0) {
    console.log('No sources configured.');
    return;
  }
  for (const item of sources) {
    console.log(`${item.id}  ${item.kind}  ${item.locator}`);
  }
});

source
  .command('skills')
  .alias('entries')
  .argument('[source]', 'Configured source id, locator, or a direct repo locator')
  .option('--refresh', 'Refresh the configured source before listing')
  .option('--target <target>', 'Filter entries for codex, claude, or generic')
  .option('--json', 'Print machine-readable JSON')
  .action(
    async (
      sourceToken: string | undefined,
      flags: { refresh?: boolean; target?: string; json?: boolean },
    ) => {
      const result = await withService(
        (service) =>
          service.listSourceEntries(sourceToken, {
            ...(flags.refresh ? { refresh: true } : {}),
            ...(flags.target
              ? { target: resolveTarget(flags.target) }
              : {}),
          }),
      );
      if (flags.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      printSourceEntries(result);
    },
  );

source
  .command('remove')
  .argument('<source>', 'Source id or locator')
  .action(async (sourceToken: string) => {
    await withService((service) => service.removeSource(sourceToken));
    console.log(
      `\n${symbols.success} ${style.bold('Removed source')} ${style.cyan(sourceToken)}\n`,
    );
  });

const targetCmd = program
  .command('target')
  .alias('targets')
  .description('Manage global push targets');

targetCmd
  .command('add')
  .argument('<id>', 'Target ID')
  .argument('<locator>', 'Target locator (Git URL or registry path)')
  .option('--default', 'Make this the default push target')
  .action(async (id: string, locator: string, flags: { default?: boolean }) => {
    await withService((service) => service.addTarget(id, locator, flags.default));
    console.log(
      `\n${symbols.success} ${style.bold('Added target')} ${style.cyan(id)} to global config${flags.default ? ' as default' : ''}\n`,
    );
  });

targetCmd
  .command('default')
  .argument('<id>', 'Target ID')
  .action(async (id: string) => {
    await withService((service) => service.setDefaultTarget(id));
    console.log(
      `\n${symbols.success} ${style.bold('Default target')} ${style.cyan(id)} saved to global config\n`,
    );
  });

targetCmd
  .command('remove')
  .argument('<id>', 'Target ID')
  .action(async (id: string) => {
    await withService((service) => service.removeTarget(id));
    console.log(
      `\n${symbols.success} ${style.bold('Removed target')} ${style.cyan(id)} from global config\n`,
    );
  });

targetCmd.command('list').action(async () => {
  const { loadGlobalConfig } = await import('@agentpm/config');
  const globalConfig = await loadGlobalConfig(process.cwd());
  const globalTargets = globalConfig.targets ?? [];

  if (globalTargets.length === 0) {
    console.log('No targets configured in global config.');
    return;
  }

  console.log('Global Targets (config.yaml):');
  for (const target of globalTargets) {
    const targetId = target.id ?? '(unnamed)';
    console.log(
      `${target.default ? '*' : ' '} ${targetId.padEnd(20)} ${target.kind?.padEnd(10) ?? ''} ${target.locator}`,
    );
  }
});

program
  .command('inspect')
  .argument('<target>', 'Source id, Git URL, or local path')
  .option(
    '--skill <name>',
    'Check whether a specific skill selector is present',
  )
  .option(
    '--target <target>',
    'Check a runtime target: codex, claude, or generic',
  )
  .action(
    async (target: string, flags: { skill?: string; target?: string }) => {
      const report = await withService((service) =>
        service.inspect(target, {
          skill: flags.skill,
          target: resolveTarget(flags.target),
        }),
      );
      printInspection(report);
    },
  );

program
  .command('search')
  .argument('<query>', 'Query text')
  .option('--refresh', 'Refresh configured source indexes before searching')
  .action(async (query: string, flags: { refresh?: boolean }) => {
    const { results, sourceCount } = await withService(async (service) => {
      if (flags.refresh) {
        printRefreshResults(await service.refreshSources());
      }
      return {
        results: service.search(query),
        sourceCount: service.listSources().length,
      };
    });
    if (results.length === 0) {
      console.log('No matches found.');
      if (sourceCount > 0 && !flags.refresh) {
        console.log(
          'Indexes may be stale; run `agentpm refresh` or `agentpm search --refresh`.',
        );
      }
      return;
    }
    for (const result of results) {
      console.log(`${result.kind}  ${result.name}  ${result.locator ?? ''}`);
    }
  });

program
  .command('refresh')
  .description('Refresh local indexes for configured sources')
  .argument(
    '[sources...]',
    'Optional source ids, locators, or names to refresh',
  )
  .action(async (sources: string[]) => {
    const results = await withService((service) =>
      service.refreshSources(sources),
    );
    printRefreshResults(results);
  });

program
  .command('install')
  .alias('add')
  .argument('[names...]', 'Skill names or source token for --all/--skill flows')
  .option('--from <source>', 'Install from a configured source or direct repo locator')
  .option('--add-source', 'Add a direct repo locator as a source before installing')
  .option('--global', 'Install to the global native target')
  .option('--project', 'Install to the current project')
  .option('--workspace', 'Install to a workspace root')
  .option('--workspace-root <path>', 'Explicit workspace root')
  .option('--all', 'Install all entries from a source')
  .option('--skill <name>', 'Select a specific skill name', collect, [])
  .option('--ref <ref>', 'Git branch, tag, or revision')
  .option(
    '--target <target>',
    'Install only entries for codex, claude, or generic',
  )
  .option('--yes', 'Accept safe install prompts automatically')
  .action(
    async (
      names: string[],
      flags: InstallOptions & {
        from?: string;
        addSource?: boolean;
        global?: boolean;
        project?: boolean;
        workspace?: boolean;
        workspaceRoot?: string;
        skill?: string[];
        ref?: string;
        target?: string;
        yes?: boolean;
      },
    ) => {
      const installs = await withService(
        (service) =>
          service.install(names, {
            scope: resolveScope(flags),
            workspaceRoot: flags.workspaceRoot,
            all: flags.all,
            skills: flags.skill,
            ref: flags.ref ?? null,
            target: resolveTarget(flags.target),
            from: flags.from,
            addSource: flags.addSource,
            yes: flags.yes,
          }),
      );
      for (const install of installs) {
        console.log(
          `\n${symbols.success} ${style.bold('Installed')} ${style.green(install.name)} ${style.gray('→')} ${style.underline(install.targetPath)}`,
        );
      }

    },
  );

program
  .command('update')
  .argument('[names...]', 'Optional installed names to update')
  .option('--refresh', 'Refresh source indexes before checking updates')
  .option('--yes', 'Confirm risky remaps automatically')
  .action(
    async (names: string[], flags: { yes?: boolean; refresh?: boolean }) => {
      await withService(async (service) => {
        if (flags.refresh) {
          printRefreshResults(await service.refreshSources());
        }

        const previews = await service.previewUpdates({ names });
        printUpdates(previews);

        const changed = previews.filter((preview) => preview.changed);
        if (changed.length === 0) {
          return;
        }

        if (!flags.yes) {
          const confirmed = await promptToConfirm(
            'Do you want to update these skills? [y/N]',
            changed.map(
              (preview) =>
                `${preview.install.name}: ${preview.currentRevision?.slice(0, 7) ?? 'n/a'} -> ${preview.candidateRevision?.slice(0, 7) ?? 'n/a'}`,
            ),
          );
          if (!confirmed) {
            console.log(`\n${symbols.info} Update skipped.\n`);
            return;
          }
        }

        const applied = await service.update({
          names,
          apply: true,
          yes: Boolean(flags.yes),
        } satisfies UpdateOptions);
        printUpdates(applied);
        const updatedCount = applied.filter(
          (preview) =>
            preview.changed &&
            preview.nextLinkTarget &&
            !preview.warnings.includes('Skipped by user.'),
        ).length;
        console.log(
          `\n${symbols.success} ${style.bold('Update complete')} ${style.gray(`(${updatedCount} item(s) updated)`)}\n`,
        );
      });
    },
  );

program
  .command('diff')
  .argument('[names...]', 'Optional installed names to diff')
  .action(async (names: string[]) => {
    const previews = await withService((service) =>
      service.previewUpdates({ names }),
    );
    printUpdates(previews);
  });

program
  .command('remove')
  .argument('<name>', 'Installed name')
  .option('--purge', 'Also purge unused cache data')
  .action(async (name: string, flags: { purge?: boolean }) => {
    const removed = await withService((service) =>
      service.removeInstall(name, { purge: Boolean(flags.purge) }),
    );
    console.log(
      `\n${symbols.success} ${style.bold('Removed')} ${style.green(removed.name)}\n`,
    );
  });

const cacheCmd = program.command('cache').description('Manage AgentPM cache');

const cacheCleanCmd = cacheCmd
  .command('clean')
  .description(
    'Remove unused Git checkout caches while preserving active installs and the search index',
  )
  .option('--dry-run', 'Show unused cache paths without deleting them');

cacheCleanCmd.action(async () => {
  const dryRun = Boolean(
    cacheCleanCmd.opts<{ dryRun?: boolean }>().dryRun ||
      rawCliArgs.includes('--dry-run'),
  );
  const result = await withService((service) => service.cleanCache({ dryRun }));
  printCacheCleanResult(result);
});

program
  .command('push')
  .argument(
    '[pathOrName]',
    'Skill name, relative path, or folder to push. Omit to choose interactively.',
  )
  .option('--to <target>', 'Target id or locator')
  .option('-m, --message <message>', 'Commit message if changes exist')
  .option('--all', 'Push all detected local skills or agents')
  .option('--dry-run', 'Show what would be pushed without doing it')
  .option(
    '--preserve-layout',
    'Keep native target-relative paths instead of normalizing to skills/<name>',
  )
  .action(
    async (
      pathArg: string | undefined,
      flags: {
        to?: string;
        message?: string;
        all?: boolean;
        dryRun?: boolean;
        preserveLayout?: boolean;
      },
    ) => {
      const result = await withService((service) =>
        service.push({
          path: pathArg,
          target: flags.to,
          message: flags.message,
          all: flags.all,
          dryRun: flags.dryRun,
          preserveLayout: flags.preserveLayout,
        }),
        {
          statusMessages: true,
        },
      );
      if (result.success) {
        console.log(
          `\n${symbols.success} ${style.bold('Pushed to')} ${style.cyan(result.targetLocator)}`,
        );
        for (const entry of result.entries) {
          console.log(`  ${symbols.bullet} ${entry}`);
        }
        if (result.revision) {
          console.log(
            `  ${symbols.bullet} Revision: ${style.bold(result.revision.slice(0, 12))}`,
          );
        }
        for (const warning of result.warnings) {
          console.log(`  ${symbols.warning} ${style.yellow(warning)}`);
        }
        console.log('');
      }
    },
  );

program
  .command('pull')
  .description(
    'Pull canonical skills from a target repo into your coding agents',
  )
  .argument('[skills...]', 'Skill names to pull. Omit to pull every skill.')
  .option('--from <target>', 'Target id or locator to pull from')
  .option(
    '--target <agents>',
    'Comma-separated agents to install into (codex,claude,generic). Default: auto-detect.',
  )
  .option('--project', 'Install into the current project instead of globally')
  .option('--yes', 'Skip prompts and install to all detected agents')
  .action(
    async (
      skills: string[],
      flags: {
        from?: string;
        target?: string;
        project?: boolean;
        yes?: boolean;
      },
    ) => {
      const result = await withService(
        (service) =>
          service.pull({
            skills,
            target: flags.from,
            agents: parseAgents(flags.target),
            scope: flags.project ? 'project' : 'global',
            yes: flags.yes,
          }),
        { statusMessages: true },
      );
      if (result.success) {
        console.log(
          `\n${symbols.success} ${style.bold('Pulled from')} ${style.cyan(result.sourceLocator)}`,
        );
        for (const install of result.installs) {
          console.log(
            `  ${symbols.bullet} ${style.green(install.name)} ${style.gray('→')} ${install.targetPath}`,
          );
        }
        for (const warning of result.warnings) {
          console.log(`  ${symbols.warning} ${style.yellow(warning)}`);
        }
        console.log('');
      }
    },
  );

program
  .command('adopt')
  .description(
    'Bring an existing local skill under AgentPM management and fan it out to other agents',
  )
  .argument('<skillOrPath>', 'Skill name or path to an existing skill directory')
  .option(
    '--target <agents>',
    'Comma-separated agents to also install into (codex,claude,generic)',
  )
  .option('--yes', 'Skip prompts and install to all detected agents')
  .action(
    async (
      token: string,
      flags: { target?: string; yes?: boolean },
    ) => {
      const result = await withService(
        (service) =>
          service.adopt(token, {
            agents: parseAgents(flags.target),
            yes: flags.yes,
          }),
        { statusMessages: true },
      );
      if (result.success) {
        console.log(
          `\n${symbols.success} ${style.bold('Adopted')} ${style.green(result.name)} ${style.gray('→')} ${style.underline(result.libraryPath)}`,
        );
        for (const install of result.installs) {
          console.log(
            `  ${symbols.bullet} ${install.adapter} ${style.gray('→')} ${install.targetPath}`,
          );
        }
        for (const warning of result.warnings) {
          console.log(`  ${symbols.warning} ${style.yellow(warning)}`);
        }
        console.log('');
      }
    },
  );

program.command('list').action(async () => {
  const installs = await withService((service) =>
    Promise.resolve(service.listInstalls()),
  );
  if (installs.length === 0) {
    console.log('No installs found.');
    return;
  }
  for (const install of installs) {
    console.log(`${install.name}  ${install.scope}  ${install.targetPath}`);
  }
});

program.command('init').action(async () => {
  const result = await withService((service) => service.initManifest());
  console.log(
    `\n${symbols.success} ${style.bold('Initialized manifest')} ${style.gray('→')} ${style.underline(result.manifestPath)}\n`,
  );
});

program.command('sync').action(async () => {
  const installs = await withService((service) => service.syncManifest());
  for (const install of installs) {
    console.log(
      `${symbols.success} ${style.bold('Synced')} ${style.green(install.name)}`,
    );
  }
});

program
  .command('resolve')
  .description(
    'Resolve active runtime skill layers without writing project runtime folders',
  )
  .option('--temp <name>', 'Add a temporary skill layer entry', collect, [])
  .option('--json', 'Print the resolved context graph as JSON')
  .action(async (flags: { temp?: string[]; json?: boolean }) => {
    const graph = await withService(
      (service) =>
        service.resolveRuntimeContext({ temporarySkills: flags.temp ?? [] }),
    );
    if (flags.json) {
      console.log(JSON.stringify(graph, null, 2));
      return;
    }
    printRuntimeContext(graph);
  });

program
  .command('doctor')
  .option('--fix', 'Interactively apply safe fixes for detected errors')
  .action(async (flags: { fix?: boolean }) => {
    await withService(async (service) => {
      const issues = await service.doctor();
      printDoctor(issues);

      if (!flags.fix) {
        return;
      }

      const errors = issues.filter((issue) => issue.severity === 'error');
      if (errors.length === 0) {
        console.log(`\n${symbols.success} No errors detected.\n`);
        return;
      }

      const shouldPlan = await promptToConfirm(
        'Errors detected. Would you like to attempt to fix these issues? [y/N]',
      );
      if (!shouldPlan) {
        console.log(`\n${symbols.info} No fixes applied.\n`);
        return;
      }

      const actions = await service.planDoctorFixes(issues);
      printDoctorFixes(actions, issues);
      if (actions.length === 0) {
        return;
      }

      const shouldApply = await promptToConfirm('Apply these fixes? [y/N]');
      if (!shouldApply) {
        console.log(`\n${symbols.info} No fixes applied.\n`);
        return;
      }

      const results = await service.applyDoctorFixes(actions);
      for (const result of results) {
        if (result.applied) {
          console.log(`${symbols.success} ${result.action.description}`);
        }
      }
      console.log('');
    });
  });

try {
  await program.parseAsync(process.argv);
} catch (err: unknown) {
  if (err instanceof Error) {
    if (err.message === '(outputHelp)' || err.message === program.version()) {
      process.exit(0);
    }
    console.error(
      `\n${symbols.error} ${style.bold(style.red('AgentPM Command Failed'))}`,
    );
    console.error(`  ${style.red(err.message)}`);
    console.error(
      `\n${style.gray('Need help? Run a diagnostic check using:')} ${style.cyan('agentpm doctor')}\n`,
    );
  } else {
    console.error(
      `\n${symbols.error} ${style.bold(style.red('An unexpected error occurred'))}`,
    );
    console.error(`  ${style.red(String(err))}\n`);
  }
  process.exit(1);
}
