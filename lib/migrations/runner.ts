import { compareVersions, isVersion, maxVersion } from './version.ts';
import type { DataPort, FloorPort, LedgerPort, LedgerRecord, Migration, Phase } from './types.ts';

// The migration runner. The README section "Data" explains the design. The rules, in short:
//
// 1. A migration has an id with four digits. The runner runs the migrations in the order of the ids.
// 2. The ledger (one record for each migration, in the table itself) says what ran. A migration that is done does not run again.
// 3. A migration is safe to repeat. A run can stop in the middle, and the next run starts the same migration again.
// 4. The phase "expand" runs before the new code takes traffic. The phase "contract" runs after the canary has finished.
// 5. A contract migration (destructive) records the rollback floor in the ledger and in SSM BEFORE its first change of data.
//    The floor never goes down. It is the highest of the declared floor and the floors in the ledger.

export class MigrationError extends Error {
  override readonly name = 'MigrationError';
}

export interface RunInput {
  readonly phase: Phase;
  // The release that is deployed, for example 0.9.0.
  readonly version: string;
  // The value of minRollbackVersion in pipeline.json at the time of the build.
  readonly declaredFloor: string;
  // All the migrations of this release, in ascending order of the ids. The runner picks the ones of the phase.
  readonly migrations: readonly Migration[];
}

export interface RunnerPorts {
  readonly data: DataPort;
  readonly ledger: LedgerPort;
  readonly floor: FloorPort;
  readonly now?: () => Date;
  readonly log?: (event: Record<string, unknown>) => void;
}

export interface RunResult {
  readonly phase: Phase;
  // The migrations that this run finished.
  readonly ran: readonly string[];
  // The migrations of this phase that were done before this run.
  readonly alreadyDone: readonly string[];
  // Ledger records that this release does not know. A newer release wrote them. This release ignores them.
  readonly unknownInLedger: readonly string[];
  // The rollback floor that the run wrote to SSM.
  readonly floor: string;
}

const ID = /^[0-9]{4}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Checks the list before anything runs. A mistake here is a mistake of the developer, so it fails the release in Test.
export function validateMigrations(migrations: readonly Migration[]): void {
  let previous: string | undefined;
  for (const migration of migrations) {
    if (!ID.test(migration.id)) {
      throw new MigrationError(`The migration id "${migration.id}" is wrong. Use four digits, a hyphen and a name, for example 0002-add-title.`);
    }
    if (previous !== undefined && migration.id <= previous) {
      throw new MigrationError(`The migrations must be in ascending order of the ids. "${migration.id}" comes after "${previous}", and no id may appear twice.`);
    }
    previous = migration.id;

    if (migration.phase === 'contract') {
      if (migration.contracts === undefined) {
        throw new MigrationError(`The contract migration ${migration.id} needs "contracts": the id of the expand migration that it follows.`);
      }
      const parent = migrations.find((candidate) => candidate.id === migration.contracts);
      if (!parent || parent.phase !== 'expand' || parent.id >= migration.id) {
        throw new MigrationError(`The contract migration ${migration.id} follows ${migration.contracts}, which is not an earlier expand migration of the list.`);
      }
    } else if (migration.contracts !== undefined) {
      throw new MigrationError(`The migration ${migration.id} has "contracts", but only a contract migration may have it.`);
    }
  }
}

// The highest floor of the declared floor and of every floor in the ledger. A record that is "started" counts: a
// contract migration that failed in the middle may have changed a part of the data already.
export function effectiveFloor(declaredFloor: string, records: readonly LedgerRecord[]): string {
  const floors = records.flatMap((record) => (record.minRollbackVersion === undefined ? [] : [record.minRollbackVersion]));
  return maxVersion(declaredFloor, ...floors);
}

export async function runMigrations(input: RunInput, ports: RunnerPorts): Promise<RunResult> {
  const { phase, version, declaredFloor, migrations } = input;
  const now = ports.now ?? ((): Date => new Date());
  const log = ports.log ?? ((): void => undefined);

  if (!isVersion(declaredFloor)) {
    throw new MigrationError(`minRollbackVersion in pipeline.json must be a version like 1.2.3, but it is ${JSON.stringify(declaredFloor)}.`);
  }
  validateMigrations(migrations);

  const records = new Map((await ports.ledger.readAll()).map((record) => [record.id, record]));
  const known = new Set(migrations.map((migration) => migration.id));
  const unknownInLedger = [...records.keys()].filter((id) => !known.has(id)).sort();
  if (unknownInLedger.length > 0) {
    // A newer release changed the data. This release is older. It still runs, because the floor allowed it.
    log({ event: 'ledger-has-unknown-migrations', ids: unknownInLedger });
  }

  const mine = migrations.filter((migration) => migration.phase === phase);
  const alreadyDone = mine.filter((migration) => records.get(migration.id)?.status === 'done').map((migration) => migration.id);
  const pending = mine.filter((migration) => records.get(migration.id)?.status !== 'done');
  const ran: string[] = [];

  for (const migration of pending) {
    let floorOfMigration: string | undefined;

    if (migration.phase === 'contract') {
      const parentId = migration.contracts as string;
      const parent = records.get(parentId);
      if (parent?.status !== 'done') {
        throw new MigrationError(`The contract migration ${migration.id} follows ${parentId}, but ${parentId} is not done. Release the expand step first.`);
      }
      if (compareVersions(declaredFloor, parent.version) < 0) {
        throw new MigrationError(
          `The contract migration ${migration.id} would make the data unreadable for versions older than ${parent.version}, ` +
            `because release ${parent.version} ran ${parentId}. But minRollbackVersion ${declaredFloor} in pipeline.json is older. ` +
            `Raise minRollbackVersion to ${parent.version} or newer, and release again. Nothing was changed.`,
        );
      }
      // An earlier run may have started this migration and failed. Keep its floor if it is higher.
      const earlier = records.get(migration.id)?.minRollbackVersion;
      floorOfMigration = earlier === undefined ? declaredFloor : maxVersion(declaredFloor, earlier);
    }

    const startedAt = now().toISOString();
    const started: LedgerRecord = {
      id: migration.id,
      status: 'started',
      phase: migration.phase,
      version,
      startedAt,
      ...(floorOfMigration === undefined ? {} : { minRollbackVersion: floorOfMigration }),
    };
    await ports.ledger.markStarted(started);
    records.set(migration.id, started);
    if (floorOfMigration !== undefined) {
      // The floor goes up first. If the migration fails after this line, the floor stays up.
      await ports.floor.write(effectiveFloor(declaredFloor, [...records.values()]));
    }

    log({ event: 'migration-started', id: migration.id, phase: migration.phase, version });
    try {
      await migration.up(ports.data);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new MigrationError(
        `The migration ${migration.id} failed: ${reason}. ` +
          `The ledger shows it as started, so the next run starts it again. A migration is safe to repeat. ` +
          `The data can be changed in part. Fix the cause and release again. Do not roll back the code to repair the data.`,
        { cause },
      );
    }

    const finishedAt = now().toISOString();
    await ports.ledger.markDone(migration.id, finishedAt);
    records.set(migration.id, { ...started, status: 'done', finishedAt });
    ran.push(migration.id);
    log({ event: 'migration-done', id: migration.id, phase: migration.phase, version });
  }

  // Every run writes the floor, also a run that had nothing to do. The ledger decides, so an older release that is
  // deployed again (a rollback) cannot lower the floor with its own, older, declared value.
  const floor = effectiveFloor(declaredFloor, [...records.values()]);
  await ports.floor.write(floor);
  log({ event: 'floor-written', floor, phase });

  return { phase, ran, alreadyDone, unknownInLedger, floor };
}
