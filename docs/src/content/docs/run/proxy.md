---
title: Proxy and TLS
description: Putting a reverse proxy with TLS in front of the server on one domain.
sidebar:
  order: 6
---

A proxy in front of the server serves one domain on port 443. It sends every path to `SERVER_PORT` and passes the WebSocket upgrade for `/api/ws`, `/api/v1/ws` and `/peerjs`. The app, the API, realtime connections, P2P signaling and these docs all live on that one address. Only WebRTC between browsers, and the optional relay on its own UDP ports, go elsewhere.

Set on the server:

- `PUBLIC_URL`: the address people open, for example `https://chat.example.com`. The instance names itself with it in `/api/v1/instance`, sign-in redirects and identity assertions. Without it, the instance uses the request's host only when that host is loopback or listed in `ALLOWED_HOSTS`.
- `TRUSTED_PROXIES`: the proxy's address or range. The server then takes the client address from `X-Forwarded-For` for its rate limits. Without it, every client counts as the proxy's address.

Other instances accept this instance's identity assertions only when its public address uses port 443.

## nginx

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name chat.example.com;
    # ssl_certificate and ssl_certificate_key for the domain

    client_max_body_size 65m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
    }
}
```

`client_max_body_size` lets through the largest upload (`UPLOAD_MAX_MIB`, 25 MiB by default) and the largest P2P backup (`P2P_BACKUP_MAX_MIB`, 64 MiB). Raise it when you raise those. `deploy/nginx.conf` is the configuration of the scaled Compose example, which routes paths to the role containers.
