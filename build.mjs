// Builds catalog.json from sources.json: every skill folder (one with a SKILL.md) that a source's
// `include` patterns match, pinned to the commit its ref points at now. `*` matches one folder name.
// Run with GITHUB_TOKEN set (Actions does); without it GitHub allows 60 API calls an hour.
// `node build.mjs --check` exits 1 when catalog.json is out of date, without writing it.
//
// catalog.json is what Zaki lists and checks for updates, so it stays small (Zaki reads files up to
// 1 MiB). Each repo's file lists are in files/<owner>/<repo>.json, read only to install or update.

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const headers = { "User-Agent": "zaki-skills-catalog", Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };

async function get(url, kind = "json") {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(url, { headers: url.startsWith(API) ? headers : { "User-Agent": headers["User-Agent"] } });
    if (r.ok) return kind === "json" ? r.json() : r.text();
    if (r.status === 404 && kind === "text") return null;
    if (attempt >= 3) throw new Error(`${r.status} ${url}: ${(await r.text()).slice(0, 200)}`);
    await new Promise((done) => setTimeout(done, 1000 * attempt));
  }
}

const matches = (pattern, path) => {
  const a = pattern.split("/"), b = path.split("/");
  return a.length === b.length && a.every((part, i) => part === "*" ? !b[i].startsWith(".") : part === b[i]);
};

// The frontmatter fields skills use: plain, quoted, and folded or literal block values.
export function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text ?? "");
  if (!m) return {};
  const out = {}, lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^[|>][+-]?$/.test(value)) {
      const block = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || lines[i + 1] === "")) block.push(lines[++i].trim());
      value = value.startsWith("|") ? block.join("\n").trim() : block.join(" ").replace(/\s+/g, " ").trim();
    } else if (/^["']/.test(value)) {
      const q = value[0];
      value = value.slice(1, value.lastIndexOf(q) > 0 ? value.lastIndexOf(q) : undefined);
      if (q === '"') value = value.replace(/\\"/g, '"');
      else value = value.replace(/''/g, "'");
    }
    out[kv[1]] = value;
  }
  return out;
}

// agents/openai.yaml: the card's name and one line, as Codex shows them.
export function openaiInterface(text) {
  const out = {};
  for (const line of (text ?? "").split(/\r?\n/)) {
    const kv = /^\s+(display_name|short_description):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text);
const titled = (name) => name.split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
const firstSentence = (text) => {
  const s = (text ?? "").split(/(?<=[.!?])\s/)[0].trim();
  return s.length > 90 ? `${s.slice(0, 87).trimEnd()}…` : s;
};

async function source({ repo, ref = "main", include }) {
  const commit = (await get(`${API}/repos/${repo}/commits/${encodeURIComponent(ref)}`)).sha;
  const tree = await get(`${API}/repos/${repo}/git/trees/${commit}?recursive=1`);
  if (tree.truncated) throw new Error(`${repo}: the tree is too big to list in one call`);
  const folders = new Map(tree.tree.filter((e) => e.type === "tree").map((e) => [e.path, e.sha]));
  const dirs = tree.tree
    .filter((e) => e.type === "blob" && e.path.endsWith("/SKILL.md"))
    .map((e) => e.path.slice(0, -"/SKILL.md".length))
    .filter((dir) => include.some((p) => matches(p, dir)));
  const skills = [];
  for (const dir of dirs) {
    const files = tree.tree
      .filter((e) => e.type === "blob" && e.path.startsWith(`${dir}/`) && e.mode !== "120000")
      .map((e) => ({ path: e.path.slice(dir.length + 1), size: e.size, sha: e.sha }));
    const raw = (file) => `${RAW}/${repo}/${commit}/${[...dir.split("/"), ...file.split("/")].map(encodeURIComponent).join("/")}`;
    const meta = frontmatter(await get(raw("SKILL.md"), "text"));
    const ui = files.some((f) => f.path === "agents/openai.yaml") ? openaiInterface(await get(raw("agents/openai.yaml"), "text")) : {};
    const name = meta.name || dir.split("/").pop();
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
      console.warn(`skipped ${repo}/${dir}: "${name}" can't be a folder name`);
      continue;
    }
    skills.push({
      id: `${repo}/${dir}`,
      name,
      title: ui.display_name || titled(name),
      short: ui.short_description || firstSentence(meta.description),
      description: clip(meta.description ?? "", 400),
      repo,
      path: dir,
      ref,
      commit,
      tree: folders.get(dir),
      size: files.reduce((n, f) => n + f.size, 0),
      count: files.length,
      files: files.map(({ path, size }) => ({ path, size })),
    });
  }
  console.log(`${repo}@${commit.slice(0, 7)}: ${skills.length} skills`);
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

const { sources } = JSON.parse(readFileSync(new URL("./sources.json", import.meta.url), "utf8"));
const skills = [];
for (const s of sources) skills.push(...(await source(s)));

const listed = skills.map(({ files, ...rest }) => rest);
const file = new URL("./catalog.json", import.meta.url);
const old = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
const same = old && JSON.stringify(old.skills) === JSON.stringify(listed);
const catalog = { version: 1, generated: same ? old.generated : new Date().toISOString(), sources: sources.map((s) => s.repo), skills: listed };
if (process.argv.includes("--check")) process.exit(same ? 0 : 1);
const text = JSON.stringify(catalog) + "\n";
if (text.length > 900_000) throw new Error(`catalog.json would be ${text.length} bytes: Zaki reads at most 1 MiB`);
writeFileSync(file, text);
rmSync(new URL("./files", import.meta.url), { recursive: true, force: true });
for (const repo of new Set(skills.map((s) => s.repo))) {
  const mine = skills.filter((s) => s.repo === repo), out = new URL(`./files/${repo}.json`, import.meta.url);
  mkdirSync(new URL(".", out), { recursive: true });
  writeFileSync(out, JSON.stringify({ repo, commit: mine[0].commit, skills: Object.fromEntries(mine.map((s) => [s.path, { tree: s.tree, files: s.files }])) }) + "\n");
}
console.log(same ? "catalog.json is up to date" : `catalog.json written: ${skills.length} skills`);
