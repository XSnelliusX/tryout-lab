# 🧪 Tryout Lab

Welcome to my **Tryout Lab**! This repository is a personal playground and sandbox dedicated to exploring new technologies, experimenting with languages, and prototyping quick coding ideas.

## 📂 Repository Structure

Every project, tool, or language trial is isolated into its own dedicated directory to keep things organized:

*   📂 [`ai-workflow/`](ai-workflow/README.md) — The AI workflow: three tools that share one usage log, one model comparison and one recommendation engine. Installs together with `ai-workflow/install.sh`:
    *   [`ai-gateway/`](ai-workflow/ai-gateway/README.md) — AI gateway plugin for OpenCode and Claude Code: model discovery, usage and cost dashboard (`/usage-dashboard`), benchmark model comparison with the recommendation engine (`/model-comparison`); the two dashboards link to each other.
    *   [`herdr-commander/`](ai-workflow/herdr-commander/README.md) — Commander/worker orchestration for the Herdr desktop app: a planner before implementation, per-ticket Spaces and git worktrees, model-tiered OpenCode workers via `hc`, `cc-models` picks per role, budget guardrail.
    *   [`opencode-prompt-rewrite/`](ai-workflow/opencode-prompt-rewrite/README.md) — `/rw` in OpenCode: prompt rewriting with a "Grill Me" interview and a benchmark-based model and effort recommendation.
*   📂 `golang/` — Learning Go syntax, concurrent programming, and microservices ([Redis-like server](golang/redis/), [Udemy course progress](golang/Udemy/Readme.md)).
*   📂 `kubernetes/` — Kubernetes manifests, local cluster configurations, and notes ([Essentials](kubernetes/kubernetes.md), [kubectl](kubernetes/kubectl.md), [Namespaces](kubernetes/namespaces/namespaces.md), [Deployments](kubernetes/deployments/deployments.md), [Networking](kubernetes/networking/networking.md), [Storage](kubernetes/storage/storage.md), [k9s](kubernetes/k9s.md), [Helm](kubernetes/helm/helm.md), [Monitoring](kubernetes/monitoring/monitoring.md), [Rancher Desktop](kubernetes/rancher.md))
*   📂 `mac-setup/` — New-Mac setup script and terminal configs; its `gateway` step installs `ai-workflow/ai-gateway/` ([overview + Vorssaint](mac-setup/README.md), [zsh](mac-setup/zsh/README.md), [cmux](mac-setup/cmux/README.md), [Claude Code statusline](mac-setup/claude-code/README.md), [Neovim / LazyVim](mac-setup/nvim/README.md), [Vim + LazyVim usage](mac-setup/nvim/usage.md))
*   📂 [`meeting-assistant/`](meeting-assistant/README.md) — Preview of a local Mandarin–English meeting assistant for captions, technical vocabulary and Chinese learning.

## 🛠️ Purpose & Goals

*   **Learn by Doing:** Rapidly prototype features and test modern frameworks.
*   **Zero Commitment:** Spin up quick scripts and configurations without starting full-blown repositories.
*   **Knowledge Base:** Act as a personal reference point for boilerplate code and configurations.
