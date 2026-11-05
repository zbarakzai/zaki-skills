# Zaki skills

The list of skills Zaki offers in **Settings → Skills**. Zaki downloads
[`catalog.json`](catalog.json) on start and every 6 hours: it's the list to browse and the newest
version of every skill in it, so it's also how Zaki knows a skill you installed has an update.

## How it works

- [`sources.json`](sources.json) names the repos and the folders in them to offer. `*` matches one
  folder name; folders starting with `.` only match when named.
- [`build.mjs`](build.mjs) finds every folder with a `SKILL.md` that a source includes, pins it to
  the commit its branch points at, and writes each skill's name, description, files and folder hash
  (the git tree SHA) into `catalog.json`.
- [`.github/workflows/build.yml`](.github/workflows/build.yml) runs it every 6 hours and on every
  change here, and commits `catalog.json` when a skill changed.

A skill's `name` comes from its `SKILL.md` frontmatter. The card's title and one line come from
`agents/openai.yaml` (`display_name`, `short_description`) when the skill has one, else from the
name and the description's first sentence.

## Add a source

Add an entry to `sources.json` and open a pull request:

```json
{ "repo": "owner/repo", "ref": "main", "include": ["skills/*"] }
```

Run `GITHUB_TOKEN=$(gh auth token) node build.mjs` to see what it finds.

## In Zaki

Installing copies the skill's files, at the commit in the catalog, to `~/.config/zaki/skills/<name>`
and links that folder into `~/.agents/skills` (Codex, Pi, Gemini CLI, OpenCode, Cursor, Amp) and
`~/.claude/skills` (Claude Code). Updating replaces that one folder, so every agent has the new
version at once.
