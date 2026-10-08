# Kubernetes

Notes and manifests from working through the [Kubernetes Masterclass for Beginners](https://www.udemy.com/course/kubernetes-masterclass-for-beginners/) course on Udemy.

Everything in this folder is based on that course: the notes summarize what I learned in each module, and the manifests are what I built and experimented with while following along — all run on a local [Rancher Desktop](rancher.md) cluster.

## Contents

- [Kubernetes Essentials](kubernetes.md) — what Kubernetes is, pods, declarative state
- [kubectl](kubectl.md) — the CLI: contexts, get/run/describe, YAML workflows
- [Namespaces](namespaces/namespaces.md) — logical grouping and isolation, with the [namespace manifest](namespaces/namespace.yaml)
- [Deployments](deployments/deployments.md) — desired state, rolling updates and strategies, with the [example manifests](deployments/)
- [Rancher Desktop](rancher.md) — the local cluster all of this runs on
