# Security and trust

Treat task text, repository metadata and provider output as untrusted input. These packages enforce workflow contracts; they are not an operating-system sandbox. Caller callbacks and reviewer identity are trusted integration boundaries. Use least-privilege credentials, a restricted process/container for live workers, and external locking for multiple writers where documented.

Do not put a secret or exploit containing private data in a public issue. Report non-sensitive reproduction steps through the repository issue tracker, or use GitHub private vulnerability reporting when available.
