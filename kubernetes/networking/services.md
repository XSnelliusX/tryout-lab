# Services

Services are the main concept to grasp in Kubernetes [networking](networking.md): they group pods behind **one stable endpoint** — a name that resolves through the cluster DNS and an IP that doesn't change.

## Why services are needed

- Pods are **ephemeral**: rollouts replace them one by one, scaling moves them across nodes — counting on a pod's IP to stay alive is a losing game.
- A service is a **grouping of pods** (e.g. all pods of the front-end [deployment](../deployments/deployments.md)): point your app at the service and Kubernetes figures out which live, ready pod gets each request.
- That also makes rolling updates seamless — while one pod is being replaced, traffic keeps flowing to the pods that are still alive.

Mental model: a `frontend` service in front of the nginx pods, a database service behind them — apps only ever refer to the services, never to individual pods.

## Create

The quick way is `expose` — it looks up a resource (deployment, pod, …) by name and uses its selector for a new service. Handy in the home lab, but real work happens in YAML:

```bash
kubectl expose deployment frontend --port=8080
# service/frontend exposed
```

Inspect it:

```bash
kubectl get services          # or the short form: k get svc
kubectl get svc -o wide       # shows the selector, e.g. app=frontend
```

> Note: the selector is the link — the service finds its pods by **label** (`app: frontend` in the deployment template, see [Deployments](../deployments/deployments.md)) and load-balances traffic between them.

### The service DNS name

A service is reachable cluster-wide as `<service>.<namespace>.svc.cluster.local` — a single DNS address no matter how many pods sit behind it:

```text
frontend.default.svc.cluster.local      # the example service
kapok-db-rw.kapok.svc.cluster.local     # real-world POC: a database service in the kapok namespace
```

> Tip: `svc` is the short form of `service` — the same abbreviation as in the DNS name.

## Service types

Set with `spec.type` (or edited live with `kubectl edit svc frontend`):

- **ClusterIP** *(default)* — a cluster-wide IP, stable for as long as the service exists. Only reachable from inside the cluster.
- **NodePort** — exposes a port on **every node**; reachable from outside via `<node-ip>:<port>`. Works for a home lab, but rare in the cloud — it means working with IP addresses, which you want to avoid.
- **LoadBalancer** — the cloud controller provisions a real load balancer (e.g. an Azure LB for AKS) and gives the service an **external IP**. Also works on [Rancher Desktop](../rancher.md), where the external IP lands on the local machine.

> Note: on a fresh `kubeadm` cluster with no load-balancer controller, a LoadBalancer service stays `<pending>` — nothing assigns it an external IP. Rancher Desktop ships one.

## mealie: from port-forward to LoadBalancer

The [mealie deployment](../mealie_test_deployment/deployment.yaml) listens on port 9000 — exposed as a service instead of port-forwarding to the pod directly (kill that pod and the port-forward dies with it):

```bash
kubectl config set-context --current --namespace=mealie   # switch to the mealie namespace

kubectl expose deployment mealie --port=9000              # ClusterIP on 9000 first
kubectl get svc                                           # mealie ... ClusterIP ... 9000/TCP
kubectl port-forward svc/mealie 9000                      # services can be port-forwarded too
```

Then promote it to a LoadBalancer **in code**: dump the service YAML, strip the noise (timestamps, resourceVersion, UUID, clusterIPs, sessionAffinity, status), set the type, and apply:

```bash
kubectl get svc mealie -o yaml > service.yaml
```

```yaml
apiVersion: v1
kind: Service
metadata:
  name: mealie
  namespace: mealie
  labels:
    app: mealie
spec:
  type: LoadBalancer
  selector:
    app: mealie
  ports:
    - port: 9000
```

```bash
kubectl delete svc mealie       # remove the old one to avoid duplicates
kubectl apply -f service.yaml
kubectl get svc                 # mealie ... LoadBalancer ... EXTERNAL-IP ... 9000/TCP
```

The external IP is the address of the local machine — mealie is now reachable at `localhost:9000` or `<external-ip>:9000` in the browser, **no port-forward needed**. Put the IP in your favorites and the app is always there.

> Tip: on k3s / Rancher Desktop, LoadBalancers are the easy way to expose a few apps while experimenting. In practice most exposure goes through **ingress** — the next lesson.

## Cleanup

```bash
kubectl delete svc frontend     # service only — the pods keep running
```
