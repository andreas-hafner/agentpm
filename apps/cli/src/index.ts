import { Command } from 'commander';

import { AgentPmService, type InstallOptions, type UpdateOptions } from '@agentpm/core';
import { createPromptApi, promptToConfirm } from '@agentpm/ui';

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function resolveScope(flags: { global?: boolean; project?: boolean; workspace?: boolean }): InstallOptions['scope'] {
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

function printInspection(report: Awaited<ReturnType<AgentPmService['inspect']>>): void {
  console.log(`Source: ${report.locator}`);
  console.log(`Installable: ${report.installable ? 'yes' : 'no'}`);
  for (const compatibility of report.compatibleAdapters) {
    console.log(`Adapter ${compatibility.adapter}: ${compatibility.compatible ? 'compatible' : 'no'} (${compatibility.score})`);
  }
  for (const group of report.groups) {
    console.log(`${group.label}: ${group.entries.length}`);
    for (const entry of group.entries) {
      console.log(`  - ${entry.name} -> ${entry.relativePath}`);
    }
  }
  if (report.scripts.length > 0) {
    console.log('Install scripts:');
    for (const script of report.scripts) {
      console.log(`  - ${script.relativePath}`);
    }
  }
  if (report.warnings.length > 0) {
    console.log('Warnings:');
    for (const warning of report.warnings) {
      console.log(`  - ${warning}`);
    }
  }
}

function printUpdates(previews: Awaited<ReturnType<AgentPmService['previewUpdates']>>): void {
  if (previews.length === 0) {
    console.log('No installs found.');
    return;
  }

  for (const preview of previews) {
    const revisionSummary =
      preview.currentRevision && preview.candidateRevision
        ? `${preview.currentRevision.slice(0, 7)} -> ${preview.candidateRevision.slice(0, 7)}`
        : 'n/a';
    console.log(`${preview.install.name}: ${preview.changed ? 'changed' : 'up to date'} (${revisionSummary})`);
    if (preview.changed) {
      console.log(`  risk: ${preview.risk}`);
      for (const diff of preview.diff) {
        console.log(`  ${diff.kind}: ${diff.path}`);
      }
      for (const warning of preview.warnings) {
        console.log(`  warning: ${warning}`);
      }
    }
  }
}

function printDoctor(issues: Awaited<ReturnType<AgentPmService['doctor']>>): void {
  if (issues.length === 0) {
    console.log('Doctor found no issues.');
    return;
  }

  for (const issue of issues) {
    console.log(`[${issue.severity}] ${issue.code}: ${issue.message}`);
    if (issue.path) {
      console.log(`  path: ${issue.path}`);
    }
    if (issue.remedy) {
      console.log(`  remedy: ${issue.remedy}`);
    }
  }
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
    console.log(`Added ${result.source.displayName} (${result.indexedEntries} entries indexed)`);
  }
}

async function withService<T>(callback: (service: AgentPmService) => Promise<T>): Promise<T> {
  const service = new AgentPmService({ prompts: createPromptApi() });
  try {
    await checkFirstStart(service);
    return await callback(service);
  } finally {
    service.close();
  }
}

const program = new Command();
program
  .name('agentpm')
  .description('Git-native skill and agent asset manager')
  .version('0.1.0')
  .exitOverride()
  .showHelpAfterError(false);

const source = program.command('source').alias('sources').description('Manage sources');
source
  .command('add')
  .argument('<locator>', 'Git URL, local folder, or registry index path')
  .action(async (locator: string) => {
    const result = await withService((service) => service.addSource(locator));
    console.log(`Added source ${result.source.displayName} (${result.indexedEntries} entries indexed)`);
  });

source.command('list').action(async () => {
  const sources = await withService((service) => Promise.resolve(service.listSources()));
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
    console.log(`Removed source ${sourceToken}`);
  });

program
  .command('inspect')
  .argument('<target>', 'Source id, Git URL, or local path')
  .action(async (target: string) => {
    const report = await withService((service) => service.inspect(target));
    printInspection(report);
  });

program
  .command('search')
  .argument('<query>', 'Query text')
  .action(async (query: string) => {
    const results = await withService((service) => Promise.resolve(service.search(query)));
    if (results.length === 0) {
      console.log('No matches found.');
      return;
    }
    for (const result of results) {
      console.log(`${result.kind}  ${result.name}  ${result.locator ?? ''}`);
    }
  });

program
  .command('install')
  .argument('[names...]', 'Skill names or source token for --all/--skill flows')
  .option('--global', 'Install to the global native target')
  .option('--project', 'Install to the current project')
  .option('--workspace', 'Install to a workspace root')
  .option('--workspace-root <path>', 'Explicit workspace root')
  .option('--all', 'Install all entries from a source')
  .option('--skill <name>', 'Select a specific skill name', collect, [])
  .option('--ref <ref>', 'Git branch, tag, or revision')
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
      },
    ) => {
      const installs = await withService((service) =>
        service.install(names, {
          scope: resolveScope(flags),
          workspaceRoot: flags.workspaceRoot,
          all: flags.all,
          skills: flags.skill,
          ref: flags.ref ?? null,
        }),
      );
      for (const install of installs) {
        console.log(`Installed ${install.name} -> ${install.targetPath}`);
      }
    },
  );

program
  .command('update')
  .argument('[names...]', 'Optional installed names to update')
  .option('--yes', 'Confirm risky remaps automatically')
  .action(async (names: string[], flags: { yes?: boolean }) => {
    const previews = await withService((service) =>
      service.update({ names, apply: true, yes: Boolean(flags.yes) } satisfies UpdateOptions),
    );
    printUpdates(previews);
  });

program
  .command('diff')
  .argument('[names...]', 'Optional installed names to diff')
  .action(async (names: string[]) => {
    const previews = await withService((service) => service.previewUpdates({ names }));
    printUpdates(previews);
  });

program
  .command('remove')
  .argument('<name>', 'Installed name')
  .option('--purge', 'Also purge unused cache data')
  .action(async (name: string, flags: { purge?: boolean }) => {
    const removed = await withService((service) => service.removeInstall(name, { purge: Boolean(flags.purge) }));
    console.log(`Removed ${removed.name}`);
  });

program.command('list').action(async () => {
  const installs = await withService((service) => Promise.resolve(service.listInstalls()));
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
  console.log(`Wrote ${result.manifestPath}`);
});

program.command('sync').action(async () => {
  const installs = await withService((service) => service.syncManifest());
  for (const install of installs) {
    console.log(`Synced ${install.name}`);
  }
});

program.command('doctor').action(async () => {
  const issues = await withService((service) => service.doctor());
  printDoctor(issues);
});

try {
  await program.parseAsync(process.argv);
} catch (err: unknown) {
  if (err instanceof Error) {
    if (err.message === '(outputHelp)' || err.message === program.version()) {
      process.exit(0);
    }
    console.error(`Error: ${err.message}`);
  }
  process.exit(1);
}
