# Rancher Desktop — Notes [https://rancherdesktop.io/](https://rancherdesktop.io/)

## What it is

- Desktop app (macOS / Windows / Linux) that gives you containers **and** Kubernetes on your machine — very similar to Docker Desktop.
- Not to be confused with **Rancher** (cluster management for production). Rancher Desktop is just a local dev tool; the two complement each other.
- On macOS/Linux it runs everything inside a **VM**; on Windows it uses **WSL2**. The VM also contains the Kubernetes cluster.
- Kubernetes is provided by **k3s**, a lightweight certified Kubernetes distribution.

## Container engines (chosen on first boot)

- **containerd** → use `nerdctl` (Docker-compatible CLI for containerd), plus `nerdctl compose` instead of `docker compose`
- **dockerd / Moby** → classic `docker` CLI — this is what we want ✅
- All the usual `docker` commands work, just like with Docker Desktop.

## Networking

- Uses **Traefik** as the default ingress controller (can be disabled in settings — it's opt-out).
- On Linux only: ports below 1024 need extra permissions for non-root users.

## Settings / Preferences

- **VM resources** (memory, CPUs): Preferences → Virtual Machine → Hardware
- **Kubernetes version**: Preferences → Kubernetes (first run of a new version downloads images, takes a while)
- Also included out of the box: `kubectl`, `helm`, `docker compose`

## Troubleshooting

- Problems with the cluster? **Troubleshooting → Reset Kubernetes** → gives you a completely fresh cluster.
- There's also an option to reset **Kubernetes + container runtime** together (wipes images too).

## Verify installation

After installing, `kubectl` and `docker` should both be available in your terminal. Test with:

```bash
kubectl get pods   # should return `No resources found in default namespace.` at first start
```