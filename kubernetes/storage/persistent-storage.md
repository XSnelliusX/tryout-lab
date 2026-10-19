# Persistent storage — PV and PVC

Part of [Storage](storage.md). Storage that outlives pods and deployments — what you work with most of the time in real clusters.

Docs: [Persistent Volumes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/)

## PV and PVC

Two resources, both living **in the cluster**, independent of any pod:

- **PersistentVolume (PV)** — a piece of storage in the cluster, a cluster-wide resource like a node
- **PersistentVolumeClaim (PVC)** — an app's request for a piece of storage; **namespaced**, and a pod can only mount claims from its own namespace

Mental model: the PV is a huge disk, the PVC is planting your flag on a small piece of land on it.

### Static vs dynamic provisioning

- **Static**: an admin creates a big PV beforehand, everybody claims a piece of it
- **Dynamic** (the common case): create only a PVC and the [storage class](storage-classes.md) provisions a **small PV just for that claim**
  - The PV can be larger than the claim
  - Dynamically provisioned PVs have generated names (`pvc-<uuid>`), which is how you recognize them

## Example: mealie

Mealie stores its database and recipes in `/app/data`; without a volume they're gone with the pod.

### 1. The claim

[mealie-pvc.yaml](mealie-pvc.yaml):

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: mealie-data
  namespace: mealie
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 500Mi
```

- No `storageClassName` → the cluster's **default** [storage class](storage-classes.md)
- `accessModes` → [access modes](storage-classes.md#access-modes)

```bash
kubectl apply -f mealie-pvc.yaml
kubectl get pvc -n mealie        # Pending
kubectl get pv                   # nothing yet
```

**Pending is normal.** Nothing uses the claim yet, so nothing is provisioned (the local-path class waits for the first consumer).

### 2. Mount it in the deployment

[mealie-deployment-pvc.yaml](mealie-deployment-pvc.yaml) — the [networking deployment](../networking/deployment.yaml) plus a volume. Same structure as [emptyDir](ephemeral-storage.md), only the volume type changes:

```yaml
spec:
  template:
    spec:
      volumes:                         # pod level
        - name: mealie-data
          persistentVolumeClaim:       # instead of emptyDir
            claimName: mealie-data     # the PVC
      containers:
        - name: mealie
          volumeMounts:                # container level
            - name: mealie-data        # the volume above
              mountPath: /app/data
```

The volume `name` is arbitrary, `claimName` must match the PVC.

```bash
kubectl apply -f mealie-deployment-pvc.yaml
kubectl get pvc -n mealie        # Bound, VOLUME pvc-<uuid>, 500Mi
kubectl get pv                   # the provisioned PV
kubectl describe pod -n mealie <pod>   # mealie-data (PersistentVolumeClaim) at /app/data
```

Add a recipe in the UI, then look at the files:

```bash
kubectl exec -it -n mealie deploy/mealie -- bash
cd /app/data && ls               # users, mealie.log, database, ...
```

### 3. The claim outlives the deployment

```bash
kubectl delete deploy mealie -n mealie
kubectl get pvc -n mealie        # still there
kubectl get pv                   # still there
```

PVC and PV are their own resources. Any other pod can mount the same claim — [nginx-pvc.yaml](nginx-pvc.yaml) is the earlier nginx pod with `emptyDir` swapped for the claim:

```yaml
  volumes:
    - name: scratch-volume
      persistentVolumeClaim:
        claimName: mealie-data
```

```bash
kubectl apply -f nginx-pvc.yaml
kubectl exec -it -n mealie nginx-pvc -- ls /scratch   # mealie database + log
kubectl delete pod -n mealie nginx-pvc
```

Wait until the pod is fully terminated before re-attaching the claim somewhere else (`ReadWriteOnce`), then re-apply the deployment: the recipes are still there.

## Recap

- `emptyDir` = per pod; PV/PVC = own cluster resources that survive pods
- Static: PV first, then claims. Dynamic: claim first, PV generated
- PVC is `Pending` until a pod uses it, then `Bound`
- Mount = `volumes[].persistentVolumeClaim.claimName` (pod level) + `volumeMounts` (container level)

```bash
kubectl get pvc -n <ns>
kubectl get pv
```
