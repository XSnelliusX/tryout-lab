# Helm

The package manager for Kubernetes: a **chart** is a package of Kubernetes resources (deployment, service, ...) that is installed with one command and configured with a values file. Docs: [helm.sh](https://helm.sh/docs/)

Helm is a **binary on your own machine**, not something that runs in the cluster. It talks to the cluster of your active [kubectl context](../kubectl.md) and does the same thing as `kubectl apply` under the hood, just for a whole set of resources.

- Fine for the home lab and experiments, but running helm by hand from a laptop or jump host is not how production should be deployed — that's GitOps, which often uses helm charts as well
- Good to know for platform work: you'll install charts and eventually write them

```bash
brew install helm
helm help
```

## Vocabulary

| Term | Meaning |
|---|---|
| **repository** | a place that serves charts; added to a list on your machine |
| **chart** | the package: templates + default values |
| **release** | one installation of a chart in a cluster, with a name you choose |
| **values** | the settings you pass in to override the chart's defaults |

## Repositories

```bash
helm repo add homarr-labs https://homarr-labs.github.io/charts/   # name on this machine + source URL
helm repo update                                        # refresh all repos (like a git pull)
helm repo list                                          # repos stored on this machine
```

The repo name is a local alias — the URL is the source. The course typed `oben01` here (the chart's earlier home); the current Homarr docs use `homarr-labs` ([install guide](https://homarr.dev/docs/getting-started/installation/helm/)). `helm repo list` shows what is stored.

## Install: Homarr

[Homarr](https://github.com/homarr-labs/homarr) is a customizable dashboard with tiles for all my apps; its chart is a good first example.

```bash
helm install homarr homarr-labs/homarr --namespace homarr --create-namespace
#            │     │             │                   └ create the namespace if missing
#            │     │             └ target namespace (default: the active one)
#            │     └ <repo>/<chart>
#            └ release name
```

```bash
kubectl get all -n homarr          # pod, service, deployment — more than just a pod
kubectl port-forward -n homarr svc/homarr 7575
# http://localhost:7575
```

- The current chart docs create a DB encryption secret before installing (`kubectl create secret generic db-encryption --from-literal=db-encryption-key=<key> -n homarr`); the install in the video worked with the defaults, so check the guide if a newer chart complains
- A chart is a **complete package** of resources — a platform team can hand developers a chart so they only supply their image and don't think about the service etc.
- In [k9s](../k9s.md): `:ns` → select `homarr`, `:svc`, `Shift+F` to port-forward
- Add a tile for mealie in Homarr's edit mode: `http://localhost:9000` (mealie runs on 9000, Homarr itself on 7575; use `http`, not `https`, on localhost)

## Releases

```bash
helm ls                 # releases in the current namespace
helm ls -A              # all namespaces (Rancher Desktop installs a few in kube-system itself)
```

## Uninstall

```bash
helm uninstall homarr -n homarr
```

Removes all resources the chart created, no leftovers to hunt down one by one. (The namespace was created by `--create-namespace` and stays.)

## Values

The chart's `values.yaml` lists every setting with its default; **your** values file only contains what differs.

```bash
helm show values homarr-labs/homarr          # the chart's default values
helm show values homarr-labs/homarr | vim -  # read in vim, see below
```

[values.yaml](values.yaml):

```yaml
replicaCount: 2

podLabels:
  hello: world
```

```bash
helm install homarr homarr-labs/homarr -n homarr --create-namespace --values values.yaml
kubectl get pods -n homarr             # two pods
```

(`--values` and `-f` are the same; a path is needed if the file isn't in the current directory.)

### Keep the structure

Nested keys must be nested the same way as in the chart's `values.yaml`:

```yaml
image:
  tag: "1.2.3"        # not a top-level `tag:`
```

The default tells you the shape the chart expects:

| Default in chart | You provide |
|---|---|
| `podLabels: {}` | an object: `key: value` |
| `imagePullSecrets: []` | a list: `- name: x` |
| `replicaCount: 1` | a scalar |

Chart READMEs list the values, but are sometimes generated, sometimes hand-written and outdated: when in doubt, the chart's `values.yaml` is the truth.

## Upgrade

Change the values file and apply it to the running release:

```bash
helm upgrade homarr homarr-labs/homarr -n homarr --values values.yaml
```

Changing a pod label redeploys the pods in a rolling update (`watch kubectl get pods -n homarr` or [k9s](../k9s.md) sorted by age). An upgrade is the normal way to reconfigure; uninstall and reinstall in the demo was only practice.

## How a chart works

```text
homarr/
  Chart.yaml        # name, version, dependencies — marks the directory as a chart
  values.yaml       # parameters and their defaults
  templates/        # Kubernetes manifests with placeholders
```

The templates are the manifests from [Deployments](../deployments/deployments.md) and [Services](../networking/services.md) with parameters in them:

```yaml
spec:
  replicas: {{ .Values.replicaCount }}
  ...
  image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
```

`helm install` renders every template: a value from your file replaces the placeholder, otherwise the chart's default is used (`default .Chart.AppVersion` = the fallback when no tag is set). The result is plain YAML applied to the cluster.

Use case: several similar apps that differ only in replicas or environment — parameterize once, deploy in different shapes instead of copying manifests.

## Cheat sheet

```bash
helm repo add <name> <url>
helm repo update
helm repo list
helm show values <repo>/<chart>
helm install <release> <repo>/<chart> -n <ns> --create-namespace -f values.yaml
helm upgrade <release> <repo>/<chart> -n <ns> -f values.yaml
helm ls -A
helm uninstall <release> -n <ns>
```
