# Networking

Networking in Kubernetes happens on the **pod level** — it connects pods to each other, not individual containers. The topic looks daunting at first, but a small subset of it covers everything needed to run apps on the home lab and to understand what's happening on production clusters.

Examples run on the local [Rancher Desktop](../rancher.md) cluster.

## Every pod gets an IP address

```bash
kubectl get pods -A          # all namespaces
kubectl get pods -A -o wide  # adds the IP column
```

- Every pod gets its own IP, no matter which node it runs on — that's how pods reach each other (e.g. pinging the [mealie](../mealie_test_deployment/deployment.yaml) pod from another pod).
- Pods without an IP are **Jobs**: one-off tasks that run in a pod, and once completed the pod no longer needs its IP — it goes back to the pool so another pod can use it later.

> Tip: a missing IP in `get pods -A -o wide` means a finished Job, not a broken pod.

## The pod CIDR

- Pod IPs come from the **pod CIDR** — the IP range Kubernetes may assign from, configured when the cluster is created (e.g. with Talos or `kubeadm`).
- The range is not unlimited — pick it mindfully. It can be extended, but that's beyond the fundamentals.

## Everything can talk to everything

- On a default vanilla cluster, **every pod can reach every other pod** — regardless of node or namespace.
- Traffic can be limited with **network policies**: e.g. "pods in the mealie namespace may only talk to each other, plus CoreDNS in `kube-system`". Very granular, but out of scope for the fundamentals course — what namespaces isolate is in [Namespaces](../namespaces/namespaces.md).

## Containers talk over localhost

- A pod is like a small, lightweight VM: its containers share the network and reach each other on **localhost** + port — same as running multiple containers on your own machine.
- Containers in a pod **cannot share a port** — each one needs its own.

The [mealie deployment](../mealie_test_deployment/deployment.yaml) listens on port 9000; `port-forward` tunnels a local port to the pod, see [kubectl](../kubectl.md) and [Namespaces](../namespaces/namespaces.md) for the flags:

```bash
kubectl port-forward -n mealie deploy/mealie 9000
# then browse to http://localhost:9000
```

## CNI — the plugin that wires it together

- The **CNI** (Container Network Interface) plugin provides the network connectivity to containers and configures their network interfaces.
- Mental model: it slots a virtual **NIC** (network interface card) into every container, plugs a wire into it, assigns the IP address, and sets up the routes in between.
- Every node is a Linux VM, and its networking is configured through **iptables** — all handled under the hood by the CNI plugin.
- Setting up a cluster from scratch means picking a CNI: **Cilium** (what the home lab Talos cluster runs), **Calico**, or **Flannel** (very basic).
- Same choice in the cloud: creating an AKS cluster asks for **Azure CNI**, **kubenet**, or bring-your-own CNI.

## Inside a container

The CNI configures an `eth0` interface in every container:

```bash
docker run -it ubuntu   # throwaway container
# apt update && apt install -y iproute2, then:
ip a                    # eth0 with its IP, set up by the CNI
```

## Which CNI is the cluster running?

Rancher Desktop ships **flannel**. Find it by shelling into the VM with `rdctl` (installed together with Rancher Desktop):

```bash
rdctl shell                              # into the Rancher Desktop VM
tree /etc/cni                            # shows 10-flannel.conflist
cat /etc/cni/net.d/10-flannel.conflist   # "type": "flannel"
```

> Tip: this is where Linux basics pay off (and why they're on the CKA exam) — getting into nodes and reading the cluster manifests, which are just text files on the file system.

## Services (next up)

So how do pods actually get made available on the network? With **Services** — a stable endpoint in front of the ever-changing pod IPs, covered in [Services](services.md).
