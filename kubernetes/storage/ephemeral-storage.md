# Ephemeral storage — `emptyDir`

Part of [Storage](storage.md). Data that lives exactly as long as the pod.

- Built-in volume type: an **empty directory**, created when the pod is assigned to a node
- **All containers in the pod** can read and write the same files
- **Deleted when the pod is deleted**
- `sizeLimit` caps it
- Use case: containers in one pod doing different jobs that need to hand files to each other — easier than going over the network

Docs: [emptyDir](https://kubernetes.io/docs/concepts/storage/volumes/#emptydir)

## Mount it

[nginx-emptydir.yaml](nginx-emptydir.yaml) — one nginx container first:

```yaml
spec:
  volumes:
    - name: scratch-volume
      emptyDir:
        sizeLimit: 500Mi
  containers:
    - name: nginx
      image: nginx
      volumeMounts:
        - name: scratch-volume
          mountPath: /scratch
```

```bash
kubectl apply -f nginx-emptydir.yaml
kubectl describe pod nginx-emptydir
# scratch-volume, Type: EmptyDir (a temporary directory that shares a pod's lifetime), SizeLimit: 500Mi
```

Check that `/scratch` comes from the manifest and not from the image:

```bash
kubectl exec -it nginx-emptydir -- bash
ls                                # /scratch is there

kubectl run nginx-temp --image=nginx
kubectl exec -it nginx-temp -- bash
ls | grep scratch                 # nothing
```

## Two containers sharing one volume

Add a second container to the `containers` array that mounts the **same volume name**. The full manifest is [nginx-emptydir.yaml](nginx-emptydir.yaml):

```yaml
    - name: busybox
      image: busybox
      command: ["/bin/sh", "-c"]
      args: ["sleep 1000"]          # keeps the container alive, see Pods
      volumeMounts:
        - name: scratch-volume
          mountPath: /scratch
```

- busybox needs a long-running process, otherwise it exits and ends up in `CrashLoopBackOff` — see [Pods](../kubernetes.md#pods)
- Adding a container to an existing pod is rejected — delete the pod and apply again (also in [Pods](../kubernetes.md#pods))
- Pick the container with `-c`, see [kubectl](../kubectl.md#run-commands-inside-a-pod)

### Demo: shared files

```bash
# nginx container
kubectl exec -it nginx-emptydir -c nginx -- bash
cd /scratch && echo hello > hello.txt

# busybox container (second terminal)
kubectl exec -it nginx-emptydir -c busybox -- sh
ls /scratch                       # hello.txt
watch -n1 ls -la /scratch         # live view

# back in nginx
touch world1 world2
echo world > world.txt            # shows up in busybox immediately
```

### Demo: data is gone with the pod

```bash
kubectl delete pod nginx-emptydir
kubectl apply -f nginx-emptydir.yaml
kubectl exec -it nginx-emptydir -c nginx -- bash
ls /scratch                       # empty
```

The volume is recreated, but empty. That's what `emptyDir` means — for data that has to survive, see [Persistent storage](persistent-storage.md).
