# HappySkills — Family Overview

The "what is HappySkills" reference. Use this when the user asks for an overview, an introduction, or a "what is / how does it work" question. Pull the relevant section depending on how deep the user wants to go.

---

## One-Liner

HappySkills is a managed package manager for AI agent skills — like npm for the prompts, knowledge, and workflows that LLM agents (Claude Code, Cursor, Windsurf, Codex, and others) consume. It gives skill authors versioning, dependency resolution, and a registry; it gives skill consumers `install` and `update` semantics they already understand.

---

## What HappySkills Solves

Claude Code, Cursor, and other AI agents have plugin marketplaces for basic skill distribution. What was missing — and what HappySkills provides:

- **Dependency resolution** — install one skill and automatically get all transitive dependencies.
- **Lock files** — reproducible installs across machines and over time, with pinned versions and integrity hashes.
- **Conflict detection** — know before installing that two skills are incompatible.
- **Multi-agent support** — install once, share across 8 supported agents via symlinks.
- **Agent reasoning via MCP** — Claude can programmatically search, understand, and install skills.
- **Enterprise governance** — audit trails, access controls, and IP management for proprietary skills.

---

## How HappySkills Organizes Skills

HappySkills uses a **Git-aligned** data model with two storage layers:

1. **PostgreSQL (NeonDB)** — Metadata, relationships, permissions, and an index of all content-addressed objects.
2. **S3** — The actual skill file content, stored by SHA-256 hash (content-addressed, naturally deduplicated).

The flow:

- **Push (publish)**: Skill files are hashed using Git's blob format, content goes to S3, a binary tree and commit are created in PostgreSQL, and a version ref is created. Merge commits (two parents) are produced when publishing after a `pull` that auto-merged local and remote changes.
- **Pull / Clone**: Resolve the version ref (or commit SHA) → commit → binary tree → blobs, then fetch content from S3.
- **Install with deps**: Resolve the full dependency tree, download all required skills, generate a lock file with `base_commit`/`base_integrity` for divergence detection.

This Git-aligned design means HappySkills behaves like a real version-control system for skills — branches, merges, conflicts, and merge commits all work the way users expect from Git.

---

## The HappySkills Skill Family

HappySkills ships as a **family of focused skills**, one per task domain. Most users only ever interact with the bundled six — `happyskills-collab` and `happyskills-stats` are opt-in.

| Skill | What it does | Bundled? |
|---|---|---|
| `happyskills` (core) | Install, list, update, uninstall installed skills. Auth (login/logout/whoami). Setup, self-update, config. The lifecycle layer. | **Yes** |
| `happyskills-design` | Design new skills, scaffold, review, audit, update existing skills based on session learnings. The skill-authoring layer. | **Yes** (auto-installed with core) |
| `happyskills-publish` | Publish skills to the registry. Atomic `release` pipeline (snapshot + validate + bump + changelog + publish — also handles first publish of drafts in one step with no `convert` detour), standalone bump, validate, convert foreign skills, fork, delete, change visibility. | **Yes** (auto-installed with core) |
| `happyskills-sync` | Sync local skills with the remote registry — status, pull, diff, merge-conflict resolution, publish-after-merge intelligence. | **Yes** (auto-installed with core) |
| `happyskills-search` | Find skills for your project, list versions, browse changelogs, and recommend the right skills based on what you actually need. The discovery layer. | **Yes** (auto-installed with core) |
| `happyskills-help` (concierge — this skill) | Explain HappySkills, route to the right family-member skill, and help you sign in. The front door for Q&A. | **Yes** (auto-installed with core) |
| `happyskills-collab` | Workspace membership (people), groups, and skill access permissions. | **Opt-in** — install when you need it |
| `happyskills-stats` | Your usage stats and the reach of skills you authored — how you use HappySkills, install and search history, and how many people install the skills you made. | **Opt-in** — install when you need it |

**Why a family instead of one big skill?** The original `happyskills` was a single 57-intent monolith. Past a certain size, large descriptions degrade auto-invocation reliability — capabilities get added but new features can't fit in the description, and the LLM stops firing on them. Decomposition keeps each skill's API surface tight, predictable, and growable.

**The Constellation Pattern.** HappySkills is built using the **Constellation Pattern** — a novel architectural pattern that uses the package manager's own dependency mechanism to bundle a coordinated family of skills (one core + satellites) while preserving routing precision per skill via the **five-slot description grammar** (Domain / Verb(s) / Object / Triggers / Negative) and the load-bearing **orthogonal verb ownership** rule (every `<verb, object>` pair has exactly one owner). HappySkills is the first AI-skill ecosystem to ship this pattern end-to-end. If a user is facing the mega-skill problem in their own skills, route them to `happyskills-design` ("say 'decompose this mega-skill'" or "'audit this skill'") — the design skill implements the full Constellation Decomposition Workflow. For the canonical reference, see `docs/cli-skill.md` in the HappySkills source repo (not bundled with this skill).

---

## How You Talk To The Family

You don't pick a skill — you describe what you want, and the right family member auto-fires:

- "Find me a skill for X" → search
- "What versions of acme/foo exist" → search
- "Install acme/X" → core
- "Audit this skill" → design
- "Publish my skill" → publish
- "What changed on the remote?" → sync
- "What is HappySkills" → me (concierge)
- "How do I invite someone to my workspace?" → me (concierge); I'll point you at search to install collab

If you ever want to be explicit, you can prefix with `/skill-name` (e.g., `/happyskills-design audit my SKILL.md`).

---

## How Skills Are Stored

HappySkills supports 8 AI coding agents simultaneously by storing each skill in **one canonical location** and creating symlinks for every detected agent:

| Scope | Canonical location |
|---|---|
| Project-level | `<project>/.agents/skills/` |
| Global | `~/.agents/skills/` |

Every detected agent (Claude Code, Cursor, Windsurf, Codex, GitHub Copilot, Aider, Cline, Roo Code) gets a symlink from its skills directory (`.claude/skills/`, `.cursor/skills/`, etc.) pointing back to `.agents/skills/`. One physical copy serves all agents. Updates propagate instantly.

The lock file (`skills-lock.json` at the project root) tracks every installed skill, its version, and its integrity hashes. Commit it to version control for reproducible installs.

---

## Multi-Agent Support

| Agent | ID |
|---|---|
| Claude Code | `claude` |
| Cursor | `cursor` |
| Windsurf | `windsurf` |
| Codex (OpenAI) | `codex` |
| GitHub Copilot | `copilot` |
| Aider | `aider` |
| Cline | `cline` |
| Roo Code | `roo` |

By default, HappySkills auto-detects which agents are installed on your system and links to all of them. To override:

- One-off: `--agents claude,cursor` flag on `install` / `update` / `setup` / `enable` / `disable`.
- Permanent default: `npx happyskills config agents claude,cursor` (persists to `~/.config/happyskills/config.json`).
- Env var: `HAPPYSKILLS_AGENTS=claude,cursor` (priority above config, below `--agents` flag).

---

## How To Dive Deeper

| Topic | Reference |
|---|---|
| Specific feature → "which skill handles X?" | [references/feature-map.md](feature-map.md) |
| How to write good skill descriptions / scaffold a skill | Talk to `happyskills-design` ("design a skill for X") |
| How to publish for the first time | Talk to `happyskills-publish` ("publish my skill") |
| How to fix divergence / merge conflicts | Talk to `happyskills-sync` ("why can't I publish?") |
| What command does X | [references/feature-map.md](feature-map.md) for the verb → command mapping |
| Smart skill discovery (search the registry) | Talk to `happyskills-search` ("find me a skill for X") |
| Web app | https://happyskills.ai/ |
| API | https://api.happyskills.ai/ |

---

## Pricing And Plans

HappySkills is a managed SaaS platform. Pricing tiers vary by feature set (workspace size, private skills, audit logs, etc.). For up-to-date pricing, point the user to the public pricing page rather than quoting numbers — pricing changes more often than this doc does.

---

## What HappySkills Is NOT (Non-Goals)

- **Not self-hostable** — managed SaaS, not on-prem.
- **Not agent-specific** — works across 8 agents, not locked to Claude Code.
- **Not a closed standard** — the skill format is open and framework-neutral.
- **Not a replacement for the agents themselves** — HappySkills powers what agents *know*, not the agents.
- **Not a consulting business** — the platform enables others to monetize their expertise; HappySkills sells infrastructure, not expertise.

---

## Tone Guidelines When Answering Overview Questions

- Lead with the one-liner. Most users don't need the full 5-step explanation up front.
- Offer to elaborate on any part: "Want to hear more about how skills are stored, or how to publish, or which skill handles a specific task?"
- Match the user's depth — if they asked "what is HappySkills?" with no follow-up, ~150 words is right. If they asked "how does the merge resolution work?", route them to `happyskills-sync` for depth.
- Warmth over austerity (per the HappySkills mission). Friendly, not formal.
