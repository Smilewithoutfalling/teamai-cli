import path from 'node:path';
import fs from 'node:fs/promises';
import fse from 'fs-extra';
import { ResourceHandler } from './base.js';
import { resolveBaseDir, type ResourceItem, type TeamaiConfig, type LocalConfig } from '../types.js';
import { expandHome, listDirs, pruneEmptyDirs } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { caseFoldKey } from '../manifest-schema.js';
import { resolveResourceNamespaces } from '../resource-namespaces.js';
import { describeKeptEntry, describeMembersDirLeft, isLink, isTeamaiCopy, isTeamaiSkillCopy } from './delivered-copies.js';
import { blobIdOf, historicalVersions, type HistoricalVersion } from '../utils/team-history.js';

/**
 * The single directory the team docs bundle is copied into. In project scope a
 * `~/`-prefixed `sharing.docs.localDir` is relative to the project root, not to
 * HOME. `pull` writes here and `doctor` checks here (#598).
 */
export function resolveDocsDestination(teamConfig: TeamaiConfig, localConfig: LocalConfig): string {
  const localDir = teamConfig.sharing.docs.localDir;
  if (localConfig.scope === 'project' && localConfig.projectRoot && localDir.startsWith('~/')) {
    return path.join(localConfig.projectRoot, localDir.substring(2));
  }
  const expanded = expandHome(localDir);
  return path.isAbsolute(expanded) ? expanded : path.resolve(resolveBaseDir(localConfig), expanded);
}

/** Only absence means an empty bundle; permission and I/O errors must stop pruning. */
async function readEntries(dir: string) {
  try {
    return await fse.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Files in the docs mirror, including links themselves but never their targets. */
export async function listDocFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readEntries(expandHome(dir))) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      const nested = await listDocFiles(path.join(dir, entry.name));
      files.push(...nested.map(file => `${entry.name}/${file}`));
    } else {
      files.push(entry.name);
    }
  }
  return files;
}

/** Empty leaf directories that pruning would remove; never follow links or hidden entries. */
export async function listStaleDocDirectories(source: string | undefined, destination: string): Promise<string[]> {
  const sourceEntries = new Map((source ? await readEntries(source) : []).map(entry => [entry.name, entry]));
  const stale: string[] = [];
  for (const entry of await readEntries(destination)) {
    if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
    const sourceEntry = sourceEntries.get(entry.name);
    if (sourceEntry && !sourceEntry.isDirectory()) continue;
    const target = path.join(destination, entry.name);
    if (!sourceEntry && (await readEntries(target)).length === 0) {
      stale.push(`${entry.name}/`);
    } else {
      const nested = await listStaleDocDirectories(sourceEntry ? path.join(source!, entry.name) : undefined, target);
      stale.push(...nested.map(dir => `${entry.name}/${dir}`));
    }
  }
  return stale;
}

/**
 * Whether the prune may delete `file`, at `rel` in the mirror (`/`-separated),
 * which the team repo no longer has (#993): only a version of the team doc once
 * at that path (a link included, by its target). Anything else is the member's:
 * an entry at a path the team history never had (no team version is no proof
 * that teamai put it there), any other entry at a removed doc's path, and any
 * entry while the history cannot be read. Read-only.
 */
export async function isPrunableDoc(file: string, rel: string, repoPath: string): Promise<boolean> {
  const stat = await fse.lstat(file).catch(() => null);
  if (!stat) return true;
  const versions = await historicalVersions(repoPath, `docs/${rel}`);
  if (versions === null || versions.length === 0) return false;
  return isDocVersion(file, stat, versions, repoPath);
}

/**
 * Whether the mirror entry at `file` (`stat`, from lstat) is one of `versions` of a team doc,
 * compared by git blob id. Anything but a file or a link is not: no team version can match it.
 * git stores a link as a blob of its target, so a link the team delivered matches by id; it is
 * never followed.
 */
async function isDocVersion(file: string, stat: fse.Stats, versions: readonly HistoricalVersion[], repoPath: string): Promise<boolean> {
  if (versions.length === 0 || (!stat.isFile() && !stat.isSymbolicLink())) return false;
  const bytes = stat.isSymbolicLink()
    ? await fs.readlink(file).then((target) => Buffer.from(target), () => null)
    : await readBytes(file);
  if (bytes === null) return false;
  const id = await blobIdOf(repoPath, bytes);
  // A link matches only a link the team had, a file only a file: the same bytes are not the same entry.
  const link = stat.isSymbolicLink();
  return versions.some((version) => version.blob === id && (version.mode === '120000') === link);
}

/**
 * Whether the docs mirror's root `dir` is itself a link (#993): the member's, pointing at a directory
 * of their own. teamai never writes through it, walks it or deletes anything behind it.
 */
export async function isLinkedDocsRoot(dir: string): Promise<boolean> {
  return (await fse.lstat(dir).catch(() => null))?.isSymbolicLink() ?? false;
}

/** The line naming a linked docs root, for the command that left it. */
export function describeLinkedDocsRoot(dir: string, command: 'pull' | 'uninstall'): string {
  return `Kept ${dir}: it is a link of yours, so ${command === 'pull' ? 'teamai delivers no docs through it' : 'uninstall left it and what it points at'}. `
    + (command === 'pull' ? 'Make sharing.docs.localDir a directory, or remove the link, then run `teamai pull`.' : 'Delete it when you no longer need it.');
}

/**
 * Remove from the docs mirror `dir` what is teamai's, for `uninstall` (#993): each file or link
 * at `<rel>` that is a version of `docs/<rel>` in the team repo's history. Anything else is the
 * member's and stays, named; hidden entries stay silently, as pull leaves them. A directory goes
 * once nothing is left in it. While the history cannot be read, nothing goes, since nothing proves
 * a doc teamai's. Returns the lines naming what stayed.
 */
export async function removeTeamDocs(dir: string, repoPath: string): Promise<string[]> {
  if (await isLinkedDocsRoot(dir)) return [describeLinkedDocsRoot(dir, 'uninstall')];
  const history = await historicalVersions(repoPath, 'docs');
  if (history === null) {
    return [`Kept ${dir}: the team repo's history cannot be read, so nothing proves a doc there teamai's, and uninstall left it.`];
  }
  const kept: string[] = [];
  const walk = async (current: string, rel: string): Promise<void> => {
    for (const entry of await readEntries(current)) {
      const target = path.join(current, entry.name);
      // teamai never delivers a hidden entry: it is the member's, and keeps the mirror (and the data home around it).
      if (entry.name.startsWith('.')) {
        kept.push(`Kept ${target}: it is a hidden file of yours, so uninstall left it.`);
        continue;
      }
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(target, entryRel);
        if ((await fse.readdir(target)).length === 0) await fse.rmdir(target);
        continue;
      }
      const versions = history.filter((version) => version.path === `docs/${entryRel}`);
      if (await isDocVersion(target, await fse.lstat(target), versions, repoPath)) await fse.unlink(target);
      else kept.push(describeMembersDirLeft(target, `docs/${entryRel}`, 'uninstall'));
    }
  };
  await walk(dir, '');
  // The mirror itself goes once nothing is left in it.
  if ((await fse.lstat(dir)).isDirectory() && (await fse.readdir(dir)).length === 0) await fse.rmdir(dir);
  return kept;
}

/**
 * Remove stale visible entries without following local symlinks or removing
 * dotfiles. A file at a removed team doc's path that is no version of that doc
 * is kept and named (`isPrunableDoc`).
 */
async function pruneDocs(source: string | undefined, destination: string, repoPath: string, scope: string, rel = ''): Promise<void> {
  const sourceEntries = new Map((source ? await readEntries(source) : []).map(e => [e.name, e]));
  for (const entry of await readEntries(destination)) {
    if (entry.name.startsWith('.')) continue;
    const target = path.join(destination, entry.name);
    const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
    const sourceEntry = sourceEntries.get(entry.name);
    if (entry.isDirectory()) {
      if (sourceEntry && !sourceEntry.isDirectory()) continue;
      // A directory where the team once had a doc file, holding anything that is
      // no team version, is the member's, put in place of that file: all of it stays (#993).
      if (!sourceEntry && await isMembersDocDirectory(target, entryRel, repoPath)) {
        log.warn(
          `[${scope}] Kept ${target}: the team removed docs/${entryRel}, but this is a directory of yours in its place. `
          + 'Delete it when you no longer need it.',
        );
        continue;
      }
      await pruneDocs(sourceEntry ? path.join(source!, entry.name) : undefined, target, repoPath, scope, entryRel);
      // A stale directory containing hidden local files, or a file kept above, must survive.
      if (!sourceEntry && (await fse.readdir(target)).length === 0) await fse.rmdir(target);
    } else if (!sourceEntry) {
      if (!await isPrunableDoc(target, entryRel, repoPath)) {
        // A file of the member's at a path the team never had stays without a word, like a personal rule;
        // a link there is named, and any other entry kept is at a removed doc's path.
        const neverTeams = (await historicalVersions(repoPath, `docs/${entryRel}`))?.length === 0;
        if (neverTeams && !entry.isSymbolicLink()) continue;
        log.warn(neverTeams
          ? `[${scope}] Kept ${target}: it is a link of yours, and the team does not have docs/${entryRel}. `
            + 'Delete it when you no longer need it.'
          : `[${scope}] Kept ${target}: the team removed docs/${entryRel}, but this copy matches no team version of it. `
            + 'Delete it when you no longer need it.');
        continue;
      }
      await fse.unlink(target);
    }
  }
}

/**
 * Whether the mirror's directory `dir`, at `rel`, is one the member put where the team
 * history had a doc file, holding anything that is no team version (#993): pull keeps it whole.
 */
async function isMembersDocDirectory(dir: string, rel: string, repoPath: string): Promise<boolean> {
  return await wasTeamDocFile(repoPath, rel) && !await isTeamaiSkillCopy(dir, { repoPath, pathspec: `docs/${rel}` });
}

/**
 * Whether the prune deletes the mirror's `file` at `rel`, a path the team repo no longer has:
 * not inside a directory pull keeps whole, and `isPrunableDoc`. For doctor, which lists
 * files rather than walking directories as the prune does. Read-only.
 */
export async function isPrunedDoc(file: string, rel: string, repoPath: string): Promise<boolean> {
  const parts = rel.split('/');
  const root = file.slice(0, file.length - rel.length);
  for (let depth = 1; depth < parts.length; depth++) {
    const dirRel = parts.slice(0, depth).join('/');
    if (await isMembersDocDirectory(path.join(root, dirRel), dirRel, repoPath)) return false;
  }
  return isPrunableDoc(file, rel, repoPath);
}

/** Whether the team history ever had a file at `docs/<rel>` itself, not only under it. */
async function wasTeamDocFile(repoPath: string, rel: string): Promise<boolean> {
  const pathspec = `docs/${rel}`;
  const versions = await historicalVersions(repoPath, pathspec);
  return (versions ?? []).some((version) => version.path === pathspec || version.path.endsWith(`/${pathspec}`));
}

function containsPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function hasHiddenEntries(dir: string): Promise<boolean> {
  for (const entry of await readEntries(dir)) {
    if (entry.name.startsWith('.')) return true;
    if (entry.isDirectory() && await hasHiddenEntries(path.join(dir, entry.name))) return true;
  }
  return false;
}

/**
 * Find replacements without traversing destination links or touching either
 * tree. `withheld` names top-level directories that are not copied (#707).
 */
async function findDocConflicts(
  source: string,
  destination: string,
  withheld: ReadonlySet<string> = new Set(),
  kept: ReadonlySet<string> = new Set(),
  rel = '',
): Promise<Array<{ source: string; target: string }>> {
  const conflicts: Array<{ source: string; target: string }> = [];
  const localEntries = new Map((await readEntries(destination)).map(entry => [entry.name, entry]));
  for (const entry of await readEntries(source)) {
    if (entry.name.startsWith('.') || withheld.has(entry.name)) continue;
    const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
    // The member's entry stays where it is (#993): nothing replaces it.
    if (kept.has(entryRel)) continue;
    const local = localEntries.get(entry.name);
    if (!local) continue;
    const src = path.join(source, entry.name);
    const target = path.join(destination, entry.name);
    if (local.isSymbolicLink() || entry.isSymbolicLink() || local.isDirectory() !== entry.isDirectory()) {
      if (local.isDirectory() && await hasHiddenEntries(target)) {
        throw new Error(`Cannot replace ${target}: it contains hidden local entries. Move them before retrying.`);
      }
      conflicts.push({ source: src, target });
    } else if (entry.isDirectory()) {
      conflicts.push(...await findDocConflicts(src, target, new Set(), kept, entryRel));
    }
  }
  return conflicts;
}

/**
 * Copy `source` over `destination`, except the top-level directories in
 * `withheld` and the files in `kept` (relative, `/`-separated).
 */
async function copyDocs(
  source: string, destination: string, withheld: ReadonlySet<string>, kept: ReadonlySet<string>,
): Promise<void> {
  const conflicts = await findDocConflicts(source, destination, withheld, kept);
  const staging = conflicts.length ? await fse.mkdtemp(path.join(destination, '.teamai-docs-')) : undefined;
  const moved: Array<{ target: string; backup: string }> = [];
  const visible = (src: string) => !path.basename(src).startsWith('.');
  const delivered = (src: string) => {
    const rel = path.relative(source, src).split(path.sep);
    return visible(src) && !withheld.has(rel[0] ?? '') && !kept.has(rel.join('/'));
  };
  try {
    // Prepare replacements while the old entries are still in place. A copy
    // failure must not remove the directory/file it was meant to replace.
    for (const [index, conflict] of conflicts.entries()) {
      await fse.copy(conflict.source, path.join(staging!, `new-${index}`), { filter: visible });
    }
    const replacedSources = new Set(conflicts.map(conflict => conflict.source));
    await fse.copy(source, destination, {
      overwrite: true,
      filter: src => delivered(src) && !replacedSources.has(src),
    });
    // Copying has finished before any rename: no copy worker can write into
    // a conflicting path while it is being replaced or restored.
    for (const [index, conflict] of conflicts.entries()) {
      const backup = path.join(staging!, `old-${index}`);
      await fse.rename(conflict.target, backup);
      moved.push({ target: conflict.target, backup });
      await fse.rename(path.join(staging!, `new-${index}`), conflict.target);
    }
  } catch (error) {
    for (const { target, backup } of moved.reverse()) {
      await fse.remove(target);
      await fse.rename(backup, target);
    }
    // If restoration itself fails, leave the backup directory for recovery.
    if (staging) await fse.remove(staging);
    throw error;
  }
  if (staging) await fse.remove(staging);
}

/** What pull delivers from the team repo's `docs/`, and what it withholds (#707). */
export interface DesiredDocs {
  /** The team repo's `docs/`. */
  readonly sourceDir: string;
  /** The files delivered, relative to `sourceDir` as `listDocFiles` lists them, minus an inactive namespace's. */
  readonly files: readonly string[];
  /** Each `docs/<dir>/` of a namespace declared but not active here, with its files. */
  readonly withheld: ReadonlyArray<{ readonly dir: string; readonly files: readonly string[] }>;
}

/**
 * The docs this member receives: every file under `docs/` except those under a
 * top-level directory named by `inactiveNamespaces`. A directory no role or
 * project declares is never withheld. Names compare case-folded, so a
 * `docs/Checkout/` is withheld with `checkout` on every filesystem rather than
 * only on the ones that would open it under that name.
 */
export async function resolveDesiredDocs(repoPath: string, inactiveNamespaces: readonly string[]): Promise<DesiredDocs> {
  const sourceDir = path.join(expandHome(repoPath), 'docs');
  const inactive = new Set(inactiveNamespaces.map(caseFoldKey));
  const withheldDirs = new Set((await listDirs(sourceDir)).filter((dir) => inactive.has(caseFoldKey(dir))));
  const files: string[] = [];
  const withheld = new Map<string, string[]>([...withheldDirs].map((dir) => [dir, []]));
  for (const file of await listDocFiles(sourceDir)) {
    const slash = file.indexOf('/');
    const dirFiles = slash === -1 ? undefined : withheld.get(file.slice(0, slash));
    if (dirFiles) dirFiles.push(file.slice(slash + 1));
    else files.push(file);
  }
  return { sourceDir, files, withheld: [...withheld].map(([dir, dirFiles]) => ({ dir, files: dirFiles })) };
}

/**
 * `resolveDesiredDocs` for a caller that holds no pull context (recall,
 * contribute, doctor): the same namespaces pull resolves. Legacy mode withholds
 * nothing. Throws when the scope's manifests cannot be read, as pull stops the
 * scope then.
 */
export async function resolveDocsForDirectory(localConfig: LocalConfig): Promise<DesiredDocs> {
  const resolved = await resolveResourceNamespaces(localConfig);
  return resolveDesiredDocs(localConfig.repo.localPath, resolved?.inactiveDocsNamespaces ?? []);
}

/**
 * The paths of `desired` the mirror at `localDocsDir` must not write over,
 * because they are the member's (#993), relative and `/`-separated. The mirror
 * keeps no delivery record, so an entry there is teamai's only when the team
 * history holds it: a file at a team doc's path, a file where the team now has
 * a directory, or a directory where the team now has a file (every file in it).
 * A link is teamai's only when the team has the same link there now; it is
 * never followed. Anything else is the member's own: pull neither writes over
 * nor moves it, and names the entry. Read-only.
 */
export async function membersDocs(desired: DesiredDocs, localDocsDir: string, repoPath: string): Promise<string[]> {
  const members = new Set<string>();
  const teamais = (local: string, rel: string) => isTeamaiCopy(local, { repoPath, pathspec: `docs/${rel}` });
  for (const file of desired.files) {
    const parts = file.split('/');
    // A file of the member's where the team now has a directory holds back every doc under it.
    let blocked = false;
    for (let depth = 1; depth < parts.length && !blocked; depth++) {
      const rel = parts.slice(0, depth).join('/');
      const stat = await fse.lstat(path.join(localDocsDir, rel)).catch(() => null);
      if (!stat?.isFile() && !stat?.isSymbolicLink()) continue;
      blocked = true;
      const owned = stat.isSymbolicLink()
        ? await sameLink(path.join(localDocsDir, rel), path.join(desired.sourceDir, rel))
        : await teamais(path.join(localDocsDir, rel), rel);
      if (!owned) members.add(rel);
    }
    if (blocked) continue;
    const local = path.join(localDocsDir, file);
    const stat = await fse.lstat(local).catch(() => null);
    if (stat?.isSymbolicLink()) {
      if (!await sameLink(local, path.join(desired.sourceDir, file))) members.add(file);
      continue;
    }
    if (stat?.isDirectory()) {
      if (!await isTeamaiSkillCopy(local, { repoPath, pathspec: `docs/${file}` })) members.add(file);
      continue;
    }
    if (!stat?.isFile()) continue;
    const current = await readBytes(local);
    // Equal bytes prove a copy only of a team file: a team link's target bytes do not make a file teamai's.
    const sourceFile = path.join(desired.sourceDir, file);
    const source = (await fse.lstat(sourceFile).catch(() => null))?.isFile() ? await readBytes(sourceFile) : null;
    if (current === null || (source !== null && current.equals(source))) continue;
    if (!await teamais(local, file)) members.add(file);
  }
  return [...members];
}

/** Whether `local` and `team` are both links to the same target. Never follows either. */
async function sameLink(local: string, team: string): Promise<boolean> {
  const [mine, theirs] = await Promise.all([fs.readlink(local).catch(() => null), fs.readlink(team).catch(() => null)]);
  return mine !== null && mine === theirs;
}

/** Whether `rel` under `root`, or a directory on the way to it, is a link (never followed). */
async function passesThroughLink(root: string, rel: string): Promise<boolean> {
  let current = root;
  for (const part of rel.split(/[\\/]/)) {
    current = path.join(current, part);
    if (await isLink(current)) return true;
  }
  return false;
}

/** The file's bytes, or null when it is not a file this process can read. */
async function readBytes(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath);
  } catch {
    return null;
  }
}

/**
 * Remove the local copies of the docs `desired` withholds, the way a
 * deactivated namespace's skills and agents go: only a copy byte-equal to the
 * team file, now or in an earlier commit, is deleted. An older version is what
 * the mirror delivered before the team edited it, not a member edit. An edited
 * one is kept and named, so nothing a member wrote over a team doc is lost. A
 * local file the team repo does not have is the mirror's to prune, as anywhere
 * else in the destination.
 */
async function withdrawInactiveNamespaces(desired: DesiredDocs, localDocsDir: string, localConfig: LocalConfig): Promise<void> {
  for (const { dir, files } of desired.withheld) {
    const kept: string[] = [];
    for (const file of files) {
      const deployed = path.join(localDocsDir, dir, file);
      // A link of the member's at the doc or on the way to it: never read through or deleted in (#993).
      if (await passesThroughLink(localDocsDir, path.join(dir, file))) continue;
      const current = await readBytes(deployed);
      if (current === null) continue;
      // The type is part of the proof (#993): a file is teamai's only as a team file, today's or one from
      // the history, never as the target of a team link.
      const sourceFile = path.join(desired.sourceDir, dir, file);
      const source = (await fse.lstat(sourceFile).catch(() => null))?.isFile() ? await readBytes(sourceFile) : null;
      const unchanged = (source !== null && current.equals(source))
        || await isTeamaiCopy(deployed, { repoPath: localConfig.repo.localPath, pathspec: `docs/${dir}/${file}` });
      if (!unchanged) {
        kept.push(`${dir}/${file}`);
        continue;
      }
      await fs.rm(deployed, { force: true });
      log.debug(`[${localConfig.scope}] Removed ${dir}/${file} of inactive docs namespace "${dir}"`);
    }
    await pruneEmptyDirs(path.join(localDocsDir, dir));
    if (kept.length > 0) {
      log.warn(
        `[${localConfig.scope}] Kept ${kept.length} doc(s) of docs namespace "${dir}", which is not active here: `
        + `they differ from the team copy (${kept.join(', ')} in ${localDocsDir}). Back them up, then delete them manually.`,
      );
    }
  }
}

export class DocsHandler extends ResourceHandler {
  readonly type = 'docs' as const;

  async scanLocalForPush(_teamConfig: TeamaiConfig, _localConfig: LocalConfig): Promise<ResourceItem[]> {
    // Docs are managed directly in team repo
    return [];
  }

  async scanTeamForPull(_teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<ResourceItem[]> {
    const docsDir = path.join(localConfig.repo.localPath, 'docs');
    // Nested documents are synced as part of the same bundle.
    if (await this.countDocFiles(docsDir) === 0) return [];

    return [{
      name: 'docs',
      type: 'docs',
      sourcePath: docsDir,
      relativePath: 'docs/',
    }];
  }

  async countDocFiles(sourcePath: string): Promise<number> {
    return (await listDocFiles(sourcePath)).length;
  }

  async pushItem(_item: ResourceItem, _teamConfig: TeamaiConfig, _localConfig: LocalConfig): Promise<void> {
    // No-op
  }

  /**
   * Mirror the docs this directory receives into the dedicated local
   * directory. `pull` resolves the set once and calls `pullDocs`.
   */
  async pullItem(_item: ResourceItem, teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<void> {
    await this.pullDocs(await resolveDocsForDirectory(localConfig), teamConfig, localConfig);
  }

  /**
   * Mirror `desired` into the dedicated local directory: copy the delivered
   * files, except those that are the member's own (`membersDocs`, named
   * here), remove every visible local entry the team repo does not have, then
   * withdraw the unchanged copies of a namespace not active here (#707).
   * Returns how many files of the member's it kept.
   */
  async pullDocs(desired: DesiredDocs, teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<number> {
    const localDocsDir = resolveDocsDestination(teamConfig, localConfig);
    const src = desired.sourceDir;
    // Validate the source before touching the destination, including an empty bundle.
    const entries = await readEntries(src);
    // A root that is a link is the member's: nothing is copied, pruned or withdrawn through it (#993).
    // It holds the docs back, as a file of the member's does, so the next pull tries again.
    if (await isLinkedDocsRoot(localDocsDir)) {
      log.warn(`[${localConfig.scope}] ${describeLinkedDocsRoot(localDocsDir, 'pull')}`);
      return 1;
    }
    await fse.ensureDir(localDocsDir);
    const destination = await fse.realpath(localDocsDir);
    const repo = await fse.realpath(localConfig.repo.localPath);
    const base = await fse.realpath(resolveBaseDir(localConfig));
    // In single-repo mode the configured docs directory may already be the
    // source. Withdrawing there would delete the team's own files.
    if (destination === path.join(repo, 'docs')) return 0;
    if (containsPath(destination, base) || containsPath(destination, repo) || containsPath(repo, destination)) {
      throw new Error('Docs pruning requires a dedicated localDir that does not overlap the team repo or contain the home or project root.');
    }
    const members = await membersDocs(desired, localDocsDir, localConfig.repo.localPath);
    for (const file of members) {
      log.warn(`[${localConfig.scope}] ${await describeKeptEntry(path.join(localDocsDir, file), `docs/${file}`)}`);
    }
    if (entries.length > 0) {
      await copyDocs(src, localDocsDir, new Set(desired.withheld.map(({ dir }) => dir)), new Set(members));
    }
    // Copy first: a failed copy must not trigger deletion of the previous bundle.
    await pruneDocs(src, localDocsDir, localConfig.repo.localPath, localConfig.scope);
    await withdrawInactiveNamespaces(desired, localDocsDir, localConfig);
    log.debug(`Synced docs → ${localDocsDir}`);
    return members.length;
  }

  async removeItem(_name: string, _teamConfig: TeamaiConfig, _localConfig: LocalConfig): Promise<string[]> {
    log.warn('Removing docs is not supported via remove command. Delete from team repo directly.');
    return [];
  }
}
