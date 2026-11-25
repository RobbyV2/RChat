# Local Authentik demo

Run this from the repository root in one Bash shell, and keep the shell for the later commands:

```bash
demo_dir=$(mktemp -d)
export DATABASE_URL="$demo_dir/rchat.db"
demo_project="rchat-authentik-$(openssl rand -hex 8)"
printf '%s\n' "$demo_project" > "$demo_dir/compose-project"
cargo run --bin server -- user create demo-admin

for key in PG_PASS AUTHENTIK_SECRET_KEY OIDC_AUTHENTIK_CLIENT_SECRET SCIM_TOKEN DEMO_ALICE_PASSWORD DEMO_BOB_PASSWORD; do export "$key=$(openssl rand -hex 32)"; done
export PUBLIC_URL=http://localhost:3000 OIDC_PROVIDERS=authentik OIDC_AUTHENTIK_CLIENT_ID=rchat
export OIDC_AUTHENTIK_ISSUER=http://localhost:19000/application/o/rchat/ OIDC_AUTHENTIK_NAME=Authentik
export SCIM_PROVIDER=authentik SSO_GROUP_MAP='{"rchat-staff":[{"server":"staff"}],"eng":[{"server":"eng","role":"Developer"}]}'
docker compose -p "$demo_project" -f deploy/authentik/compose.yml up -d
just src dev
```

Sign in at http://localhost:3000 as `demo-admin` with the temporary password the admin command printed, create the servers `staff` and `eng`, and add a `Developer` role to `eng`. On native Linux, Authentik reaches the server at `host.docker.internal:3000` only through a forwarder in another terminal: `socat TCP4-LISTEN:3000,bind="$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}')",fork TCP4:127.0.0.1:3000`.

Complete the setup as `akadmin` at http://localhost:19000/if/flow/initial-setup/, then under Applications → Providers → RChat SCIM choose **Run scheduled task now**.

Choose **Continue with Authentik** and sign in as `alice` (password `$DEMO_ALICE_PASSWORD`, groups `rchat-staff` and `eng`) or `bob` (`$DEMO_BOB_PASSWORD`, `rchat-staff`).

Stop the forwarder and remove the demo with `docker compose -p "$demo_project" -f deploy/authentik/compose.yml down -v`. For production, use HTTPS addresses and your own credentials.
