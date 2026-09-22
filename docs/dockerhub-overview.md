<!--
Docker Hub (https://hub.docker.com/r/earce9000/document-manager) の
"Repository overview" へ貼り付ける説明文。機能を追加したらここも更新し、Docker Hub側へ反映する。
短い説明(Description)欄には、この下の "Short description" の1行を使う。

Short description:
Self-hosted document manager with versioning, tagging, full-text/semantic search, and an API for AI agents.
-->

# Document Manager

Self-hosted document management service for single-file documents. Upload, preview, search, tag and version
HTML / MHTML / Markdown / PDF / images (SVG, PNG, JPEG) / CSV / TSV / text / log / JSON / draw.io files.
Built with Node.js (Express).

Source and full documentation (Japanese): **https://github.com/EARCE9000/document-manager**

## Features

- **Preview in the browser** for every supported format (MHTML and Markdown are converted server-side; `.drawio` uses an image you upload alongside it)
- **Versioning** — upload a new version of an existing document: the old one is archived automatically and its tags and project placement are carried over. Existing documents can also be linked as versions after the fact
- **Related documents** — link documents to each other (no direction, no types); both sides show the link
- **Organize** — free-form tags, a tag tree, and projects with folders
- **Search** — full-text search over file names and extracted text (SQLite FTS5 trigram / PostgreSQL pg_trgm), plus optional **semantic search** via [Weaviate](https://weaviate.io/)
- **Archive instead of delete** — Gmail-style soft delete; documents can always be restored
- **Real-time updates** — list refresh and desktop-style popups when someone uploads, tags or archives a document (Server-Sent Events)
- **Authentication** — OpenID Connect (Entra ID, Cognito, Google, Synology SSO, …), an allow-list with admin / readwrite / readonly roles, and API keys for machine access
- **Made for AI agents** — a token-authenticated REST API, a machine-readable spec (`GET api/openapi.json`), a Markdown usage guide (`GET api/usage.md`), and a downloadable Agent Skill for Claude Code / OpenAI Codex / Google Antigravity

## Tags

- `latest` — built from the `main` branch on every push
- `YYYYMMDD_HHmmss` — build timestamp (Asia/Tokyo). Use this to pin a version or roll back

Images are published for `linux/amd64` and `linux/arm64`.

## Quick start

```bash
docker run -d \
  --name document-manager \
  -p 8080:8080 \
  -v "$(pwd)/data:/data" \
  -e OIDC_ISSUER="https://accounts.example.com" \
  -e OIDC_CLIENT_ID="<client id>" \
  -e OIDC_CLIENT_SECRET="<client secret>" \
  -e OIDC_REDIRECT_URI="https://docs.example.com/login" \
  -e ADMIN_EMAIL="admin@example.com" \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  earce9000/document-manager:latest
```

Open `http://localhost:8080/`. The first sign-in with `ADMIN_EMAIL` bootstraps an admin account.
For local evaluation without an identity provider, add `-e AUTH_DISABLED=true` (never in production).

With semantic search (three containers: app + Weaviate + embedding server), see
[`deploy/compose.yml`](https://github.com/EARCE9000/document-manager/blob/main/deploy/compose.yml)
in the repository.

## Main environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_REDIRECT_URI` | (required) | OpenID Connect provider settings |
| `ADMIN_EMAIL` | (unset) | Self-healing bootstrap: signs in as admin only while no admin exists |
| `SESSION_SECRET` | (random) | Session signing key. Set it, or everyone is signed out on restart |
| `BASE_PATH` | `/document_management` | Public path prefix when served behind a reverse proxy |
| `DATA_DIR` | `/data` | SQLite database and, with local storage, the document files |
| `DATABASE_BACKEND` | `sqlite` | `sqlite` or `postgres` (required for multiple instances) |
| `STORAGE_BACKEND` | `local` | `local`, `s3` or `gcs` |
| `WEAVIATE_URL` | (unset) | Enables semantic search when set |
| `UPLOAD_MAX_BYTES` | `268435456` | Upload size limit (256MB) |
| `AUTH_DISABLED` | (unset) | Bypasses authentication — development only |

The full list is in the repository README.

## Data and upgrades

- Mount `/data` to keep documents and the SQLite database.
- The SQLite schema is versioned. On upgrade the app creates a new database file and copies the data over,
  leaving the previous file in place so you can roll back. Back up `/data/db` before upgrading.
- With `DATABASE_BACKEND=postgres`, schema migrations are applied automatically at startup.

## License

MIT
