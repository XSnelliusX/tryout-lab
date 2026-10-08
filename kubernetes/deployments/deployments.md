# Deployments

A Deployment defines the **desired state** for a set of pods — e.g. "10 replicas of this image, running at all times" — and Kubernetes works to make the cluster match it. You don't run single pods in practice; deployments manage them for you.

Examples run on the local [Rancher Desktop](../rancher.md) cluster, in their own [namespace](../namespaces/namespaces.md).

## Create

```bash
# Create a deployment named my-dep that runs the busybox image
kubectl create deploy my-dep --image=busybox

# Create a deployment with a command
kubectl create deploy my-dep --image=busybox -- date

# Create a deployment named my-dep that runs the nginx image with 3 replicas
kubectl create deploy my-dep --image=nginx --replicas=3

# Create a deployment named my-dep that runs the busybox image and expose port 5701
kubectl create deploy my-dep --image=busybox --port=5701

# Create a deployment named my-dep that runs multiple containers
kubectl create deploy my-dep --image=busybox:latest --image=ubuntu:latest --image=nginx
```

> Both `deploy` and `deployment` work as parameter names.

> Tip: `kubectl create deployment --help | less` lists all options — piping to `vim -` works too.

## Inspect

```bash
kubectl get deployments             # list deployments + replica status
kubectl describe deployment test    # labels, selector, strategy, image + events
kubectl edit deployment test        # live-edit the YAML in $EDITOR
```

> Note: tab completion shows `deployment.apps` and the YAML says `apiVersion: apps/v1` — that's just Kubernetes API group naming, nothing to worry about for now.

> Tip: the **Events** section at the bottom of `describe` output is the first place to look when a deployment misbehaves.

## Delete

```bash
kubectl delete deployment test   # the pods it manages are deleted too
```

## Manage from code

One-off `create` commands are fine for trying things out — real work happens in YAML files.

Generate a template without touching the cluster (same `--dry-run` trick as with pods, see [kubectl](../kubectl.md)), then apply it:

```bash
kubectl create deploy test --image=httpd --replicas=10 \
  --dry-run=client -o yaml > deploy.yaml

kubectl apply -f deploy.yaml
```

Cleaned-up version of the generated file:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test
  labels:
    app: test          # added automatically from the name
spec:
  replicas: 10
  selector:
    matchLabels:
      app: test        # how the deployment finds the pods it manages
  template:            # the pod manifest — same shape as a pod YAML
    metadata:
      labels:
        app: test
    spec:
      containers:
        - name: httpd
          image: httpd
```

Updating = change the file and `kubectl apply -f deploy.yaml` again.

## ReplicaSets

The deployment doesn't create pods itself — it creates a **ReplicaSet**, and the ReplicaSet creates the pods.

```bash
kubectl get replicasets              # one per deployment revision
kubectl describe replicaset test     # desired vs current replicas
```

- Never create or manage ReplicaSets yourself — the docs recommend Deployments; Kubernetes handles them for you.
- Old ReplicaSets are kept around after a rollout (default: 10) — a deployment can own several; only the newest one is active.

## Update strategies

`spec.strategy.type` — how old pods get replaced by new ones:

- **RollingUpdate** *(default)* — replaces pods in batches; old pods keep serving while the new ones start.
- **Recreate** — kills *all* existing pods before creating the new ones → downtime.

## Rolling update in action

1. Change the image tag in `deploy.yaml` (e.g. `httpd` → `httpd:alpine3.18`).
2. Watch the rollout live:

   ```bash
   watch -n 1 kubectl get pods
   ```

   > Note: `watch` needs to be installed first on macOS using `brew install watch`

3. `kubectl apply -f deploy.yaml` and see the pods replaced batch by batch.

## maxSurge & maxUnavailable

```yaml
spec:
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
      maxSurge: 1
```

(`strategy` sits at the same indentation level as `template`.)

- **maxSurge** — how many pods above the desired count may exist during the update: 10 replicas + `maxSurge: 1` → never more than 11.
- **maxUnavailable** — how many pods may be down during the update: 10 replicas + `maxUnavailable: 2` → at least 8 always running.
- Values can be a number or a percentage — default is 25%/25% (≈5 pods at a time with 10 replicas; 1/1 → 2 at a time).
- Also regulated by PodDisruptionBudgets (later module).

## When a rollout fails

Containers are Linux: exit code `0` = success, anything else = error (`echo $?` prints the last exit code).

Simulate a broken app:

```yaml
containers:
  - name: httpd
    image: httpd
    command: ["bash", "-c", "sleep 5; exit 1"]   # sleeps, then exits with an error
```

The new pods fail (`RunContainerError` → `CrashLoopBackOff`) — and Kubernetes **stops the rollout** instead of replacing every pod. It won't take your whole application down for you.
