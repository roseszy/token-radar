// Token Radar: the entrypoint (Node 22, standard library only).
//
// Reads the sealed snapshot from /input/snapshot.json (or --input <file|dir>), scores every
// pre-token protocol with the model in lib/model.ts, writes the ranked board to
// /output/board.json, writes the dashboard's data beside the page as /output/data.js, copies
// this repository's dashboard/ and screenshots/ into /output, and writes /output/dossier.json
// with buildDossier from the vendored make.fun library. The run is deterministic: two runs
// write the same bytes.
//
// The dashboard is a static page, no framework and no network: dashboard/index.html, app.css
// and app.js read /output/data.js, which this program writes from the same board.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const repoDir = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps: the text cap shapes the bytes, the rest refuse. */
const DOSSIER_TEXT_CAP = 65_536;
const SHOT_CAPS = { max: 4, max_bytes: 524_288 };
const SHOT_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** The value of `--name <value>` (or `--name=<value>`) in the arguments, else `fallback`. */
function flagValue(name: string, fallback: string): string {
  const flag = `--${name}`;
  const at = process.argv.indexOf(flag);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const joined = process.argv.find((a) => a.startsWith(`${flag}=`));
  return joined === undefined ? fallback : joined.slice(flag.length + 1);
}

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyDirectory(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

/** Write a message to stderr and leave with `code`. */
function fail(message: string, code: number): never {
  process.stderr.write(`token radar: ${message}\n`);
  process.exit(code);
}

function main(): void {
  const inputGiven = flagValue('input', '/input');
  const snapshotFile = inputGiven.endsWith('.json') ? inputGiven : join(inputGiven, 'snapshot.json');
  if (!existsSync(snapshotFile)) {
    fail(`no snapshot at ${snapshotFile}: pass --input <snapshot.json|directory> or mount the sealed /input`, 2);
  }
  const outputDir = flagValue('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

  const sealed = parseSnapshot(readFileSync(snapshotFile, 'utf8'));
  const { board, radar } = buildRadar(sealed);
  const problem = boardIssue(board, sealed);
  if (problem !== null) fail(`the model wrote a board the gate refuses: ${problem}`, 1);

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
  writeFileSync(join(outputDir, 'data.js'), dataScript(radar));

  const dashboardCopied = copyDirectory(join(repoDir, 'dashboard'), join(outputDir, 'dashboard'));
  if (dashboardCopied.length < 3) {
    fail(`dashboard/ holds ${dashboardCopied.length} file${dashboardCopied.length === 1 ? '' : 's'}: hand in index.html, app.css and app.js at least`, 1);
  }
  const shotsCopied = copyDirectory(join(repoDir, 'screenshots'), join(outputDir, 'screenshots'));
  if (shotsCopied.length < 3) {
    fail(`screenshots/ holds ${shotsCopied.length} image${shotsCopied.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view`, 1);
  }
  for (const name of shotsCopied) {
    if (!SHOT_NAME_PATTERN.test(name)) {
      fail(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`, 1);
    }
  }

  // The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
  writeFileSync(
    join(outputDir, 'dossier.json'),
    buildDossier(outputDir, { text_max_bytes: DOSSIER_TEXT_CAP, screenshots: SHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }),
  );

  const lines = [
    `token radar: ${sealed.protocols.length} protocols, ${sealed.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)`,
    `token radar: wrote ${join(outputDir, 'board.json')}, ${join(outputDir, 'data.js')}, ${join(outputDir, 'dashboard')} (${dashboardCopied.length} files), ${join(outputDir, 'screenshots')} (${shotsCopied.length} images) and ${join(outputDir, 'dossier.json')}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

main();
