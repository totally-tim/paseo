---
title: Orchestration skills
description: Reusable workflows for handing off tasks, getting a second opinion, and planning with multiple agents.
nav: Skills
order: 33
category: Orchestration
---

# Orchestration skills

Skills give your agents reusable instructions for delegation, handoffs, and reviews. You can also [ask for these workflows directly](/docs/orchestration-workflows) without installing skills.

| Skill              | Use it to                                                            |
| ------------------ | -------------------------------------------------------------------- |
| `/paseo`           | Look up how to manage agents, workspaces, schedules, and heartbeats. |
| `/paseo-handoff`   | Launch a fresh agent with context; keep the original session.        |
| `/paseo-committee` | Get two independent analyses of a difficult problem.                 |
| `/paseo-advisor`   | Get a second opinion on your current work.                           |

## Installation

- **In Paseo:** Open **Settings → your host → Agents → Orchestration skills** and choose which skills to install on that host.
- **From the terminal:** Run `npx skills add getpaseo/paseo` on the machine where your agents run.

Use the same settings card to update or uninstall skills. The host also refreshes selected installed Paseo skills on startup.

## `/paseo`, Paseo Reference

The foundational reference used by the other skills. It teaches agents to check your [agent profiles and their notes](/docs/agent-profiles#guide-delegation-with-notes) before delegating, then apply the selected launch settings. If no profile fits, it directs them to discover available providers and models and tell you about the fallback.

> /paseo show me how to create an agent in a workspace with worktree isolation

## `/paseo-handoff`, Task Handoff

Launch a fresh agent while keeping the original session usable. Give it a briefing: relevant files, progress, decisions, constraints, and acceptance criteria. The skill checks profiles before choosing the receiving agent; you can name the profile you want.

> /paseo-handoff hand off the auth fix to an implementation agent in its own worktree

Open the new agent from the original session’s subagents track. It shares the current workspace unless you ask for a separate worktree. Use Paseo’s **Continue with…** UI when you want to replace the original session.

## `/paseo-committee`, Committee Planning

Get two agents to analyze a difficult problem independently. The skill checks profile notes for planning and analysis, preferring different provider families when possible.

> /paseo-committee why are the websocket connections dropping under load?

Committee members return analyses without editing files. The main agent synthesizes their plans, implements the solution, and sends the diff back for review.

## `/paseo-advisor`, Advisor

Get another agent's judgment on a design, diff, or question. The skill chooses a profile whose notes fit the work, or uses the profile you name.

> /paseo-advisor did I miss anything in this migration plan?

The advisor returns a second opinion without editing files.
