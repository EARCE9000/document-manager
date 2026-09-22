<!--
Docker Hub (https://hub.docker.com/r/earce9000/document-manager) の
"Repository overview" へ貼り付ける説明文。機能を追加したらここも更新し、Docker Hub側へ反映する。
貼り付けるのは、このコメントより下の本文すべて。

短い説明(Description)欄には次の1行を使う:
Self-hosted document manager with versioning, tagging, full-text/semantic search, and an API for AI agents.
-->

# Document Manager

Self-hosted document management service for single-file documents. Upload, preview, search, tag and version
HTML / MHTML / Markdown / PDF / images (SVG, PNG, JPEG) / CSV / TSV / text / log / JSON / draw.io files.
Built with Node.js (Express).

Runs as a single container by default (SQLite + local disk). Switching a few environment variables moves the
metadata to PostgreSQL and the files to S3 or GCS, so the same image also runs on AWS (ECS/Fargate) or
GCP (Cloud Run / GKE) with multiple instances.

Source and full documentation (Japanese): **https://github.com/EARCE9000/document-manager**

## Features

- **Preview in the browser** for every supported format. MHTML and Markdown are converted server-side, PDFs open in the browser's own viewer, and `.drawio` files use an image uploaded alongside them
- **Versioning** — upload a new version of an existing document: the old one is archived automatically and its tags and project placement are carried over. Documents uploaded separately can also be linked as versions afterwards
- **Related documents** — link documents to each other (no direction, no types); both sides show the link
- **Organize** — free-form tags, a tag tree, and projects with folders
- **Search** — full-text search over file names, tags, notes and extracted text (SQLite FTS5 trigram / PostgreSQL pg_trgm), plus optional **semantic search** via [Weaviate](https://weaviate.io/)
- **Archive instead of delete** — Gmail-style soft delete; documents can always be restored
- **Real-time updates** — the list refreshes and a popup appears when someone uploads, tags or archives a document (Server-Sent Events)
- **Authentication** — OpenID Connect (Entra ID, Cognito, Google, Synology SSO, …), an allow-list with admin / readwrite / readonly roles, and API keys for machine access
- **Audit trail** — access and audit logs on stdout, plus a per-user history screen
- **Made for AI agents** — a token-authenticated REST API, a machine-readable spec (`GET api/openapi.json`), a Markdown usage guide (`GET api/usage.md`), and a downloadable Agent Skill for Claude Code / OpenAI Codex / Google Antigravity

## Tags

- `latest` — built from the `main` branch on every push
- `YYYYMMDD_HHmmss` — build timestamp (Asia/Tokyo). Use this to pin a version or to roll back

Published for `linux/amd64` and `linux/arm64`.

## Quick start

```bash
docker run -d \
  --name document-manager \
  -p 8080:8080 \
  -v "$(pwd)/data:/data" \
  -e BASE_PATH="/" \
  -e OIDC_ISSUER="https://accounts.example.com" \
  -e OIDC_CLIENT_ID="<client id>" \
  -e OIDC_CLIENT_SECRET="<client secret>" \
  -e OIDC_REDIRECT_URI="https://docs.example.com/login" \
  -e ADMIN_EMAIL="admin@example.com" \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  earce9000/document-manager:latest
```

Then open `http://localhost:8080/`.

- Nobody can sign in until the allow-list has an entry. `ADMIN_EMAIL` is a self-healing bootstrap: that address
  becomes an admin on sign-in **only while no admin exists**, so you can never lock yourself out.
- `SESSION_SECRET` is the session signing key. If you leave it unset, a new one is generated on every start and
  everyone is signed out after a restart.
- To evaluate without an identity provider, add `-e AUTH_DISABLED=true`. Never use it in production.
- On Windows + Git Bash, prefix the command with `MSYS_NO_PATHCONV=1` so the `-v` path is not rewritten.

### Behind a reverse proxy

Set `BASE_PATH` to the public path prefix (`/` when the service owns the whole host, or e.g.
`/document_management` for a sub-path) and point `OIDC_REDIRECT_URI` at the public URL. The app builds
its own URLs from the request, so no other change is needed. Server-Sent Events are used for live
updates — if your proxy buffers responses, disable buffering for the app (`flushpackets=on` in Apache;
the app already sends `X-Accel-Buffering: no` for nginx).

### With semantic search (Weaviate)

Three containers: the app, Weaviate, and a self-hosted embedding server (no external API key needed).
Do not publish the Weaviate ports — anonymous access is enabled, so keep it on the internal network.

```yaml
services:
  app:
    image: earce9000/document-manager:latest
    restart: always
    ports:
      - "8080:8080"
    volumes:
      - ./data:/data
    environment:
      BASE_PATH: "/"
      OIDC_ISSUER: "https://accounts.example.com"
      OIDC_CLIENT_ID: "<client id>"
      OIDC_CLIENT_SECRET: "<client secret>"
      OIDC_REDIRECT_URI: "https://docs.example.com/login"
      ADMIN_EMAIL: "admin@example.com"
      SESSION_SECRET: "<openssl rand -hex 32>"
      WEAVIATE_URL: "http://weaviate:8080"
      WEAVIATE_GRPC_PORT: "50051"
    depends_on:
      - weaviate

  weaviate:
    image: docker.io/semitechnologies/weaviate:latest
    restart: always
    environment:
      AUTHENTICATION_ANONYMOUS_ACCESS_ENABLED: "true"
      PERSISTENCE_DATA_PATH: /var/lib/weaviate
      ENABLE_MODULES: text2vec-transformers,text2vec-cohere,text2vec-openai,text2vec-aws
      DEFAULT_VECTORIZER_MODULE: text2vec-transformers
      TRANSFORMERS_INFERENCE_API: http://t2v-transformers:8080
      CLUSTER_HOSTNAME: node1
    volumes:
      - weaviate_data:/var/lib/weaviate
    depends_on:
      - t2v-transformers

  t2v-transformers:
    image: docker.io/semitechnologies/transformers-inference:sentence-transformers-paraphrase-multilingual-mpnet-base-v2
    restart: always
    environment:
      ENABLE_CUDA: "0"

volumes:
  weaviate_data:
```

Documents already stored are indexed in the background when Weaviate is first enabled (a few seconds per
document; progress is shown on the "ベクトル索引" screen). Expect roughly 1.0–1.4 GB of memory for the
embedding server, which uses several CPU cores while indexing.

Instead of the self-hosted embedding server you can use Cohere, OpenAI or Cohere on AWS Bedrock by setting
`WEAVIATE_VECTORIZER` and the matching credentials; the credentials are passed through to Weaviate per request
and never stored in the database.

A ready-made deployment file (podman, fixed container IP, no published Weaviate ports) is in the repository:
[`deploy/compose.yml`](https://github.com/EARCE9000/document-manager/blob/main/deploy/compose.yml).

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `OIDC_ISSUER` | (required) | OpenID Connect issuer URL |
| `OIDC_CLIENT_ID` | (required) | Client ID |
| `OIDC_CLIENT_SECRET` | (empty) | Client secret (omit for public clients) |
| `OIDC_REDIRECT_URI` | (required) | Callback URL, also registered with the provider |
| `OIDC_SCOPE` | `openid profile email` | Requested scopes |
| `OIDC_USERNAME_CLAIM` | `email` | Claim used as the user identifier |
| `ADMIN_EMAIL` | (unset) | Bootstrap admin, active only while no admin exists |
| `SESSION_SECRET` | (random) | Session signing key — set it explicitly |
| `SESSION_MAX_AGE_HOURS` | `8` | Session lifetime |
| `AUTH_DISABLED` | (unset) | `true` bypasses authentication (development only) |
| `LISTEN_PORT` | `8080` | Listening port |
| `BASE_PATH` | `/document_management` | Public path prefix behind a reverse proxy |
| `DATA_DIR` | `/data` | SQLite database, and document files when storage is local |
| `DATABASE_BACKEND` | `sqlite` | `sqlite` or `postgres` (required for multiple instances) |
| `DATABASE_URL` | (unset) | PostgreSQL connection string (or use the standard `PG*` variables) |
| `DATABASE_SSL` | (unset) | `true` to use TLS for PostgreSQL |
| `STORAGE_BACKEND` | `local` | `local`, `s3` or `gcs` |
| `S3_BUCKET` / `S3_REGION` / `S3_PREFIX` / `S3_ENDPOINT` | — | S3 settings (`S3_ENDPOINT` for MinIO and other S3-compatible services) |
| `GCS_BUCKET` / `GCS_PREFIX` | — | Google Cloud Storage settings |
| `WEAVIATE_URL` | (unset) | Enables semantic search when set |
| `WEAVIATE_GRPC_PORT` | `50051` | Weaviate gRPC port |
| `WEAVIATE_VECTORIZER` | `text2vec-transformers` | Embedding provider (`text2vec-cohere` / `text2vec-openai` / `text2vec-aws` also supported) |
| `UPLOAD_MAX_BYTES` | `268435456` | Upload size limit per file (256MB); larger uploads get a 413 |
| `CONTENT_TEXT_MAX_CHARS` | `300000` | How much extracted text is kept for search; the rest is not searchable (files are stored in full) |
| `LOG_LEVEL` | `info` | Log level (pino) |
| `TZ` | (host) | Time zone, e.g. `Asia/Tokyo` |

Credentials for S3 follow the AWS SDK credential chain (IAM roles first); GCS follows Application Default
Credentials. The repository README lists every variable, including the semantic-search tuning options.

## Data, upgrades and rollback

- Mount `/data` to keep the documents and the SQLite database.
- The SQLite schema is versioned. On upgrade the app creates a new database file and copies the data across,
  **leaving the previous file in place** so you can go back to an older image. Back up `/data/db` before upgrading.
- With `DATABASE_BACKEND=postgres`, migrations are applied automatically at startup.
- Note that documents added *after* an upgrade are not visible if you roll back to an older image, because the
  older image reads the older database file.

## License

MIT
