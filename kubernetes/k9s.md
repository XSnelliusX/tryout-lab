# k9s

Terminal UI to explore and operate a cluster — [k9scli.io](https://k9scli.io/). Everything it does is `kubectl` underneath; keep using [kubectl](kubectl.md) to learn (and for the exams), use k9s to be faster in daily work.

```bash
brew install k9s
k9s            # uses the active context from kubeconfig, e.g. rancher-desktop
```

- The header shows context, cluster, user, Kubernetes version and (with a working metrics server) CPU/memory. No metrics? The metrics server isn't set up — Rancher Desktop usually has it, otherwise it comes with a monitoring stack later.
- **The cluster must be running**: with Rancher Desktop stopped, k9s can't connect to the context (error like `no connection to cached dial`). Start Rancher Desktop first and wait until Kubernetes is up, see [Rancher Desktop](rancher.md)
- Works on any cluster; one k9s window per context (e.g. in separate tmux panes)
- **Vim keybindings** everywhere (`j`/`k`, `/`, `n`, `gg`/`G`, `:`) — see [Vim usage](../mac-setup/vim/usage.md)
- `?` shows all keys for the current view

## Navigation

| Key | Action |
|---|---|
| `:<resource>` + Enter | switch resource: `:pod`, `:deploy`, `:svc`, `:pvc`, `:pv`, `:ingress`, ... (same abbreviations as kubectl, Tab completes) |
| `0` | all namespaces |
| `1`, `2`, ... | the namespaces listed in the header (e.g. `kube-system`, `mealie`, `default`) |
| `/<text>` + Enter | filter the view — matches any column, so also an IP, a status or `mealie` |
| `/` + Enter | reset the filter |
| `Esc` | back |
| `Shift+A` | sort by **age** |
| `Shift+S` | sort by **status** |

> Only seeing one deployment or pod? You're filtered on a namespace — press `0`.

Useful sorts on a busy cluster:

- **Age** → the most recently (re)started pods first: watch a rollout or a Kubernetes upgrade on a second screen
- **Status** → everything `Pending` or `Failed` bubbles up, quick check that all pods are `Running`

## Actions on a resource

Select it and press:

| Key | Action | kubectl equivalent |
|---|---|---|
| `l` | logs | `kubectl logs` |
| `d` | describe | `kubectl describe` |
| `y` | YAML as stored in the cluster | `kubectl get -o yaml` |
| `e` | edit | `kubectl edit` |
| `s` | shell into a pod (asks which container if there are several) | `kubectl exec -it` |
| `Shift+F` | port-forward (offers the container ports from the pod spec) | `kubectl port-forward` |
| `Ctrl+k` | kill (pod restarts if a deployment manages it) | `kubectl delete pod` |
| `Ctrl+d` | delete, asks for confirmation | `kubectl delete` |

> Careful with delete — especially for storage (PVCs/PVs, see [Persistent storage](storage/persistent-storage.md)). A bare pod without a deployment is gone for good.

### Logs

- Auto-scroll is on by default, `s` toggles it — open the app in the browser next to it and watch requests stream in
- `Ctrl+u` / `Ctrl+d` page up/down, `0` jump to the tail, `1` to the head
- `/` filters lines (e.g. `/cookbooks`); not a logging stack, but quick for a keyword in one pod
- On a **deployment**, `l` shows the logs of all its pods together instead of a single pod

### Describe and YAML views

- `/` searches inside the view, `n` next hit, `gg` / `G` top / bottom
- `y` on a pod without ports shows no `containerPort`, which is why `Shift+F` finds nothing to forward; on mealie it finds `containerPort: 9000`
- A k9s port-forward lives as long as the k9s window is open (an `F` marker shows in the row)

### Edit and scale

- `e` on a service, add a label, save → `d` shows it (the same as `kubectl edit`)
- On a deployment, scale to 2 → a second pod appears (sort pods by age to spot it)

## Try it: kubectl first, then k9s

For learning, do an operation with kubectl, then repeat it in k9s:

```bash
kubectl logs -n mealie <mealie-pod> | less      # kubectl
```

k9s: `:pod` → `/mealie` → `l`.
