// `applyant config roles`: which provider and model answer each role.
import type { Command } from 'commander';
import type { ApplyantClient } from './client.ts';
import { table } from './format.ts';

const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};
const json = (value: unknown): void => out(JSON.stringify(value, null, 2));

export function registerConfig(program: Command, client: () => ApplyantClient): void {
  const config = program.command('config').description('how applyantd works: model roles');
  const roles = config
    .command('roles')
    .description('which provider and model answer each role (claude, codex, jev, apple)');

  roles
    .command('list', { isDefault: true })
    .description('every role, its route, and its default')
    .option('--json', 'print JSON')
    .action(async (opts: { json?: boolean }) => {
      const res = await client().listRoles({});
      if (opts.json) {
        return json(
          res.roles.map((r) => ({
            role: r.role,
            route: r.route,
            default: r.defaultRoute,
            overridden: r.overridden,
            fallback: r.fallback ?? null,
            description: r.description,
          })),
        );
      }
      out(
        table(
          ['ROLE', 'ROUTE', 'DEFAULT', 'FALLBACK', 'WHAT IT DOES'],
          res.roles.map((r) => [
            r.role,
            r.route + (r.overridden ? ' *' : ''),
            r.defaultRoute,
            r.fallback ?? '-',
            r.description,
          ]),
        ),
      );
      if (res.roles.some((r) => r.overridden))
        out('* set by you (`applyant config roles reset` undoes it)');
    });

  roles
    .command('set <role> <route>')
    .description(
      'route a role: `set matcher codex`, `set extractor claude:opus`, `set option_match jev`',
    )
    .action(async (role: string, route: string) => {
      const res = await client().setRole({ role, route });
      const r = res.role;
      if (!r) throw new Error('daemon returned no role');
      out(
        r.overridden
          ? `${r.role} → ${r.route} (default ${r.defaultRoute}). The next ${r.role} run uses it.`
          : `${r.role} → ${r.route} (its default).`,
      );
    });

  roles
    .command('reset [role]')
    .description('put one role, or every role, back on its default route')
    .action(async (role: string | undefined) => {
      const res = await client().resetRoles(role ? { role } : {});
      out(
        res.roles.length
          ? `Back on the default route: ${res.roles.join(', ')}.`
          : role
            ? `${role} already follows its default route.`
            : 'Every role already follows its default route.',
      );
    });
}
