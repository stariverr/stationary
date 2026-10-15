# Ownership, Sharing and Teams

This document fixes how resources are owned, how they are shared, and how teams will fit in. It matters most for resources that cost money or hold credentials, such as AI providers.

## 1. Ownership vs. Access

Two different questions:

- **Ownership**: who holds a resource, pays for it, manages its credentials, and keeps it when people come and go.
- **Access**: who may use a resource that someone else owns.

Ownership is a single column on the resource. Access is granted through separate tables (`LibraryUserAccess`, `LibraryGroupAccess`, see [system_design.md §5](system_design.md)). The two are never mixed: granting access never transfers ownership.

## 2. Current Model

- A user owns libraries (`library.owner_id`).
- Account-level resources are owned by **the same principal** that owns libraries. Today this is the user.
- AI providers (`ai_provider.owner_id`) and their models belong to that owner and are shared by all of the owner's libraries.
- A library only stores which models fill its roles (`library.ai_bindings`).

### Rule: credentials follow the library owner

A library may only bind models whose provider has the same owner as the library. `resolveBindingConfig` enforces this on every resolution, so a binding that violates it is ignored at runtime and rejected when saved.

Consequences:

- Anyone allowed to process media in a library (for example an `EDITOR` collaborator) uses the owner's provider and the owner pays. This is intended: the owner decided to enable AI for the library.
- Only the owner can add, edit or delete providers and models, or change a library's bindings.
- Account-level routes reject library-scoped API tokens.

## 3. Credentials

- API keys are encrypted at rest with AES-256-GCM using `SECRETS_ENCRYPTION_KEY` (32 bytes, base64). Ciphertexts carry a version prefix (`v1:`).
- Plaintext keys never leave the server. Responses carry a hint (`••••abcd`) only. Editing a provider without a new key keeps the stored one.
- Every environment that shares a database must use the same `SECRETS_ENCRYPTION_KEY`. Changing it makes stored keys unreadable; they must be entered again.
- Provider URLs are entered by users and requested by the server, so by default they may not point at private networks (loopback, LAN, link-local addresses including cloud metadata endpoints). Addresses are resolved and checked when a provider is saved and before every request, and redirects are refused. Self-hosted model servers (Ollama, vLLM, etc.) need `AI_ALLOW_PRIVATE_NETWORK=true`. Provider error bodies are echoed only when they are JSON.

## 4. Teams (planned)

Teams will **own** libraries, following the account model used by GitHub organizations, Vercel teams and Linear workspaces:

- Every user has a personal account; a team is also an account.
- Libraries, AI providers and future billing/quotas belong to an account (`account_id`).
- Members act on the team's resources through roles. Team admins manage providers and credentials; members use them.
- The sharing tables remain for granting access to people outside the owning account.

Sharing alone is not enough for teams because it cannot answer:

1. **What happens when a member leaves.** If a person owns the library, the library, its providers and its keys leave with them.
2. **Who pays.** AI processing is an ongoing cost; it needs an owner whose usage and quota can be tracked, not whichever member happens to own the library.
3. **Who administers.** Rotating keys, changing models and deleting libraries need a team admin role, which sharing does not express.

### What stays fixed until then

- No account abstraction is built before teams exist. Ownership remains `owner_id`, with the same meaning on every owned table.
- When teams are introduced, `library.owner_id` and `ai_provider.owner_id` are replaced by `account_id` together (existing rows point to the owner's personal account). Because both columns follow one rule, this is a mechanical migration.
- A team library can never use a personal provider. Personal keys would break when the member leaves and could not be rotated by admins.
- Moving a library to another account requires choosing models from the new owner's providers. Existing vectors stay valid when the new provider serves the same model, because embedding space IDs do not include the provider (see [ai_hybrid_search.md §2.1](ai_hybrid_search.md)).
