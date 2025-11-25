# RChat

An intentionally opinionated, anonymous (but not private) chat platform built with Rust (Axum) and Next.js. RChat makes unconventional design choices that prioritize user freedom and casual communication over traditional security practices.

## Philosophy: Intentional Non-Industry Practices

RChat deliberately deviates from industry standards in several ways. These are **not oversights** - they are intentional design decisions that reflect a specific philosophy about online communication.

### 1. No Password Complexity Requirements

**Industry Standard:** Minimum 8 characters, mixed case, numbers, special characters
**RChat:** Single character passwords ("a") are valid

**Rationale:** Password complexity requirements create friction for casual, anonymous (not private) communication. Users should be free to choose trivial passwords if they want disposable, low-stakes accounts. This platform is designed for ephemeral conversation, not sensitive data storage.

### 2. No Data Encryption (Database as the Site)

**Industry Standard:** Encrypt data at rest and in transit (beyond TLS)
**RChat:** A single SQLite `.db` file stores absolutely everything in plaintext (except site config env vars).

**Rationale:** RChat explicitly rejects the notion of privacy. This is a public-by-default platform where users should assume everything they write is visible. The database file _is_ the site; portability and transparency are prioritized over secrecy. No encrypted storage means no false sense of security. The transparency is the point.

### 3. Public Servers as IDs

**Industry Standard:** Randomly generated server IDs, hidden/private servers, invite-only links
**RChat:** Server names are unique identifiers and join codes. All servers are effectively public if you know the name.

**Rationale:** Simplifies discovery and sharing. If you can name it, you can join it. This reinforces the public-square nature of the platform.

### 4. Read-Only Public / Writeable Private (Guest Mode)

**Industry Standard:** Login wall for all content, or separate public view
**RChat:** The entire site is accessible in a read-only "Guest Mode" by default. Accounts are only required to _write_ (send messages, create servers).

**Rationale:** Information should be free to access. The barrier to entry (account creation) is only strictly enforced when a user wants to contribute content, not when they just want to observe. Guest state (joined servers) is stored locally in the browser.

### 5. Unlimited Login Attempts (with throttling)

**Industry Standard:** Lock accounts after 3-5 failed attempts
**RChat:** Unlimited attempts, 3-second gap between tries, lock only after 1000 attempts (for 24 hours)

**Rationale:** Account security is the user's responsibility, not the platform's. If someone chooses "a" as their password, they've made a choice. The 3-second throttling prevents automated brute force while still allowing humans to try repeatedly. The 1000-attempt threshold exists solely to prevent DOS attacks, not to protect users.

### 6. Automatic Media Deletion After 1 Day

**Industry Standard:** Persistent storage, user-controlled deletion
**RChat:** All files (up to 25MB) auto-delete after exactly 24 hours

**Rationale:** Ephemeral by default. Conversations should be temporary. This prevents the platform from becoming a file hosting service and enforces the philosophy of transient communication.

### 7. No User-to-User Encryption in DMs

**Industry Standard:** End-to-end encryption for private messages
**RChat:** Server can read all DMs, stored in plaintext

**Rationale:** Transparency extends to direct messages. If you want truly private communication, use Signal. RChat is for casual chats where perfect privacy isn't the goal.

### 8. Profanity Filtering (Not User Choice)

**Industry Standard:** User-controlled content filters
**RChat:** Server-side mandatory profanity censoring in public servers (disabled in DMs)

**Rationale:** Public servers maintain a baseline level of civility through automatic filtering. DMs have filtering disabled to preserve freedom in private conversations.

### 9. Usernames Are User IDs (Case-Insensitive)

**Industry Standard:** Separate user IDs and display names
**RChat:** Username = unique identifier = login credential

**Rationale:** Simplicity. No hidden user IDs. What you see is what you get. Reduces cognitive overhead.

## Actual Security Measures

While RChat rejects user-protective security theater, it implements genuine anti-abuse measures:

- **Site-wide rate limiting:** 100 requests/second per IP (burst: 20)
- **Login throttling:** 3-second gap between attempts
- **Account locking:** 1000 failed logins = 24-hour lock
- **DOS protection:** tower-governor rate limiting layer
- **SQL injection protection:** Parameterized queries via SQLx
- **Site admin moderation:** Ban users (Site Ban), kick from servers (Server Ban), delete content

**Security exists to protect the platform, not to protect users from themselves.**

## Features

### Core Functionality

- **Servers & Channels:** Discord-like server/channel structure. Server names are case-insensitive IDs.
- **Direct Messages:** Private 1-on-1 conversations (including self-DM).
- **Real-time Updates:** WebSocket connections for live message delivery.
- **File Uploads:** Seamless drag-and-drop, images, documents (25MB max, auto-delete after 24h).
- **Guest Mode:** View any server without an account. LocalStorage saves your server list.
- **Profile Pictures:** Identicon or solid-color person icons (no uploads).

### Authentication

- **Text passwords:** Any length (including single character).
- **Word-based passwords:** Choose 7 words from a deterministic 20-word sequence.
  - Same username always gets same word set (SHA256-based).
  - Case-insensitive username normalization.

### Moderation

- **Server Admins:** Creator of the server. Can Server Ban (persistent kick), delete messages, manage channels.
- **Site Admins:** First registered user becomes site admin.
  - Can **Site Ban** users (deletes all messages + account site-wide).
  - Can moderate any server.

### Content Filtering

- **Profanity Filter:** rustrict library for automatic censoring.
  - Applied to: usernames, server names, channel names, public messages.
  - **Not applied to:** DMs, passwords.

## Technology Stack

### Backend (Rust)

- **Axum:** Web framework
- **SQLx:** Database interactions
- **SQLite:** Data storage (.db file)
- **tower-governor:** Rate limiting
- **WebSocket:** Real-time communication
- **rustrict:** Profanity filtering

### Frontend (Next.js)

- **React 19:** UI framework
- **Material-UI:** Component library (Google style)
- **WebSocket:** Real-time updates
- **LocalStorage:** Guest mode server preferences

### Deployment Architecture

Two-server setup where Rust is the main entry point:

- Rust server handles `/api` routes + WebSocket
- Next.js server handles UI rendering
- Rust proxies non-API requests to Next.js

## Installation & Setup

### Prerequisites

- Rust (latest stable)
- Node.js 18+
- Just (task runner)

### Environment Variables

Create `.env.local`:

```env
# Rust Server (Main Entry Point)
SERVER_PORT=3000
SERVER_HOST=127.0.0.1  # Use 0.0.0.0 for remote access

# Next.js Dev Server (Development Only)
PORT=3001
HOSTNAME=localhost  # Use 0.0.0.0 for remote access

# Security
SECRET_KEY=your-secret-key-here  # REQUIRED for JWT

# Logging
RUST_LOG=warn # Recommended for production to reduce noise
```

### Development

```bash
just src dev
```

Runs both servers:

- Rust: http://localhost:3000 (main entry point)
- Next.js dev: http://localhost:3001 (proxied)

### Production

```bash
just src prod
```

Runs optimized build:

- Rust serves static files from `.next/standalone`
- No Next.js dev server

### Docker

The easiest way to deploy RChat:

```bash
# Build and run with docker-compose
docker-compose up -d

# Or build manually
docker build -t rchat .
docker run -d \
  -p 3000:3000 \
  -e SECRET_KEY=your-secret-key \
  -v rchat-data:/app/data \
  -v rchat-uploads:/app/uploads \
  rchat
```

Access at http://localhost:3000

**Environment variables for Docker:**

| Variable      | Default    | Description        |
| ------------- | ---------- | ------------------ |
| `SECRET_KEY`  | (required) | JWT signing secret |
| `SERVER_PORT` | `3000`     | Port to expose     |
| `RUST_LOG`    | `info`     | Log level          |

**Volumes:**

- `/app/data` - SQLite database
- `/app/uploads` - Uploaded files (auto-deleted after 24h)

## Project Structure

```
rchat/
├── src/
│   ├── api/           # Axum route handlers
│   ├── models/        # Data structures
│   ├── services/      # Business logic
│   ├── middleware/    # Auth, rate limiting
│   ├── websocket/     # Real-time messaging
│   └── bin/server.rs  # Main entry point
├── app/
│   ├── components/    # React components
│   ├── lib/          # API clients, utilities
│   └── types/        # TypeScript types
├── migrations/        # SQL schema
└── public/           # Static assets
```

## Database Schema

Single SQLite file contains:

- `users` - Accounts (plaintext passwords via argon2 hash)
- `servers` - Chat servers
- `channels` - Server channels
- `messages` - All messages (server + DM)
- `direct_messages` - DM metadata
- `files` - Upload metadata
- `server_members` - Membership + roles
- `server_bans` - Server-specific bans
- `login_attempts` - Rate limiting data

## API Endpoints

### Public (No Auth)

- `GET /api/auth/word-sequence?username=X` - Get word list
- `POST /api/auth/register` - Create account
- `POST /api/auth/login` - Authenticate
- `GET /api/public/servers` - List all servers
- `POST /api/public/servers/lookup` - Lookup server by name
- `GET /api/public/servers/:id/channels` - Get channels
- `GET /api/public/channels/:id/messages` - Get messages
- `GET /api/public/servers/:id/members` - Get members
- `GET /api/downloads/:file_id` - Public file download

### Protected (Requires JWT)

- `POST /api/servers` - Create server
- `DELETE /api/servers/:id` - Delete server
- `POST /api/servers/:id/channels` - Create channel
- `DELETE /api/servers/:id/channels/:cid` - Delete channel
- `PATCH /api/servers/:id/channels/:cid` - Rename channel
- `DELETE /api/servers/:id/members/:username` - Server Ban user
- `PATCH /api/servers/:id/members/:username` - Grant admin
- `POST /api/dms` - Create/get DM
- `POST /api/messages` - Send message (Server or DM)
- `DELETE /api/channels/:cid/messages/:mid` - Delete channel message
- `DELETE /api/dms/:did/messages/:mid` - Delete DM message
- `POST /api/files` - Upload file
- `POST /api/users/:username/ban` - Site Ban user (site admin only)

### WebSocket

- `ws://localhost:3000/api/ws?token=JWT` - Real-time updates

## Word-Based Password System

Each username has a deterministic set of 20 words generated via:

```rust
SHA256(lowercase_username + iteration_index) → word_index
```

Properties:

- Same username always gets same words
- Case-insensitive (TestUser = testuser)
- No duplicates
- One-to-one mapping

Users select 7 words in order as their password.

## Deployment Notes

### For Remote Access (Codespaces, VPS)

1. Set `SERVER_HOST=0.0.0.0` in `.env.local`
2. In dev mode: Set `HOSTNAME=0.0.0.0` for Next.js
3. Access via http://your-host:3000
4. Optional: Use reverse proxy (nginx/Caddy) for HTTPS

### CORS Configuration

Rust server uses `AllowOrigin::mirror_request()` - dynamically mirrors incoming Origin header. Works with any origin without manual configuration.

### Production Checklist

- [ ] Set strong `SECRET_KEY` in production
- [ ] Configure `RUST_LOG` appropriately
- [ ] Run `just src prod` for optimized build
- [ ] Set up reverse proxy for HTTPS
- [ ] Ensure `.db` file has proper permissions
- [ ] Monitor rate limiting effectiveness

## Roadmap / Known Limitations

### Not Implemented (By Design)

- User profile pictures (file uploads)
- Message editing
- Message reactions
- Voice/video chat
- Email verification
- Password reset (no email system)
- Account recovery

### Future Enhancements

- Better mobile responsive design
- Notification system
- Search functionality
- Message history pagination
- Server categories

## Contributing

This is an educational/demonstration project showcasing intentionally unconventional design choices. Contributions should maintain the project's philosophy of:

- User freedom over protection
- Simplicity over features
- Transparency over privacy

## License

MIT

## Disclaimer

**RChat is not suitable for:**

- Confidential communication
- Business use
- Storing sensitive information
- Compliance-required environments (GDPR, HIPAA, etc.)

**Use RChat for:**

- Casual group chats
- Ephemeral coordination
- Learning about trade-offs in system design
- Environments where transparency is valued over privacy

By using RChat, you acknowledge that:

- All data is stored in plaintext
- Messages may be read by server operators
- Files are automatically deleted after 24 hours
- Accounts can be created with trivial passwords
- No privacy guarantees exist

**When in doubt, use Signal.**
