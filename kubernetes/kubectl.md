# kubectl — Kubernetes CLI

Reference: <https://kubernetes.io/docs/reference/kubectl/>

## Context

Shows which cluster is currently in use — Rancher Desktop provides the local one, see [Rancher Desktop](rancher.md).

```bash
kubectl config current-context          # e.g. rancher-desktop
kubectl config use-context <cluster-name>   # switch cluster
```

## Basics

`kubectl get` lists resources on the cluster (cluster concepts in [Kubernetes Essentials](kubernetes.md)).

```bash
kubectl get pods          # list pods
kubectl get all           # everything in the namespace
kubectl get pods -o wide  # more info (node, IP)
```

> Tip: `<TAB><TAB>` gives full autocomplete for commands and options.

## Run a pod

```bash
kubectl run <pod-name> --image=<image-name>

# Example
kubectl run nginx-pod --image=nginx
```

> Note: newer kubectl versions create a Pod this way — older versions created a Deployment.

## Inspect a pod

```bash
kubectl describe pod <pod-name>         # details: containers, events, networking
kubectl get pod <pod-name> -o yaml      # full YAML (lots of unnecessary fields)
kubectl logs <pod-name>                 # container logs
```

Live-edit the running pod's definition:

```bash
kubectl edit pod <pod-name>
```

## Work with YAML files

Generate a clean YAML template with `--dry-run=client -o yaml` (doesn't deploy anything):

```bash
kubectl run nginx-yaml --image=nginx --dry-run=client -o yaml
```

Redirect it straight into a file (`nginx.yaml`):

```bash
kubectl run nginx-yaml --image=nginx --dry-run=client -o yaml > nginx.yaml
```

Then deploy the pod from the file:

```bash
kubectl create -f nginx.yaml   # only creates; errors if the pod already exists
kubectl apply  -f nginx.yaml   # creates or updates — compares with existing pods
```

> Use `apply` for ongoing management; `create` is for one-off creation. The same `apply -f` flow works for other resource types too, like [Deployments](deployments.md).

## Lifecycle

```bash
kubectl delete pod <pod-name>     # delete by name
kubectl delete -f nginx.yaml      # delete what's defined in a file
```

## Run commands inside a pod

```bash
kubectl exec -it <pod-name> -- <command>

# get an interactive shell:
kubectl exec -it <pod-name> -- /bin/bash
kubectl exec -it <pod-name> -- /bin/sh   # if bash isn't available

exit        # leave the shell (or <ctrl+d>)
```