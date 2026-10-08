# Namespaces

A namespace is a **logical grouping of resources** within a single cluster — the docs call it "a mechanism for isolating groups of resources within a single cluster". Think of it like a resource group in Azure: a wrapper that lets you isolate things from each other.

- Only *namespaced* objects (pods, [deployments](../deployments/deployments.md), services, …) live inside a namespace — cluster-wide objects (nodes, storage classes, persistent volumes) don't.
- Isolation is what namespaces enable: close off traffic between apps with **network policies**, scope **RBAC** roles to a namespace, keep teams/applications apart.
- The docs say clusters with few users shouldn't need to think about namespaces — but also recommend *not* using `default` in production. A good rule: **every application/workload gets its own namespace** (that's how the home lab is set up, instead of one namespace per team).
- Everything up to now ran in the `default` namespace without us noticing.

## Create

```bash
kubectl get namespaces                              # list them (or: k get ns)
kubectl create namespace mealie                     # one-off creation

# generate the YAML instead — same dry-run trick as always
kubectl create ns mealie --dry-run=client -o yaml > namespace.yaml
kubectl apply -f namespace.yaml
```

> Note: `ns` is a valid abbreviation — kubectl accepts the short forms everywhere.

The generated file is tiny:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: mealie        # labels can be added later
```

## Delete

```bash
kubectl delete ns mealie
```

> Tip: deleting a namespace deletes **everything inside it**. For experiments, create a throwaway `test` namespace, do your thing, then clean up by deleting the whole namespace.

## Working in a namespace

Without a namespace, resources land in `default`:

```bash
kubectl run misha --image=nginx                    # goes to default
kubectl run misha-mealie --image=nginx -n mealie   # create it in mealie instead
kubectl get pods -n mealie                         # only that namespace's pods
```

(`-n` is shorthand for `--namespace`. And pods are created with `run`, not `create` — see [kubectl](../kubectl.md).)

Typing `-n` on every command gets tedious. Set the default namespace on the current context instead:

```bash
kubectl config current-context                           # confirm the cluster, e.g. rancher-desktop
kubectl config set-context --current --namespace=mealie
kubectl get pods                                         # now shows the mealie pods
```

> Tip: context/namespace switching is a core exam skill — no helper tools there, so know `kubectl config` cold. The rest of the context commands are in [kubectl](../kubectl.md).

With the `mealie` namespace active on the cluster, the next step is deploying the app into it — see [Deployments](../deployments/deployments.md).
