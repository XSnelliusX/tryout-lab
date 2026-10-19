# Storage

Containers are **ephemeral**: nothing stored inside them survives. To keep data, a container needs a **volume** — a piece of disk mounted into it (local disk, cloud disk, network storage). The data lives on the volume, a separate entity next to the container. Same idea as Docker volumes or a disk attached to a VM.

Kubernetes has two kinds, covered in separate notes:

| | [Ephemeral](ephemeral-storage.md) (`emptyDir`) | [Persistent](persistent-storage.md) (PV / PVC) |
|---|---|---|
| Lifetime | the pod | independent of any pod or deployment |
| Scope | one pod | cluster resource, claimed per namespace |
| Use case | scratch space, hand files between containers of a pod | databases, app data (mealie recipes) |

Where the persistent disk actually comes from is in [Storage classes & access modes](storage-classes.md).

Reference: [Volumes](https://kubernetes.io/docs/concepts/storage/volumes/) in the Kubernetes docs.

## Volumes in the pod spec

Two blocks on **different levels**, linked by the volume `name`:

| Block | Level | Meaning |
|---|---|---|
| `spec.volumes` | **pod** | which volumes are attached to the pod, and what kind they are |
| `spec.containers[].volumeMounts` | **container** | which container mounts which volume, and where (`mountPath`) |

```yaml
spec:
  volumes:                      # pod level
    - name: scratch-volume
      emptyDir: {}              # the volume type decides ephemeral vs persistent
  containers:
    - name: nginx
      volumeMounts:             # container level
        - name: scratch-volume  # must match the name above
          mountPath: /scratch
```

- A volume without any `volumeMounts` is accepted but useless — nothing uses it
- Each container picks its own mounts: container A can mount volumes 1 + 2, container B only 1
- Only the volume *type* changes between ephemeral and persistent — the two-block structure stays the same

```bash
kubectl describe pod <pod>      # Volumes: and Mounts: sections
```

Every pod already shows a volume you didn't define: the API server mounts a **secret** (service account token) automatically.

Manifests: [storage/](.)
