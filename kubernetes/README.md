# Kubernetes

Notes and manifests from working through the [Kubernetes Masterclass for Beginners](https://www.udemy.com/course/kubernetes-masterclass-for-beginners/) course on Udemy.

Everything in this folder is based on that course: the notes summarize what I learned in each module, and the manifests are what I built and experimented with while following along — all run on a local [Rancher Desktop](rancher.md) cluster.

## Contents

- [Kubernetes Essentials](kubernetes.md) — what Kubernetes is, pods, declarative state
- [kubectl](kubectl.md) — the CLI: contexts, get/run/describe, YAML workflows
- [Namespaces](namespaces/namespaces.md) — logical grouping and isolation, with the [namespace manifest](namespaces/namespace.yaml)
- [Deployments](deployments/deployments.md) — desired state, rolling updates and strategies, with the [example manifests](deployments/)
- [Networking](networking/networking.md) — pod IPs, CNI, [Services](networking/services.md) (ClusterIP/NodePort/LoadBalancer) and [Ingress](networking/ingress.md), with the [mealie manifests](networking/)
- [Storage](storage/storage.md) — volumes in the pod spec, [ephemeral](storage/ephemeral-storage.md) (`emptyDir`) and [persistent](storage/persistent-storage.md) (PV/PVC) storage, [storage classes & access modes](storage/storage-classes.md), with the [example manifests](storage/)
- [k9s](k9s.md) — terminal UI for the cluster: navigation, sorting, logs, shell, port-forward
- [Helm](helm/helm.md) — repos, charts and releases, install/upgrade/uninstall, values files, with the [values file](helm/values.yaml)
- [Rancher Desktop](rancher.md) — the local cluster all of this runs on
