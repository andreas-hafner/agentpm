import { Command } from 'commander';

import {
  AgentPmService,
  type InstallOptions,
  type UpdateOptions,
} from '@agentpm/core';
import { createPromptApi, promptToConfirm } from '@agentpm/ui';

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
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
    console.log(`\n${symbols.success} Cache is already clean.\n`);
    return;
  }

  section('Cache Clean');
  console.log(
    `  ${symbols.success} Removed ${style.bold(result.removedEntries.toString())} unused cache item(s).`,
  );
  for (const removedPath of result.removedPaths) {
    console.log(`    ${style.gray('-')} ${removedPath}`);
  }
  console.log('');
}

function printDoctorFixes(
  actions: Awaited<ReturnType<AgentPmService['planDoctorFixes']>>,
): void {
  if (actions.length === 0) {
    console.log(`\n${symbols.info} No safe automatic fixes are available.\n`);
    return;
  }

  section('Planned Fixes');
  for (const action of actions) {
    console.log(`  ${symbols.warning} ${style.yellow(action.description)}`);
  }
  console.log('');
}

async function checkFirstStart(service: AgentPmService): Promise<void> {
  const sources = service.listSources();
  if (sources.length > 0) {
    return;
  }
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    return;
  }

  const confirmed = await promptToConfirm(
    'No skill sources configured. Add SkillsHub (skillshub.wtf) as your default registry?',
    [
      'SkillsHub indexes 14,000+ open-source AI agent skills',
      'You can add more sources later with: agentpm source add <url>',
    ],
  );
  if (confirmed) {
    const result = await service.addSource('https://skillshub.wtf');
    console.log(
      `Added ${result.source.displayName} (${result.indexedEntries} entries indexed)`,
    );
  }
}

async function withService<T>(
  callback: (service: AgentPmService) => Promise<T>,
  options: { checkFirstStart?: boolean } = {},
): Promise<T> {
  const service = new AgentPmService({ prompts: createPromptApi() });
  try {
    if (options.checkFirstStart !== false) {
      await checkFirstStart(service);
    }
    return await callback(service);
  } finally {
    service.close();
  }
}

const program = new Command();
program
  .name('agentpm')
  .description('Git-native skill and agent asset manager')
  .version('0.3.0')
  .exitOverride()
  .showHelpAfterError(false)
  .addHelpText('beforeAll', brandBlock());

const source = program
  .command('source')
  .alias('sources')
  .description('Manage sources');
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
  .description('Manage push targets in project config');

targetCmd
  .command('add')
  .argument('<id>', 'Target ID')
  .argument('<locator>', 'Target locator (Git URL or registry path)')
  .option('--global', 'Add target to global config')
  .action(async (id: string, locator: string, flags: { global?: boolean }) => {
    await withService((service) =>
      service.addTarget(id, locator, flags.global),
    );
    if (flags.global) {
      console.log(
        `\n${symbols.success} ${style.bold('Added target')} ${style.cyan(id)} to global config\n`,
      );
    } else {
      console.log(
        `\n${symbols.success} ${style.bold('Added target')} ${style.cyan(id)} to ${style.bold('agentpm.yaml')}\n`,
      );
    }
  });

targetCmd
  .command('remove')
  .argument('<id>', 'Target ID')
  .option('--global', 'Remove target from global config')
  .action(async (id: string, flags: { global?: boolean }) => {
    await withService((service) => service.removeTarget(id, flags.global));
    if (flags.global) {
      console.log(
        `\n${symbols.success} ${style.bold('Removed target')} ${style.cyan(id)} from global config\n`,
      );
    } else {
      console.log(
        `\n${symbols.success} ${style.bold('Removed target')} ${style.cyan(id)} from ${style.bold('agentpm.yaml')}\n`,
      );
    }
  });

targetCmd.command('list').action(async () => {
  const { loadProjectConfig, loadGlobalConfig } =
    await import('@agentpm/config');
  const config = await loadProjectConfig(process.cwd());
  const globalConfig = await loadGlobalConfig(process.cwd());

  const projectTargets = config?.manifest.targets ?? [];
  const globalTargets = globalConfig.targets ?? [];

  if (projectTargets.length === 0 && globalTargets.length === 0) {
    console.log('No targets configured in agentpm.yaml or global config.');
    return;
  }

  if (projectTargets.length > 0) {
    console.log('Project Targets (agentpm.yaml):');
    for (const target of projectTargets) {
      const targetId = target.id ?? '(unnamed)';
      console.log(
        `${target.default ? '*' : ' '} ${targetId.padEnd(20)} ${target.kind?.padEnd(10) ?? ''} ${target.locator}`,
      );
    }
    console.log('');
  }

  if (globalTargets.length > 0) {
    console.log('Global Targets (config.yaml):');
    for (const target of globalTargets) {
      const targetId = target.id ?? '(unnamed)';
      console.log(
        `${target.default ? '*' : ' '} ${targetId.padEnd(20)} ${target.kind?.padEnd(10) ?? ''} ${target.locator}`,
      );
    }
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
  .action(async (query: string) => {
    const results = await withService((service) =>
      Promise.resolve(service.search(query)),
    );
    if (results.length === 0) {
      console.log('No matches found.');
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
  .action(
    async (
      names: string[],
      flags: InstallOptions & {
        global?: boolean;
        project?: boolean;
        workspace?: boolean;
        workspaceRoot?: string;
        skill?: string[];
        ref?: string;
        target?: string;
      },
    ) => {
      const installs = await withService((service) =>
        service.install(names, {
          scope: resolveScope(flags),
          workspaceRoot: flags.workspaceRoot,
          all: flags.all,
          skills: flags.skill,
          ref: flags.ref ?? null,
          target: resolveTarget(flags.target),
        }),
      );
      for (const install of installs) {
        console.log(
          `\n${symbols.success} ${style.bold('Installed')} ${style.green(install.name)} ${style.gray('→')} ${style.underline(install.targetPath)}`,
        );
      }

      if (installs.length > 0 && !flags.global) {
        await withService((service) => service.initManifest());
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

cacheCmd.command('clean').action(async () => {
  const result = await withService((service) => service.cleanCache());
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
  .action(
    async (
      pathArg: string | undefined,
      flags: {
        to?: string;
        message?: string;
        all?: boolean;
        dryRun?: boolean;
      },
    ) => {
      const result = await withService((service) =>
        service.push({
          path: pathArg,
          target: flags.to,
          message: flags.message,
          all: flags.all,
          dryRun: flags.dryRun,
        }),
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
  const installs = await withService((service) => service.syncManifest(), {
    checkFirstStart: false,
  });
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
      {
        checkFirstStart: false,
      },
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
      printDoctorFixes(actions);
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
