# Terminal Cheatsheet

Let a command run within an update interval to watch it change. It's very useful to see pod changes with `watch -n 1 "kubectl get pods"` — see it in action in [Deployments](../kubernetes/deployments/deployments.md).

```bash
watch -n 1 "<command>"      # runs the command with an update interval of 1 second
```

> Note: `watch` needs to be installed first on macOS using `brew install watch`
