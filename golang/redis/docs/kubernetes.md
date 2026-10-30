# Kubernetes deployment

The goal is to run the [containerized server](docker.md) in its own namespace in a local Kubernetes cluster. The [architecture](architecture.md#kubernetes-deployment) describes the intended setup; the deployment steps below are a work in progress.

## Namespace
The namespace must exist before applying a Deployment.

```bash
# Generate YAML without creating the namespace
kubectl create ns redis-lab --dry-run=client -o yaml > namespace.yaml

# Check the cluster and namespace configured for the current context
kubectl config view

# Create the namespace and check that it exists
kubectl apply -f namespace.yaml
kubectl get namespaces

# Select a namespace for one command
kubectl get pods -n redis-lab
kubectl get deployments --namespace redis-lab

# Set the default namespace for the current context
kubectl config set-context --current --namespace=redis-lab
```

An empty namespace in the context means namespaced commands default to `default`. The Namespace resource itself is cluster-scoped and does not need `-n`.

## Deployment

The Deployment references the docker [built image](docker.md#building-the-container-image), which must be available to the Kubernetes node.

```bash
# Generate a Deployment manifest without creating it
kubectl create deployment redis-server -n redis-lab --image=redis-server:local --replicas=1 --dry-run=client -o yaml > deployment.yaml

# Apply the manifest in redis-lab and inspect the rollout
kubectl apply -n redis-lab -f deployment.yaml
kubectl rollout status deployment/redis-server -n redis-lab
kubectl get pods -n redis-lab
```

## Service

A LoadBalancer Service selects pods by label and provides a network endpoint.
```bash
# Generate a Service manifest without creating it
kubectl expose deployment redis-server -n redis-lab --type=LoadBalancer --port=6379 --dry-run=client -o yaml > service.yaml

# Apply the Service and check its address and endpoints
kubectl apply -n redis-lab -f service.yaml
kubectl get service redis-server -n redis-lab
kubectl get endpointslices -n redis-lab -l kubernetes.io/service-name=redis-server
```

The Service selector must match the pod labels.
