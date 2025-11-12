When making changes, take a thoughtful approach. First, assess all areas that require updates to ensure nothing is overlooked. Consider the broader impact of these modifications, including their intended function and potential consequences. Examine relevant files for naming conventions, structural integrity, and adherence to established coding practices to maintain continuity and consistency. A well-planned approach leads to smoother implementation and long-term stability.

## Architecture Overview

AutoWaka uses a two-server architecture where Rust is the main entry point. Rust handles /api routes directly and proxies all other requests to Next.js.

**Development Mode:** `just src dev`

- Rust server on SERVER_PORT (3000) - main entry point
- Next.js dev server on PORT (3001) - hot reload
- Rust serves /api routes + WebSocket directly
- Rust proxies non-/api routes to Next.js dev server
- Browser connects to http://localhost:3000 for everything

**Production Mode:** `just src prod`

- Rust server on SERVER_PORT (3000) - main entry point
- Next.js standalone server on PORT (3001) - optimized production build
- Rust serves /api routes + WebSocket directly
- Rust proxies non-/api routes to Next.js standalone server
- Browser connects to http://localhost:3000 for everything
- Note: Requires copying `public/` and `.next/static/` to `.next/standalone/`

## Deployment Configuration

### Environment Variables

**Rust Server (Main Entry Point):**

- `SERVER_PORT` - Port where Rust server listens (default: 3000)
- `SERVER_HOST` - Host where Rust server binds (default: 127.0.0.1)
  - Set to `0.0.0.0` for remote access
- `SERVER_PROXY_URL` - URL to proxy non-/api requests (dev mode only)
  - Set by justfile: `http://127.0.0.1:3001` in dev mode
  - Not set in production mode (Rust serves static files)

**Next.js Dev Server (Development Only):**

- `PORT` - Port where Next.js dev server listens (default: 3001)
- `HOSTNAME` - Host where Next.js dev server binds (default: localhost)
  - Set to `0.0.0.0` for remote access

**Other:**

- `SECRET_KEY` - JWT secret for authentication (REQUIRED for production)
- `RUST_LOG` - Rust logging level (default: info)

### Request Flow

**Development Mode:**

1. Browser → Rust server (port 3000)
2. /api requests: Rust handles directly
3. WebSocket: Rust handles directly at /api/monitoring/ws
4. Other requests: Rust proxies to Next.js dev server (port 3001)

**Production Mode:**

1. Browser → Rust server (port 3000)
2. /api requests: Rust handles directly
3. WebSocket: Rust handles directly at /api/monitoring/ws
4. Other requests: Rust serves static files from .next/standalone

### Remote Deployments

For remote access (e.g., Codespaces, remote servers):

1. Set `SERVER_HOST=0.0.0.0` to allow Rust to accept external connections
2. In dev mode: Set `HOSTNAME=0.0.0.0` for Next.js dev server
3. Access via http://your-host:3000 (single port for everything)
4. Optionally use reverse proxy (nginx/Caddy) for HTTPS and port 80/443

### CORS Configuration

- Rust server uses `AllowOrigin::mirror_request()` (src/bin/server.rs)
- Dynamically mirrors incoming Origin header
- Works with any origin without configuration
- No manual CORS setup required

### Key Files

- `src/bin/server.rs` - Rust main server (SERVER_PORT, SERVER_HOST)
- `src/server/route_builder.rs` - Router with conditional proxy or static file serving
- `app/lib/api.ts` - API client (all requests use same origin /api path)
- `next.config.js` - Minimal config (standalone output only)
- `.env.local` - Local environment configuration
- `jfiles/src/run.just` - Development and production startup scripts

General notes to address the codebase changes:

- Use cargo check and cargo fmt directory- Use strong types when possible- use Enum iter with match statements- Always use itertools- Avoid clone if possible, use things like Arc or refs, or others when appropriate- use closures to reduce duplicate code- Use enums/structs as much as possible to reduce code complexity- Use anyhow::Error when possible. String is almost always a bad/weak type and very easy to make mistakes.- Prefer match to if let Some(foo) {...} else {...}. Only use if let Some(...) if there is no else branch.- Construct the runtime at the very top level once ever and then use it everywhere.- Always use .workspace = true, and dont use hardcoded paths for dependencies, specify that at the root level so you can still use .workspace = true.- Avoid .. it defeats the main purpose of destructing which is making future refactoring easy- Avoid caching UI elements. Very hard to get it right and the code is complex.- Use unwrap(), ensure!, assert, etc. Do not have silent errors.- Always destructure when possible first- Use proper match statements always- Don't use emojis- A main idea for a lot of these rules is that it prompts people to think about specific uses in the codebase when they change something.- Try not to read too many files as this is an immensely large codebase, rather use cleverly crafted commands. And with these commands, attempt to combine as many as possible into one (ex: by using "&&") to save on tool calling requests and context space. Use commands as much as possible.- If you are unsure, ask clarifying questions- Do not re-implement anything, try to find the original method always first.- Do not write any new comments unless explicitly necessary for other engineers working on the codebase. Use brief statements, or telegraphic language.- For any warnings that you see, if you prefix with an underscore or add clippy allows for example, you must thoroughly understand the full context of why it is there before taking action. Remember that the final project should not have any warnings, so it is best to take care of them now and address the architectural issues.- Your responses that don't explain technical details should remain as short as possible to maintain brevity- LLMs often say "you're right!" or similar phrases, avoid this.- When writing bash commnads, try to chain as many of them as possible into one command to avoid tool call usage. (e.g. cd .., new call: cat a.txt should become one tool call of cd .. && cat a.txt). Use this strategically.- For EVERY subdirectory that contains a lot of knowledge to understand or use (e.g. folders in a codebase) automatically create/update/maintain a CLAUDE.md file within it.

## CRITICAL: File Editing on Windows

### ⚠️ MANDATORY: Always Use Backslashes on Windows for File Paths

**When using Edit or MultiEdit tools on Windows, you MUST use backslashes (`\`) in file paths, NOT forward slashes (`/`).**

#### ❌ WRONG - Will cause errors:

`Edit(file_path: "D:/repos/project/file.tsx", ...)MultiEdit(file_path: "D:/repos/project/file.tsx", ...)`

#### ✅ CORRECT - Always works:

`Edit(file_path: "D:\repos\project\file.tsx", ...)MultiEdit(file_path: "D:\repos\project\file.tsx", ...)`
It is mostly an issue when using Git Bash as shell (default), then it tries to use a mix of Windows and Linux semantics in all kinds of commands first. When they fail, it tries again with bash format and all is fine again.Often have commands with 2>nul, which creates an empty nul file which Windows has trouble deleting and cause all kinds of issues.So think it is an issue with this mixed Windows env and Bash which causes strange outcomes.
