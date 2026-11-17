// P0-8: what can be checked about the CI workflow without running it.
//
// Derived from "P0-8 acceptance criteria" in docs/saas/IMPLEMENTATION_STATUS.md:
//   - a CI job runs e2e/rls_e2e.py, e2e/data_logger_e2e.py and
//     e2e/offline_sync_e2e.py against staging, taking DRILL_E2E_SUPABASE_URL,
//     DRILL_E2E_PUBLISHABLE_KEY and DRILL_E2E_PASSWORD from repository
//     secrets, and installs Python Playwright and Chromium;
//   - without the secrets (a pull request from a fork) the job is skipped
//     with a message that says so, and never reports success for tests it
//     did not run. Changed by P0-11 (RF-065, "P0-11 acceptance criteria"):
//     the staging e2e job is preceded by a small job that reports whether the
//     secrets are available; the e2e job has a job-level `if` on that output,
//     so without secrets GitHub shows it as skipped, not as passed; the
//     message that the suites were not run stays;
//   - the job has no production credentials;
//   - actions stay pinned to commit SHAs.
//
// .github/workflows/ci.yml is read as text (no YAML dependency). The checks
// lean on indentation only to split the file into jobs; everything else is
// a search of the job's text with comments removed. The job that runs the
// suites is found by behaviour: its `name:` mentions both e2e and staging.
// The small job before it is found through the e2e job's own `if:`.
// The production ref is read from scripts/hooks/guard.conf, never written here.
//
// Run: node --test "scripts/**/*.test.mjs"

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const WORKFLOW_PATH = join(REPO, '.github', 'workflows', 'ci.yml');
const RAW = readFileSync(WORKFLOW_PATH, 'utf8');

const E2E_SECRETS = ['DRILL_E2E_SUPABASE_URL', 'DRILL_E2E_PUBLISHABLE_KEY', 'DRILL_E2E_PASSWORD'];
const SUITES = ['e2e/rls_e2e.py', 'e2e/data_logger_e2e.py', 'e2e/offline_sync_e2e.py'];

/** A ref from guard.conf: KEY=value, optional quotes, optional trailing comment. Null when absent or empty. */
function confRef(key) {
  const conf = readFileSync(join(REPO, 'scripts', 'hooks', 'guard.conf'), 'utf8');
  let value = null;
  for (const line of conf.split(/\r?\n/)) {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`).exec(line);
    if (!match) continue;
    value = match[1].replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return value ? value : null;
}

/** Drop whole-line comments and trailing ` # ...` comments (good enough for this file: no '#' inside a checked value). */
function withoutComments(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.replace(/\s+#\s.*$/, ''))
    .join('\n');
}

const indentOf = (line) => /^ */.exec(line)[0].length;

/** The lines under a top-level `key:` up to the next top-level key. */
function topLevelBlock(text, key) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^${key}:`).test(line));
  if (start === -1) return null;
  const block = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && indentOf(line) === 0) break;
    block.push(line);
  }
  return block;
}

/** Split the `jobs:` block into [{ key, name, text }] by the indentation of the first job key. */
function jobsOf(text) {
  const block = topLevelBlock(text, 'jobs');
  if (!block) return [];
  const body = block.slice(1);
  const first = body.find((line) => line.trim() !== '');
  if (!first) return [];
  const jobIndent = indentOf(first);
  const jobs = [];
  for (const line of body) {
    const key = line.trim() !== '' && indentOf(line) === jobIndent ? /^\s*([A-Za-z0-9_-]+):/.exec(line) : null;
    if (key) jobs.push({ key: key[1], lines: [] });
    else if (jobs.length > 0) jobs.at(-1).lines.push(line);
  }
  return jobs.map(({ key, lines }) => {
    const nameLine = lines.find((line) => /^\s*name:/.test(line) && indentOf(line) > jobIndent);
    const name = nameLine ? nameLine.replace(/^\s*name:\s*/, '').trim().replace(/^(['"])(.*)\1$/, '$2') : '';
    return { key, name, text: lines.join('\n') };
  });
}

const TEXT = withoutComments(RAW);
const JOBS = jobsOf(TEXT);
const isStagingJob = (job) => /e2e/i.test(job.name) && /staging/i.test(job.name);
const STAGING_JOBS = JOBS.filter(isStagingJob);

/** The lines of a job that sit at the job's own property level (`name:`, `needs:`, `if:`, `steps:` ...). */
function jobLevelLines(job) {
  const lines = job.text.split('\n').filter((line) => line.trim() !== '');
  const level = Math.min(...lines.map(indentOf));
  return lines.filter((line) => indentOf(line) === level).map((line) => line.trim());
}

/** The value of a job-level key written on one line, or null. */
function jobLevelValue(job, key) {
  const line = jobLevelLines(job).find((candidate) => candidate.startsWith(`${key}:`));
  return line ? line.slice(key.length + 1).trim() : null;
}

/** { key, output } named by `needs.<key>.outputs.<output>` in the staging job's job-level `if:`, or null. */
function probeReference() {
  if (STAGING_JOBS.length !== 1) return null;
  const condition = jobLevelValue(STAGING_JOBS[0], 'if');
  const match = condition ? /\bneeds\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)/.exec(condition) : null;
  return match ? { key: match[1], output: match[2] } : null;
}

const PROBE_REF = probeReference();
const isProbeJob = (job) => PROBE_REF !== null && job.key === PROBE_REF.key && !isStagingJob(job);
// Changed for RF-065 (P0-11): the small job that reports on the secrets is not one of the "other" jobs.
const OTHER_JOBS = JOBS.filter((job) => !isStagingJob(job) && !isProbeJob(job));

/** The one staging job, or a failed assertion that says what is missing. */
function stagingJob() {
  assert.equal(
    STAGING_JOBS.length,
    1,
    `expected exactly one job whose name mentions e2e and staging; job names: ${JSON.stringify(JOBS.map((job) => job.name))}`,
  );
  return STAGING_JOBS[0];
}

/** The small job the staging job's `if:` refers to, or a failed assertion that says what is missing. */
function probeJob() {
  const staging = stagingJob();
  assert.ok(
    PROBE_REF,
    `the staging job has no job-level \`if:\` that refers to needs.<job>.outputs.<name>; its job-level lines: ${JSON.stringify(jobLevelLines(staging))}`,
  );
  const job = JOBS.find((candidate) => candidate.key === PROBE_REF.key);
  assert.ok(job, `no job with the key ${PROBE_REF.key}; job keys: ${JSON.stringify(JOBS.map((candidate) => candidate.key))}`);
  assert.notEqual(job.key, staging.key, 'the staging job refers to its own output');
  return job;
}

describe('P0-8: the workflow parser sees the file as it is', () => {
  it('finds the jobs, each with a name', () => {
    assert.ok(JOBS.length >= 2, `found ${JOBS.length} job(s)`);
    for (const job of JOBS) assert.notEqual(job.name, '', `job ${job.key} has no name`);
  });

  it('comment removal keeps the action references and drops their version comments', () => {
    assert.match(TEXT, /uses:\s*actions\/checkout@[0-9a-f]{40}\s*$/m);
    assert.ok(!/^\s*#/m.test(TEXT));
  });
});

describe('P0-8: actions stay pinned to commit SHAs', () => {
  const uses = [...TEXT.matchAll(/^\s*(?:-\s*)?uses:\s*(.+?)\s*$/gm)].map((match) => match[1].replace(/^(['"])(.*)\1$/, '$2'));

  it('the workflow uses at least one action', () => {
    assert.ok(uses.length > 0);
  });

  it('every `uses:` reference ends in a 40-character commit SHA', () => {
    const unpinned = uses.filter((ref) => !/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(ref));
    assert.deepEqual(unpinned, [], 'not pinned to a commit SHA (a tag, a branch, a local path or a docker reference)');
  });
});

describe('P0-8: the token GitHub issues stays read-only', () => {
  it('workflow-level permissions are exactly `contents: read`', () => {
    const block = topLevelBlock(TEXT, 'permissions');
    assert.ok(block, 'no top-level permissions block');
    const inline = block[0].replace(/^permissions:\s*/, '').trim();
    const entries = block.slice(1).map((line) => line.trim()).filter(Boolean);
    if (inline !== '') {
      assert.match(inline, /^\{\s*contents:\s*read\s*\}$/, `permissions: ${inline}`);
      assert.deepEqual(entries, []);
    } else {
      assert.equal(entries.length, 1, `permissions entries: ${JSON.stringify(entries)}`);
      assert.match(entries[0], /^contents:\s*read$/);
    }
  });

  it('no job widens it: nothing in the workflow grants write', () => {
    const lines = TEXT.split('\n').filter((line) => /^\s*[a-z-]+:\s*write\s*$/.test(line) || /write-all/.test(line));
    assert.deepEqual(lines, []);
  });
});

describe('P0-8: the existing jobs still do their work', () => {
  it('a job other than the staging one runs scripts/gate.sh full', () => {
    assert.ok(OTHER_JOBS.some((job) => /^\s*(?:-\s*)?run:.*scripts\/gate\.sh full\s*$/m.test(job.text)), 'no job runs scripts/gate.sh full');
  });

  it('a job other than the staging one checks row level security in the catalog and fails when a table has it off', () => {
    const job = OTHER_JOBS.find((candidate) => /relrowsecurity\s*=\s*false/.test(candidate.text));
    assert.ok(job, 'no job queries pg_class.relrowsecurity');
    assert.match(job.text, /exit 1/);
    assert.match(job.text, /supabase db start/);
  });

  it('the same job still checks that every migration file is recorded as applied', () => {
    const job = OTHER_JOBS.find((candidate) => /relrowsecurity/.test(candidate.text));
    assert.ok(job, 'no catalog job');
    assert.match(job.text, /supabase_migrations\.schema_migrations/);
  });

  // Changed for RF-065 (P0-11). Before: no job other than the staging one
  // read a secret. Now the small job that reports whether the secrets are
  // available reads one, by design; every job other than that one and the
  // staging job - the gate and the catalog job among them - still reads none.
  it('the gate job and the catalog job are two jobs, and neither is given a secret', () => {
    const gate = OTHER_JOBS.find((job) => /scripts\/gate\.sh full/.test(job.text));
    const catalog = OTHER_JOBS.find((job) => /relrowsecurity/.test(job.text));
    assert.ok(gate && catalog, 'one of the two jobs is missing');
    assert.notEqual(gate.key, catalog.key);
    for (const job of OTHER_JOBS) {
      assert.ok(!/\bsecrets\./.test(job.text), `job ${job.key} reads a secret`);
    }
  });

  it('P0-11 RF-065: only the staging job and the job that reports on the secrets read a secret, and those are two of at least four jobs', () => {
    const readers = JOBS.filter((job) => /\bsecrets\./.test(job.text)).map((job) => job.key).sort();
    const allowed = [stagingJob().key, probeJob().key].sort();
    assert.deepEqual(readers.filter((key) => !allowed.includes(key)), []);
    assert.ok(JOBS.length >= 4, `found ${JOBS.length} job(s)`);
  });
});

describe('P0-8: a job runs the suites against staging (red until the job exists)', () => {
  it('exactly one job is named for it: the name mentions e2e and staging', () => {
    stagingJob();
  });

  for (const secret of E2E_SECRETS) {
    it(`it takes ${secret} from the repository secrets`, () => {
      const job = stagingJob();
      assert.match(job.text, new RegExp(`\\$\\{\\{\\s*secrets\\.${secret}\\s*\\}\\}`), `secrets.${secret} is not referenced in the job`);
    });
  }

  for (const suite of SUITES) {
    it(`it runs ${suite}`, () => {
      const job = stagingJob();
      const pattern = new RegExp(`python[\\d.]*\\s+(?:-\\S+\\s+)*(?:\\./)?${suite.replace(/[./]/g, '\\$&')}(?![\\w.])`);
      assert.match(job.text, pattern, `no python call of ${suite} in the job`);
    });
  }

  it('it installs what the browser suite needs: Python Playwright and Chromium', () => {
    const job = stagingJob();
    assert.match(job.text, /pip3?\s+install\b[^\n]*\bplaywright\b/, 'Playwright for Python is not installed with pip');
    assert.match(job.text, /playwright\s+install\b[^\n]*\bchromium\b/, 'Chromium is not installed with `playwright install`');
  });

  // P0-14: `ubuntu-latest` moved to an image the pinned Playwright cannot
  // install Chromium on. The job that runs the suites names a versioned image,
  // so the Playwright pin and the OS move together. The other jobs are not
  // asserted on: they may stay on ubuntu-latest.
  it('P0-14: it runs on a fixed, versioned runner image (ubuntu-<NN>.<NN>), not ubuntu-latest', () => {
    const job = stagingJob();
    const raw = jobLevelValue(job, 'runs-on');
    assert.ok(raw, `no job-level \`runs-on:\` written on one line in the staging job; its job-level lines: ${JSON.stringify(jobLevelLines(job))}`);
    const image = raw.replace(/^(['"])(.*)\1$/, '$2');
    assert.ok(!/latest/i.test(image), `runs-on: ${raw} is a moving label`);
    assert.match(image, /^ubuntu-\d{2}\.\d{2}$/, `runs-on: ${raw} is not a single versioned image (an expression, a matrix value or a label list cannot be checked here)`);
  });

  it('P0-14: no other `runs-on:` inside the job overrides that image', () => {
    const job = stagingJob();
    const all = job.text.split('\n').filter((line) => /^\s*(?:-\s*)?runs-on:/.test(line));
    assert.equal(all.length, 1, `runs-on lines in the staging job: ${JSON.stringify(all.map((line) => line.trim()))}`);
  });

  it('its actions are pinned like the others', () => {
    const job = stagingJob();
    const uses = [...job.text.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map((match) => match[1]);
    assert.ok(uses.length > 0, 'the job checks nothing out');
    for (const ref of uses) assert.match(ref, /@[0-9a-f]{40}$/);
  });
});

// Changed for RF-065 (P0-11). Before: the staging job itself tested the URL
// secret and printed the "skipped" message, so without secrets it ended as a
// green check. Now a small job reports whether the secrets are available and
// the staging job has a job-level `if:` on that output, so GitHub shows it as
// skipped. The emptiness check and the message moved with it.
describe('P0-11 RF-065: without the secrets the e2e job is skipped, not passed', () => {
  it('the e2e job has a job-level `if:` that refers to another job\'s output through `needs.`', () => {
    const job = stagingJob();
    const condition = jobLevelValue(job, 'if');
    assert.ok(condition, `no job-level \`if:\` in the staging job; its job-level lines: ${JSON.stringify(jobLevelLines(job))}`);
    assert.match(condition, /\bneeds\.[A-Za-z0-9_-]+\.outputs\.[A-Za-z0-9_-]+/, `if: ${condition}`);
  });

  it('that `if:` cannot be true regardless of the output: no always(), no ||, no negation of the output', () => {
    const condition = jobLevelValue(stagingJob(), 'if') ?? '';
    assert.ok(!/\balways\s*\(/.test(condition), `if: ${condition}`);
    assert.ok(!/\|\|/.test(condition), `if: ${condition}`);
    assert.ok(!/!\s*\(?\s*needs\./.test(condition), `if: ${condition}`);
    assert.ok(!/outputs\.[A-Za-z0-9_-]+\s*!=/.test(condition), `if: ${condition}`);
  });

  it('the e2e job lists that job under `needs:`', () => {
    const job = stagingJob();
    const probe = probeJob();
    const lines = job.text.split('\n');
    const at = lines.findIndex((line) => /^\s*needs:/.test(line));
    assert.notEqual(at, -1, 'the staging job has no `needs:`');
    const level = indentOf(lines[at]);
    const block = [lines[at]];
    for (const line of lines.slice(at + 1)) {
      if (line.trim() !== '' && indentOf(line) <= level) break;
      block.push(line);
    }
    const named = new RegExp(`(?:^|[\\s,\\['"-])${probe.key}(?:$|[\\s,\\]'"])`, 'm');
    assert.match(block.join('\n').replace(/^\s*needs:/, ' '), named, `needs: does not name ${probe.key}`);
  });

  it('the job it refers to is a small job of its own: it runs none of the suites and installs nothing', () => {
    const probe = probeJob();
    for (const suite of SUITES) assert.ok(!probe.text.includes(suite), `the job ${probe.key} runs ${suite}`);
    assert.ok(!/\b(?:npm ci|npm install|pip3? install|playwright install)\b/.test(probe.text), `the job ${probe.key} installs something`);
    assert.ok(!/scripts\/gate\.sh/.test(probe.text), `the job ${probe.key} runs the gate`);
  });

  it('that job always runs: it has no job-level `if:` and needs no other job', () => {
    const probe = probeJob();
    assert.equal(jobLevelValue(probe, 'if'), null, 'a conditional probe job can be skipped itself');
    assert.ok(!jobLevelLines(probe).some((line) => line.startsWith('needs:')), 'the probe job waits for another job');
  });

  it('that job declares the output the `if:` reads, and a step writes it to GITHUB_OUTPUT', () => {
    const probe = probeJob();
    assert.ok(jobLevelLines(probe).some((line) => line.startsWith('outputs:')), `the job ${probe.key} has no job-level outputs:`);
    assert.match(probe.text, new RegExp(`^\\s+${PROBE_REF.output}:\\s*\\$\\{\\{\\s*steps\\.[A-Za-z0-9_-]+\\.outputs\\.[A-Za-z0-9_-]+\\s*\\}\\}\\s*$`, 'm'),
      `the output ${PROBE_REF.output} is not taken from a step`);
    assert.match(probe.text, />>\s*"?\$\{?GITHUB_OUTPUT\}?"?/, 'no step writes to GITHUB_OUTPUT');
  });

  it('that job writes both answers: one value with the secrets and another without', () => {
    const probe = probeJob();
    const written = [...probe.text.matchAll(/echo\s+["']?([A-Za-z0-9_-]+)=([^"'\s]+)["']?\s*>>\s*"?\$\{?GITHUB_OUTPUT/g)].map((match) => match[2]);
    assert.ok(new Set(written).size >= 2, `values written to GITHUB_OUTPUT: ${JSON.stringify(written)}`);
  });

  // Was "P0-8: there is a check on the URL secret being empty or not", asserted on the staging job.
  it('that job tests whether the URL secret is empty', () => {
    const probe = probeJob();
    const shellTest = /-[zn]\s+"?\$\{?DRILL_E2E_SUPABASE_URL\b/;
    const expression = /DRILL_E2E_SUPABASE_URL\s*(?:\}\})?\s*[!=]=\s*(?:''|"")/;
    assert.ok(
      shellTest.test(probe.text) || expression.test(probe.text),
      `nothing in the job ${probe.key} tests whether DRILL_E2E_SUPABASE_URL is empty`,
    );
    assert.match(probe.text, /\$\{\{\s*secrets\.DRILL_E2E_SUPABASE_URL\s*\}\}/, 'the URL secret is not given to the job');
  });

  // Was "P0-8: there is a message that says the suites were skipped or the
  // secrets are not available", asserted on the staging job. A skipped job
  // prints nothing, so the message has to be in a job that runs.
  it('the message that the suites were skipped or the secrets are not available is still there, in a job that runs without the secrets', () => {
    const staging = stagingJob();
    const elsewhere = JOBS.filter((job) => job.key !== staging.key);
    const lines = elsewhere.flatMap((job) => job.text.split('\n')).filter((line) => /\bskipped\b|\bnot available\b/i.test(line));
    assert.ok(lines.length > 0, 'no message with "skipped" or "not available" outside the staging job');
    assert.ok(lines.some((line) => /\becho\b|>>|::(?:warning|notice|error)/.test(line)), 'the words are there but nothing prints them');
  });

  it('the job that reports on the secrets cannot hide its own failure: no continue-on-error and no `|| true`', () => {
    const probe = probeJob();
    assert.ok(!/continue-on-error:\s*true/.test(probe.text), 'continue-on-error: true in the probe job');
    assert.ok(!/\|\|\s*(?:true|:)\s*$/m.test(probe.text), 'a command in the probe job has its failure discarded');
  });

  // Unchanged from P0-8.
  it('a failing suite cannot be reported as success: no continue-on-error and no `|| true` in the job', () => {
    const job = stagingJob();
    assert.ok(!/continue-on-error:\s*true/.test(job.text), 'continue-on-error: true in the staging job');
    assert.ok(!/\|\|\s*(?:true|:)\s*$/m.test(job.text), 'a command in the staging job has its failure discarded');
  });

  it('the three suites run in the e2e job and in no other job', () => {
    const staging = stagingJob();
    for (const suite of SUITES) {
      assert.ok(staging.text.includes(suite), `${suite} is not in the staging job`);
      for (const job of JOBS.filter((candidate) => candidate.key !== staging.key)) {
        assert.ok(!job.text.includes(suite), `${suite} is also named in the job ${job.key}`);
      }
    }
  });
});

describe('P0-8: the workflow holds no production credentials', () => {
  it('guard.conf gives a production ref to look for', () => {
    assert.match(confRef('PROD_REF') ?? '', /^[A-Za-z0-9_-]+$/);
  });

  it('the production project ref appears nowhere in the workflow, comments included', () => {
    const prod = confRef('PROD_REF');
    assert.ok(prod, 'PROD_REF could not be read');
    assert.ok(!RAW.toLowerCase().includes(prod.toLowerCase()), 'the production ref is in the workflow');
  });

  it('no project host is written into the workflow: the URL comes from the secret', () => {
    const staging = confRef('STAGING_REF');
    if (staging) assert.ok(!RAW.toLowerCase().includes(staging.toLowerCase()), 'the staging ref is written into the workflow');
    assert.ok(!/[a-z0-9]{20}\.supabase\.(?:co|in)\b/i.test(RAW), 'a Supabase project host is written into the workflow');
  });

  it('no service-role or secret key name anywhere, comments included', () => {
    assert.ok(!/SUPABASE_SERVICE_ROLE/i.test(RAW), 'SUPABASE_SERVICE_ROLE is named in the workflow');
    assert.ok(!/SERVICE_ROLE_KEY/i.test(RAW), 'a service-role key is named in the workflow');
    assert.ok(!/sb_secret/i.test(RAW), 'sb_secret is named in the workflow');
  });

  it('the only secrets the workflow reads are the three e2e ones', () => {
    const read = [...new Set([...RAW.matchAll(/\bsecrets\.([A-Za-z0-9_]+)/g)].map((match) => match[1]))];
    const unexpected = read.filter((name) => !E2E_SECRETS.includes(name));
    assert.deepEqual(unexpected, []);
    assert.ok(!/\bsecrets\s*\[/.test(RAW), 'a secret is read by index, which this check cannot name');
    assert.ok(!/secrets:\s*inherit/.test(RAW), 'secrets: inherit passes every secret');
    assert.ok(!/toJSON\(\s*secrets\s*\)/i.test(RAW), 'toJSON(secrets) exposes every secret');
  });
});
