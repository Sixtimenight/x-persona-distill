#!/usr/bin/env node
// Usage:
//   node fetch_and_analyze.mjs <handle> [--target 1100] [--out-dir ./personas] [--twitter-bin <path>]
//
// 1. Uses twitter-cli to fetch user profile, recent posts, recent replies (max_id pagination),
//    and historical date-window replies to gather ~target unique non-RT tweets.
// 2. Automatically copies certifi cacert.pem to an ASCII path on Windows if needed (fixes curl error 77).
// 3. Writes <handle>-corpus.json and <handle>-report.txt for LLM distillation into xrb-persona-v1 JSON.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const handleArg = args.find((a) => !a.startsWith('--'));
if (!handleArg) {
  console.error('Usage: node fetch_and_analyze.mjs <handle> [--target 1100] [--out-dir ./personas]');
  process.exit(1);
}

const getOpt = (flag, fallback) => {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
};

const HANDLE = handleArg.replace(/^@+/, '').trim();
const TARGET = Math.max(100, Number(getOpt('--target', '1100')) || 1100);
const OUT_DIR = path.resolve(getOpt('--out-dir', './personas'));
const DEFAULT_BIN = process.platform === 'win32'
  ? path.join(os.homedir(), '.local', 'bin', 'twitter.exe')
  : 'twitter';
const TWITTER_BIN = getOpt('--twitter-bin', DEFAULT_BIN);

fs.mkdirSync(OUT_DIR, { recursive: true });

// Ensure ASCII CA bundle on Windows so libcurl doesn't hit error 77 on non-ASCII homedir
function resolveCaBundle() {
  if (process.env.CURL_CA_BUNDLE && fs.existsSync(process.env.CURL_CA_BUNDLE)) {
    return process.env.CURL_CA_BUNDLE;
  }
  const localCa = path.join(OUT_DIR, 'cacert.pem');
  if (fs.existsSync(localCa)) return localCa;
  if (process.platform === 'win32' && /[^\x00-\x7F]/.test(os.homedir())) {
    const certifiPaths = [
      path.join(os.homedir(), '.local', 'pipx', 'venvs', 'twitter-cli', 'Lib', 'site-packages', 'certifi', 'cacert.pem'),
      path.join(os.homedir(), 'AppData', 'Roaming', 'uv', 'tools', 'twitter-cli', 'Lib', 'site-packages', 'certifi', 'cacert.pem'),
    ];
    for (const src of certifiPaths) {
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, localCa);
        return localCa;
      }
    }
  }
  return '';
}

const caBundle = resolveCaBundle();
const ENV = {
  ...process.env,
  ...(caBundle ? { CURL_CA_BUNDLE: caBundle, SSL_CERT_FILE: caBundle } : {}),
};

const CORPUS_FILE = path.join(OUT_DIR, `${HANDLE.toLowerCase()}-corpus.json`);
const REPORT_FILE = path.join(OUT_DIR, `${HANDLE.toLowerCase()}-report.txt`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const byId = new Map();

function ingest(arr, sourceTag) {
  let added = 0;
  for (const t of Array.isArray(arr) ? arr : []) {
    if (!t?.id || t.isRetweet) continue;
    const screen = t.author?.screenName || '';
    if (screen && screen.toLowerCase() !== HANDLE.toLowerCase()) continue;
    if (!byId.has(t.id)) {
      byId.set(t.id, { ...t, _source: sourceTag });
      added += 1;
    }
  }
  return added;
}

if (fs.existsSync(CORPUS_FILE)) {
  try {
    ingest(JSON.parse(fs.readFileSync(CORPUS_FILE, 'utf8')), 'cached');
  } catch (_) {}
}

function runTwitter(cliArgs) {
  const out = execFileSync(TWITTER_BIN, cliArgs, {
    env: ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}

function saveCorpus() {
  const arr = [...byId.values()].sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
  fs.writeFileSync(CORPUS_FILE, JSON.stringify(arr, null, 2), 'utf8');
  return arr;
}

// 1. Fetch profile
let profile = null;
try {
  const res = runTwitter(['user', HANDLE, '--json']);
  profile = res.data || res;
  console.log(`Profile: ${profile.name} (@${profile.screenName}) | tweets=${profile.tweets} | followers=${profile.followers}`);
} catch (err) {
  console.warn('Profile fetch failed:', err.message.slice(0, 160));
}

// 2. Fetch recent original posts (up to 200)
if (byId.size < TARGET) {
  try {
    const res = runTwitter(['user-posts', HANDLE, '-n', '200', '--json']);
    const list = Array.isArray(res) ? res : (res.data || []);
    const added = ingest(list, 'post');
    saveCorpus();
    console.log(`[user-posts] fetched=${list.length} added=${added} total=${byId.size}`);
  } catch (err) {
    console.warn('[user-posts] error:', err.message.slice(0, 160));
  }
}

// 3. Paginate replies (recent + historical windows)
async function fetchWindow(label, baseQuery, pages) {
  let maxId = null;
  for (let i = 0; i < pages; i++) {
    if (byId.size >= TARGET) return;
    const q = maxId ? `${baseQuery} max_id:${maxId}` : baseQuery;
    try {
      const res = runTwitter(['search', q, '-t', 'latest', '-n', '100', '--json']);
      const tweets = Array.isArray(res) ? res : (res.data || []);
      if (!tweets.length) break;
      let minId = null;
      for (const t of tweets) {
        if (!t?.id) continue;
        const bid = BigInt(t.id);
        if (minId === null || bid < minId) minId = bid;
      }
      const added = ingest(tweets, 'reply');
      saveCorpus();
      console.log(`[${label}] page ${i + 1}/${pages}: fetched=${tweets.length} added=${added} total=${byId.size} oldest=${tweets[tweets.length - 1]?.createdAtISO || ''}`);
      if (minId === null) break;
      const nextMax = (minId - 1n).toString();
      if (nextMax === maxId) break;
      maxId = nextMax;
      await sleep(1500);
    } catch (err) {
      console.warn(`[${label}] page ${i + 1} error:`, err.message.slice(0, 180));
      await sleep(4000);
      break;
    }
  }
}

await fetchWindow('recent', `from:${HANDLE} filter:replies`, 14);

const now = Date.now();
for (const daysAgo of [10, 20, 35, 55, 80]) {
  if (byId.size >= TARGET) break;
  const d = new Date(now - daysAgo * 86400_000).toISOString().slice(0, 10);
  await fetchWindow(`until-${d}`, `from:${HANDLE} filter:replies until:${d}`, 3);
}

const corpus = saveCorpus();

// 4. Analyze corpus and write report
function cleanText(text) {
  return String(text || '')
    .replace(/^(?:@[A-Za-z0-9_]+\s+)+/, '')
    .replace(/https?:\/\/t\.co\/\S+/g, '')
    .trim();
}

const items = corpus.map((t) => ({
  ...t,
  isReply: t._source === 'reply' || /^@[A-Za-z0-9_]+/.test(t.text || ''),
  clean: cleanText(t.text),
})).filter((t) => t.clean.length > 0);

const replies = items.filter((t) => t.isReply);
const posts = items.filter((t) => !t.isReply);
const dates = items.map((t) => t.createdAtISO).filter(Boolean).sort();
const rLens = replies.map((t) => [...t.clean].length).sort((a, b) => a - b);
const avg = (arr) => arr.length ? (arr.reduce((s, x) => s + x, 0) / arr.length).toFixed(1) : '0';
const pct = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0;

const emojiRe = /\p{Extended_Pictographic}/gu;
const emojiCount = new Map();
let withEmoji = 0; let endPeriod = 0; let hasNl = 0; let hasQ = 0; let hasExcl = 0; let hasTilde = 0; let enReplies = 0;

for (const t of replies) {
  const s = t.clean;
  const emojis = s.match(emojiRe) || [];
  if (emojis.length) withEmoji++;
  for (const e of emojis) emojiCount.set(e, (emojiCount.get(e) || 0) + 1);
  if (/[。.]$/.test(s)) endPeriod++;
  if (/\n/.test(s)) hasNl++;
  if (/[?？]/.test(s)) hasQ++;
  if (/[!！]/.test(s)) hasExcl++;
  if (/[~～]/.test(s)) hasTilde++;
  if (!/[\u4e00-\u9fff]/.test(s) && /[a-zA-Z]{3,}/.test(s)) enReplies++;
}

const topEmojis = [...emojiCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);

const out = [];
out.push(`=== PERSONA ANALYSIS REPORT: @${HANDLE} ===`);
if (profile) {
  out.push(`Name: ${profile.name}`);
  out.push(`Bio: ${String(profile.bio || '').replace(/\n+/g, ' | ')}`);
  out.push(`Followers: ${profile.followers} | Total tweets: ${profile.tweets}`);
}
out.push(`Analyzed: ${items.length} unique non-RT items (replies: ${replies.length}, posts: ${posts.length})`);
out.push(`Date range: ${dates[0] || ''} -> ${dates[dates.length - 1] || ''}`);
out.push(`Reply length: avg=${avg(rLens)}, p25=${pct(rLens, 0.25)}, median=${pct(rLens, 0.5)}, p75=${pct(rLens, 0.75)}, p90=${pct(rLens, 0.9)}`);
if (replies.length) {
  const p = (n) => `${(n / replies.length * 100).toFixed(1)}%`;
  out.push(`Style rates: emoji=${p(withEmoji)}, endPeriod=${p(endPeriod)}, newline=${p(hasNl)}, question=${p(hasQ)}, excl=${p(hasExcl)}, tilde=${p(hasTilde)}, pureEnglish=${p(enReplies)}`);
}
out.push(`Top emojis: ${topEmojis.map(([e, c]) => `${e}:${c}`).join('  ')}`);

out.push(`\n=== TOP 40 SUBSTANTIVE POSTS (BY LIKES) ===`);
for (const t of [...posts].sort((a, b) => (b.metrics?.likes || 0) - (a.metrics?.likes || 0)).slice(0, 40)) {
  out.push(`  [P|L${t.metrics?.likes || 0}] ${t.clean.replace(/\n+/g, ' ⏎ ').slice(0, 220)}`);
}

out.push(`\n=== TOP 40 OPINIONATED REPLIES (LEN >= 15, BY LIKES) ===`);
for (const t of replies.filter((r) => [...r.clean].length >= 15).sort((a, b) => (b.metrics?.likes || 0) - (a.metrics?.likes || 0)).slice(0, 40)) {
  out.push(`  [R|L${t.metrics?.likes || 0}] ${t.clean.replace(/\n+/g, ' ⏎ ').slice(0, 180)}`);
}

out.push(`\n=== 60 SAMPLED CONVERSATIONAL REPLIES (ACROSS TIME) ===`);
const step = Math.max(1, Math.floor(replies.length / 60));
for (let i = 0; i < replies.length; i += step) {
  const t = replies[i];
  out.push(`  [${t.createdAtISO?.slice(0, 10) || ''}] ${t.clean.replace(/\n+/g, ' ⏎ ').slice(0, 120)}`);
}

fs.writeFileSync(REPORT_FILE, out.join('\n') + '\n', 'utf8');
console.log(`Saved corpus: ${CORPUS_FILE}`);
console.log(`Saved report: ${REPORT_FILE}`);
