# Storage classes & access modes

Part of [Storage](storage.md). Where a [persistent volume](persistent-storage.md) comes from, and how it can be mounted.

## Storage classes

A **StorageClass** is a cluster resource that defines *how and where* storage is provisioned — it depends on the platform.

```bash
kubectl get storageclass          # or: sc
```

- A PVC picks one with `spec.storageClassName`; leave it out and the **default** class is used
- **Rancher Desktop**: only `local-path` (default), provisions from the local machine
- **VMware**: vSphere volumes
- **Azure / AKS**: `managed-premium` (Azure Disk), `azurefile`, `azureblob-*`, CSI variants — a PVC with `managed-premium` makes AKS create an Azure disk and attach it to the cluster
- Each platform brings its own classes; provisioners are listed in the [Storage Classes docs](https://kubernetes.io/docs/concepts/storage/storage-classes/)

```yaml
spec:
  storageClassName: managed-premium   # example, not set in mealie-pvc.yaml
```

## Access modes

Set in `spec.accessModes` of the PVC/PV. Docs: [Access Modes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#access-modes)

| Mode | Short | Meaning |
|---|---|---|
| ReadWriteOnce | RWO | read-write by a **single node** |
| ReadOnlyMany | ROX | read-only by **many nodes** |
| ReadWriteMany | RWX | read-write by **many nodes** |
| ReadWriteOncePod | RWOP | read-write by a **single pod** |

- RWO pitfall: several pods sharing RWO storage are all forced onto **one node**, so no spreading over nodes
- Not every storage class supports every mode — check before production
- Rancher Desktop has one node, so `ReadWriteOnce` is fine (containers on that node can still all read and write)
