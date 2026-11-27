---
title: Kubernetes
description: The kustomize base in deploy/k8s with one Deployment per role.
sidebar:
  order: 5
---

`deploy/k8s` is a kustomize base in the namespace `rchat`: one Deployment per role, a PeerJS pod, Valkey, network policies, an Ingress for ingress-nginx and autoscalers for the `api`, `gateway` and `web` Deployments. Postgres is yours: the pods reach it through `DATABASE_URL`.

1. Copy the secrets and fill them in:

   ```sh
   cp deploy/k8s/secrets.env.example deploy/k8s/secrets.env
   ```

   It holds `DATABASE_URL`, `VALKEY_PASSWORD` (`openssl rand -hex 32`), `REDIS_URL` with the same password, and optionally `DATABASE_REPLICA_URLS` and `INSTANCE_SIGNING_KEY`. Lines are `KEY=value` without quotes.

2. In `deploy/k8s/config.yaml`, replace the two `REPLACE` values: `TRUSTED_PROXIES` (the pod range of your ingress controller) and `PUBLIC_URL` (the address people open). The pods don't start until both are set.

3. In `deploy/k8s/ingress.yaml`, replace `chat.example.com` with your host.

4. Apply it:

   ```sh
   kubectl apply -k deploy/k8s
   ```

The Ingress routes paths like `deploy/nginx.conf`, sends `/peerjs` to the PeerJS pod and everything else, `/docs` included, to the `web` pods. It allows request bodies of 26 MB (`proxy-body-size`), which covers the default `UPLOAD_MAX_MIB` (25). P2P backups go up to `P2P_BACKUP_MAX_MIB` (64): raise the limit with either setting. Behind an L7 load balancer that appends to `X-Forwarded-For`, merge `deploy/k8s/ingress-nginx.example.yaml` into your controller's settings.

The built-in relay is not in the base. `deploy/k8s/relay.yaml` explains how to add it as one host-network pod.
