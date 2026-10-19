# Monitoring with kube-prometheus-stack

Prometheus + Grafana is the de facto standard for Kubernetes monitoring. The **kube-prometheus-stack** helm chart deploys the whole thing with sensible defaults and is used in production in many places. Uses [helm](../helm/helm.md) on the local [Rancher Desktop](../rancher.md) cluster.

## Metrics and the components

A **metric** is a number that describes the status or performance of something, e.g. the CPU or memory usage of a pod. The stack collects them from everything in the cluster and visualizes them.

| Component | Job |
|---|---|
| **Prometheus** | collects and stores metrics as **time series**: every value has a timestamp, so you see how it develops over time |
| **Alertmanager** | alerts based on thresholds, e.g. "pod memory reaches 800 MB → send an email" (also Telegram and others) |
| **Grafana** | dashboards that visualize what Prometheus stores |
| **Prometheus operator** | simplifies deploying and configuring Prometheus through custom resources, e.g. a `PodMonitor` YAML: label some pods and they are monitored |
| **kube-state-metrics** | asks the API server for the state of objects (deployments, pods, ...) and exposes it as metrics |
| **node exporter** | agent on every node, exposes the node's own CPU, memory, etc. |

- An **operator** enables custom resource definitions (CRDs) on the cluster — a term you'll hear a lot
- Prometheus and Grafana are not Kubernetes-only (plain Go binaries, also run on VMs); here they run as pods

## Install

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
helm install prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace
```

```bash
#            ┌ release name, reused in the service names below
#            │                ┌ <repo>/<chart>
#            │                │
helm install prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace
# │                      │
# │                      └ create the namespace if missing
# └ target namespace
```

Pulling the images takes a few minutes.

```bash
helm ls -A                         # prometheus-stack
kubectl get pods -n monitoring
```

In [k9s](../k9s.md): `0`, `Shift+A` — the new pods are on top; `1`/`:ns` for the monitoring namespace.

## Open Grafana

The chart creates services for its components (`:svc` in k9s) — `prometheus-stack-grafana` is the one for Grafana.

```bash
kubectl port-forward -n monitoring svc/prometheus-stack-grafana 3000
# http://localhost:3000
```

Or in k9s: `:svc`, select it, `Shift+F`. (k9s suggests port 3000 from the pod spec; the `F` marker in the pod list shows an active forward.)

### Finding the admin password

Current chart versions don't ship a fixed password. The install output ends with the command to read it from the secret the chart created (login `admin`):

```bash
kubectl --namespace monitoring get secrets prometheus-stack-grafana \
  -o jsonpath="{.data.admin-password}" | base64 -d ; echo
```

- The secret name is `<release>-grafana`, so `prometheus-stack-grafana` here
- Secret values are stored base64-encoded: `jsonpath` picks the field, `base64 -d` decodes it, `echo` adds the missing newline
- Missed the output? `helm get notes prometheus-stack -n monitoring` prints it again

> Note: the video was recorded with an older chart where the default was `prom-operator` (`admin` / `prom-operator`). Same lesson as always: the chart changes, read the install output.

The video's way of finding it is still the general technique for any chart setting, so keep it: look through the default values instead of searching the web.

```bash
helm show values prometheus-community/kube-prometheus-stack > prometheus-default-values.yaml
vim prometheus-default-values.yaml      # ~4500 lines
```

- Too big to read through — don't try. **Start with the defaults, then adjust** what the setup needs (an ingress, resource requests, ...) by searching the file
- Sub-charts have their own top-level block: `/grafana` + `n` jumps to the Grafana section, or search `/password`
- Here that leads to `grafana.adminPassword`

Search keys in vim: [usage](../../mac-setup/nvim/usage.md).

## Custom password

Keep the same nesting as in the chart's values: [values.yaml](values.yaml)

```yaml
grafana:
  adminPassword: hello-world
```

```bash
helm upgrade prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring --values values.yaml
```

- A new Grafana pod rolls out; the old one terminates
- The port-forward dies with the old pod — forward again, then log in with the new password (the old one now fails; the chart stores it in the same `prometheus-stack-grafana` secret)
- A password in a values file in git is only fine in a lab. In production, use a secret (`existingSecret`-style values, see [chart prerequisites](../helm/helm.md#prerequisites-outside-the-chart))
- Configuring any other part of the stack works the same way: find the setting in the default values, copy its structure into your values file, `helm upgrade`

## LoadBalancer instead of port-forward

Port-forwarding is fragile. As with mealie ([Services](../networking/services.md)), a LoadBalancer service gives an external IP you can bookmark or put in a dashboard such as Homarr.

[grafana-service.yaml](grafana-service.yaml), based on the mealie `service.yaml`:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: grafana-loadbalancer
  namespace: monitoring
spec:
  type: LoadBalancer
  selector:
    app.kubernetes.io/instance: prometheus-stack
    app.kubernetes.io/name: grafana
  ports:
    - port: 3000
      targetPort: 3000
```

- **namespace**: `monitoring`, where the chart's Grafana lives
- **selector**: which pods get the traffic — copy the labels from the chart's service (`d` in k9s on `prometheus-stack-grafana`, or `kubectl describe svc -n monitoring prometheus-stack-grafana`); `instance` is the release name
- **targetPort**: 3000, Grafana's container port (the default service describes it as its target port)

```bash
kubectl apply -f grafana-service.yaml
kubectl get svc -n monitoring          # grafana-loadbalancer ... EXTERNAL-IP ... 3000
# http://<external-ip>:3000
```

On k3s / Rancher Desktop a short-lived helper pod sets up the networking; it's gone quickly. The IP works as long as the cluster runs.

## Dashboards

Grafana → Dashboards: the stack ships a set of default dashboards.

- Grafana may offer to save a changed dashboard repeatedly — **discard**: they are provisioned from JSON files and the permissions don't allow saving
- Some default dashboards show "no data" on Rancher Desktop (e.g. the cluster ones). **Node Exporter / Nodes** works: IP of the VM, CPU, load average, memory
- **Import a dashboard**: Dashboards → New → Import → paste the JSON model → Load. Community dashboards are a good starting point: take one and adapt it
- The course's own overview dashboard (`simple-overview.json`, in the instructor's lab repo) is namespace-based: resource counts, CPU and memory per pod, a namespace filter, and a time range (e.g. last 5 minutes to months) — that's the time series in action
- **Explore** in Grafana lets you pick metrics and query them directly
