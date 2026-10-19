# Ingress

Last part of [networking](networking.md) fundamentals. Concept only, no hands-on yet (advanced topic, maybe in the advanced course).

## What / why

- LoadBalancer service = IP + port. Real apps need a **domain name** (FQDN) + certificate
- **Ingress** = resource that exposes **HTTP/HTTPS routes** from outside the cluster to services inside
- Features:
  - **SSL/TLS termination** (cert on the ingress, e.g. cert-manager)
  - external URL
  - **path-based routing**: `/frontend` → frontend service, `/database` → database service
- URLs = ingress

## Ingress controller

- Ingress = just YAML (`kubectl create ingress ...`), does nothing without an **ingress controller**
- Controllers: **NGINX**, **Traefik**, **Cilium**, AKS: Application Gateway ingress controller
- Managed clusters usually bring their own
- Rancher Desktop: **Traefik** (pod in `kube-system`)

```bash
kubectl get pods -A              # traefik in kube-system
kubectl get svc -n kube-system   # traefik LoadBalancer, ports 80 + 443
```

## Flow

```text
browser (home.example.net)
  → DNS provider (e.g. Cloudflare): domain → IP
  → LoadBalancer created by the ingress controller (80/443)
  → ingress controller reads the Ingress rules
  → Service
  → Pod
```

- Ingress has a routing rule: host → service + port
- Pods behind the service can change freely, requests always end up on a live pod

## Example shape

Not a manifest from this repo, just the shape:

```yaml
kind: Ingress
spec:
  ingressClassName: traefik      # which controller
  rules:
    - host: home.example.net     # domain to listen on
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: homarr     # route to this service
                port:
                  number: 7575
  tls:                           # cert, e.g. via cert-manager
    - hosts: [home.example.net]
```

> Note: first few times configuring an ingress it won't work — normal, gets easier

## Recap networking

- Networking on the **pod level**, implemented by the **CNI plugin** ([networking](networking.md))
- **Services** = one stable endpoint in front of changing pods ([services](services.md))
  - ClusterIP: default
  - NodePort: ports on the nodes, generally not used
  - LoadBalancer: external IP, common in the cloud when not using ingress
- **Ingress** = URLs → services
- Rancher Desktop: LoadBalancer service ([service.yaml](service.yaml)) for exposing apps while experimenting

## Exercises

- nginx namespace + deployment, make it reachable from the browser
- other image, expose with LoadBalancer service

Next: [Storage](../storage/storage.md) — the mealie recipes are gone when the pod is, so the app needs a persistent volume.
