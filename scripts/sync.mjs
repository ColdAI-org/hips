#!/usr/bin/env node
// Keeps this showcase in step with hiero-ledger/hiero-improvement-proposals.
//
//   node scripts/sync.mjs            fetch every HIP pull request by the configured authors, snapshot each
//                                    proposal into proposals/, write data/hips.json, and regenerate the
//                                    generated parts of README.md
//   node scripts/sync.mjs --render   regenerate README.md from data/hips.json only (no network)
//   node scripts/sync.mjs --check    as --render, but fail if README.md would change (used in CI)
//
// Uses the GitHub REST API. Set GITHUB_TOKEN to raise the rate limit; no write access is needed. Node 20+, no
// dependencies.
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.github.com";
const mode = process.argv.includes("--check") ? "check" : process.argv.includes("--render") ? "render" : "sync";

const readJson = async (p) => JSON.parse(await readFile(join(ROOT, p), "utf8"));
const curated = await readJson("data/curated.json");

async function gh(path) {
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "coldai-hips-sync" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(path.startsWith("http") ? path : `${API}${path}`, { headers });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
  return res.json();
}

async function ghAll(path) {
  const out = [];
  for (let page = 1; ; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const batch = await gh(`${path}${sep}per_page=100&page=${page}`);
    const items = Array.isArray(batch) ? batch : batch.items;
    out.push(...items);
    if (items.length < 100) return out;
  }
}

/** Splits a HIP file into its YAML-style front matter (flat key: value lines) and body. */
function parseHip(text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z-]+):\s*(.*?)\s*(#.*)?$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return { meta, body: m[2] };
}

function section(body, heading) {
  const re = new RegExp(`^## ${heading}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m");
  return (re.exec(body)?.[1] ?? "").trim();
}

/** Rewrites relative links so a snapshot still resolves outside the HIP repository. */
function rewriteLinks(body, base) {
  return body.replace(/\]\((?!https?:|mailto:|#)([^)\s]+)\)/g, (_, rel) => {
    const [path, anchor] = rel.split("#");
    const resolved = posix.normalize(posix.join("HIP", path));
    return `](${base}/${resolved}${anchor ? `#${anchor}` : ""})`;
  });
}

const isBot = (login) => /\[bot\]$|automation/i.test(login ?? "");

async function sync() {
  const q = curated.authors.map((a) => `author:${a}`).join("+");
  const found = await ghAll(`/search/issues?q=repo:${curated.repo}+is:pr+${q}`);
  const records = [];
  await rm(join(ROOT, "proposals"), { recursive: true, force: true });
  await mkdir(join(ROOT, "proposals"), { recursive: true });

  for (const item of found.sort((a, b) => b.number - a.number)) {
    const n = item.number;
    const pr = await gh(`/repos/${curated.repo}/pulls/${n}`);
    const files = await ghAll(`/repos/${curated.repo}/pulls/${n}/files`);
    const reviews = await ghAll(`/repos/${curated.repo}/pulls/${n}/reviews`);
    const comments = await ghAll(`/repos/${curated.repo}/issues/${n}/comments`);
    const hipFile = files.find((f) => /^HIP\/hip-.*\.md$/.test(f.filename) && f.status !== "removed");
    if (!hipFile) continue;

    const headRepo = pr.head.repo?.full_name ?? curated.repo;
    const sha = pr.head.sha;
    const raw = await fetch(`https://raw.githubusercontent.com/${headRepo}/${sha}/${hipFile.filename}`).then((r) => r.text());
    const { meta, body } = parseHip(raw);
    const isNew = /^HIP\/hip-0000-/.test(hipFile.filename) || hipFile.status === "added";
    const kind = isNew ? "proposal" : "contribution";

    const rec = {
      pr: n,
      kind,
      title: kind === "proposal" ? meta.title ?? pr.title : pr.title,
      hip: meta.hip && meta.hip !== "0000" ? `HIP-${meta.hip}` : null,
      file: hipFile.filename,
      type: meta.type ?? null,
      category: meta.category ?? null,
      status: meta.status ?? null,
      // A contribution's front matter describes someone else's HIP, so use the pull request's own dates.
      created: (kind === "proposal" && meta.created) || pr.created_at.slice(0, 10),
      updated: (kind === "proposal" && meta.updated) || pr.updated_at.slice(0, 10),
      requires: meta.requires || null,
      discussionsTo: meta["discussions-to"] || null,
      prState: pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft PR" : "open",
      prUrl: pr.html_url,
      headSha: sha,
      additions: pr.additions,
      deletions: pr.deletions,
      reviews: reviews.filter((r) => !isBot(r.user?.login)).map((r) => ({ by: r.user.login, state: r.state, at: r.submitted_at?.slice(0, 10) })),
      humanComments: comments.filter((c) => !isBot(c.user?.login)).length,
      abstract: kind === "proposal" ? section(body, "Abstract") : null,
      snapshot: null,
    };

    if (kind === "proposal") {
      const slug = curated.proposals[n]?.slug ?? hipFile.filename.replace(/^HIP\/hip-0000-|\.md$/g, "");
      rec.snapshot = `proposals/${n}-${slug}.md`;
      const blobBase = `https://github.com/${headRepo}/blob/${sha}`;
      const banner =
        `> [!NOTE]\n> Snapshot of [${curated.repo}#${n}](${pr.html_url}) at commit ` +
        `[\`${sha.slice(0, 7)}\`](${blobBase}/${hipFile.filename}), taken by \`scripts/sync.mjs\`. ` +
        `The pull request is the source of truth; relative links point at that commit.\n\n`;
      const front = raw.slice(0, raw.length - body.length);
      await writeFile(join(ROOT, rec.snapshot), front + banner + rewriteLinks(body, blobBase));
    }
    records.push(rec);
  }
  await writeFile(join(ROOT, "data/hips.json"), JSON.stringify({ source: curated.repo, records }, null, 2) + "\n");
  return records;
}

// ------------------------------------------------------------------ README rendering

const esc = (s) => String(s ?? "").replace(/\|/g, "\\|");
const badge = (label, message, color) =>
  `https://img.shields.io/badge/${encodeURIComponent(label).replace(/-/g, "--")}-${encodeURIComponent(message).replace(/-/g, "--")}-${color}`;
const statusColor = { open: "2ea44f", "draft PR": "6e7781", merged: "8250df", closed: "cf222e" };

function hipLabel(r) {
  return r.hip ?? `#${r.pr}`;
}

function renderTable(records) {
  const rows = records
    .filter((r) => r.kind === "proposal")
    .map((r) => {
      const c = curated.proposals[r.pr] ?? {};
      const theme = curated.themes.find((t) => t.id === c.theme)?.title ?? "";
      const impl = (c.implementation ?? []).length
        ? c.implementation.map((i) => `[${i.label}](${i.url})`).join("<br>")
        : "Specification";
      return `| [${esc(hipLabel(r))}](${r.prUrl}) | [**${esc(r.title)}**](${r.snapshot}) | ${esc(r.category)} | ${esc(theme)} | ${esc(r.status)} · ${esc(r.prState)} | ${r.created} | ${impl} |`;
    });
  return [
    "| PR | Proposal | Category | Theme | Status | Submitted | Implementation |",
    "|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

function renderByTheme(records) {
  const out = [];
  for (const t of curated.themes) {
    const own = records.filter((r) => r.kind === "proposal" && curated.proposals[r.pr]?.theme === t.id);
    const contrib = records.filter((r) => r.kind === "contribution" && curated.contributions[r.pr]?.theme === t.id);
    if (!own.length && !contrib.length) continue;
    out.push(`### ${t.title}\n`);
    for (const r of own) {
      const c = curated.proposals[r.pr] ?? {};
      const reviewers = [...new Set(r.reviews.map((x) => x.by))];
      out.push(`#### [${esc(r.title)}](${r.snapshot})\n`);
      out.push(
        `<a href="${r.prUrl}"><img alt="PR ${r.pr}" src="${badge("PR", `#${r.pr}`, "24292f")}"></a> ` +
          `<img alt="${esc(r.category)}" src="${badge(r.type ?? "HIP", r.category ?? "", "8259DD")}"> ` +
          `<img alt="${esc(r.status)}" src="${badge("status", `${r.status} · ${r.prState}`, statusColor[r.prState] ?? "6e7781")}">` +
          (r.requires ? ` <img alt="requires HIP-${r.requires}" src="${badge("requires", `HIP-${r.requires}`, "0969da")}">` : "") +
          "\n",
      );
      out.push(`${c.summary ?? r.abstract?.split("\n\n")[0] ?? ""}\n`);
      const facts = [];
      facts.push(`**Submitted** ${r.created}${r.updated && r.updated !== r.created ? ` · **updated** ${r.updated}` : ""}`);
      if (r.discussionsTo) facts.push(`**Discussion** <${r.discussionsTo}>`);
      if (reviewers.length) facts.push(`**Reviewed by** ${reviewers.map((x) => `@${x}`).join(", ")}`);
      out.push(facts.map((f) => `- ${f}`).join("\n"));
      for (const h of c.highlights ?? []) out.push(`- ${h}`);
      for (const i of c.implementation ?? []) out.push(`- **Implementation:** [${i.label}](${i.url}) — ${i.note}`);
      out.push(`- [Read the full proposal](${r.snapshot}) · [Pull request](${r.prUrl})\n`);
    }
    for (const r of contrib) {
      const c = curated.contributions[r.pr] ?? {};
      out.push(`#### Contribution: [${esc(r.title)}](${r.prUrl}) (${hipLabel(r)})\n`);
      out.push(`${c.summary ?? ""} [Pull request #${r.pr}](${r.prUrl}), ${r.created}, +${r.additions} / −${r.deletions} lines.\n`);
    }
  }
  return out.join("\n");
}

function renderTimeline(records) {
  const byDate = new Map();
  for (const r of [...records].sort((a, b) => a.created.localeCompare(b.created))) {
    const name = r.kind === "proposal" ? curated.proposals[r.pr]?.short ?? r.title : `HIP-1535 amendments`;
    if (!byDate.has(r.created)) byDate.set(r.created, []);
    byDate.get(r.created).push(`${name.replace(/:/g, " –")} (#${r.pr})`);
  }
  const lines = ["```mermaid", "timeline", "    title Hiero Improvement Proposals submitted by ColdAI"];
  for (const [d, names] of byDate) lines.push(`    ${d} : ${names.join(" : ")}`);
  lines.push("```");
  return lines.join("\n");
}

function renderStats(records) {
  const own = records.filter((r) => r.kind === "proposal");
  const contrib = records.filter((r) => r.kind === "contribution");
  const impl = own.filter((r) => (curated.proposals[r.pr]?.implementation ?? []).length).length;
  const lines = own.reduce((s, r) => s + r.additions, 0);
  return [
    `<img alt="${own.length} proposals" src="${badge("proposals", String(own.length), "FF3C00")}">`,
    `<img alt="${contrib.length} contributions" src="${badge("contributions to other HIPs", String(contrib.length), "FF3C00")}">`,
    `<img alt="${impl} with implementations" src="${badge("with implementation work", `${impl} of ${own.length}`, "2ea44f")}">`,
    `<img alt="${lines} lines of specification" src="${badge("lines of specification", lines.toLocaleString("en-US"), "6e7781")}">`,
  ].join("\n  ");
}

function replaceBlock(text, name, content) {
  const re = new RegExp(`(<!-- ${name}:start -->)[\\s\\S]*?(<!-- ${name}:end -->)`);
  if (!re.test(text)) throw new Error(`README is missing the ${name} markers`);
  return text.replace(re, `$1\n${content}\n$2`);
}

async function render(records) {
  const path = join(ROOT, "README.md");
  const before = await readFile(path, "utf8");
  let after = before;
  after = replaceBlock(after, "stats", `<p align="center">\n  ${renderStats(records)}\n</p>`);
  after = replaceBlock(after, "table", renderTable(records));
  after = replaceBlock(after, "themes", renderByTheme(records));
  after = replaceBlock(after, "timeline", renderTimeline(records));
  if (mode === "check") {
    if (after !== before) {
      console.error("README.md is out of date: run `node scripts/sync.mjs --render` and commit the result.");
      process.exit(1);
    }
    console.log("README.md is up to date");
    return;
  }
  await writeFile(path, after);
  // Remove snapshots that no longer correspond to a record.
  const keep = new Set(records.map((r) => r.snapshot).filter(Boolean));
  for (const f of await readdir(join(ROOT, "proposals"))) {
    if (!keep.has(`proposals/${f}`) && f.endsWith(".md")) await rm(join(ROOT, "proposals", f));
  }
  console.log(`rendered ${records.length} records`);
}

const records = mode === "sync" ? await sync() : (await readJson("data/hips.json")).records;
await render(records);
