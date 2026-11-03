# KeyNest (钥巢)

> A local-first password manager for Windows, written in Rust.

**KeyNest is free, open source, and has no accounts, no cloud sync, and no network code.**
Your entire vault is a single encrypted file on your own disk.

> ⚠️ **This project has not been independently security-audited.**
> Everything below describes what the code actually does and can be verified by reading
> [`rust/keynest-core/src/vault.rs`](rust/keynest-core/src/vault.rs).
> "Can be verified" is not the same as "has been audited". Please evaluate it yourself
> before trusting it with important credentials.

---

## What is KeyNest

A desktop password manager that stores all of your entries in one encrypted file.
Unlocking it requires a master password that is never written to disk, never transmitted,
and cannot be recovered.

Three design rules:

1. **Your data is yours.** The vault is a local file. You can export it to CSV/JSON at any
   time, or copy an encrypted backup to another machine. There is no account binding.
2. **No network.** The dependency tree contains no HTTP client. This is not a "disabled by
   default" feature — the code simply does not exist.
3. **Limits are stated up front.** See [Security design](#security-design) and
   [Limitations](#limitations). If something is not protected, this document says so.

---

## Features

**Vault**

- Master-password unlock, idle auto-lock (uses the shorter of app-idle and system-idle)
- Entries with title, username, password, URL, category, notes
- Entry types: login, note, card, identity — and user-defined types with field templates
- Custom fields (user-defined key/value pairs, each length-bounded with a live
  character counter), each can be individually masked
- Search across title, username, URL, notes, category, type and custom field values
- Category and type management (add / rename / delete, kept consistent with entries)
- Favorites, and a recycle bin (soft delete → restore or permanently delete)
- TOTP (RFC 6238) with `otpauth://` URIs and Base32 secrets; SHA-1/256/512, 6–8 digits

**Data in and out**

- Export CSV (Bitwarden-compatible column layout) and JSON (lossless)
- Export an encrypted backup, verified by reading it back byte-for-byte
- Import CSV/JSON from Chrome, Edge, Firefox, Bitwarden — **adds only, never overwrites**
- Plaintext export requires an explicit confirmation step

**Security mechanisms**

- Argon2id key derivation, XChaCha20-Poly1305 authenticated encryption, separate DEK/KEK
- Changing the master password only re-wraps the 32-byte data key; the body ciphertext is
  left byte-identical
- Keys locked into physical memory (`VirtualLock`) to keep them out of the page file
- Single-instance lock and external-change detection
- Atomic writes with five backup generations

---

## Installation

KeyNest ships as a **single portable executable**. There is no installer.

1. Download `KeyNest.exe` from the Releases page.
2. Verify it against the published `SHA256SUMS`:

   ```bat
   certutil -hashfile KeyNest.exe SHA256
   ```

3. Double-click it.

- No administrator rights required.
- Nothing is written to the registry.
- Uninstalling = deleting the executable. **This does not delete your vault** — see below.

Requires 64-bit Windows. The cryptography core builds and is tested on Linux and macOS,
but clipboard protection and system-idle detection are Win32-only; on other platforms
those features report "unsupported" rather than silently degrading.

---

## Security design

### Key hierarchy (format v3)

```text
master password ──Argon2id(64 MiB, t=3, p=1, 16-byte random salt)──> KEK
                                                                      │
                                    XChaCha20-Poly1305 (AAD binds KDF params + salt)
                                                                      ↓
                                                     wraps a random 32-byte DEK
                                                                      │
                                          XChaCha20-Poly1305 (fresh 24-byte nonce per save)
                                                                      ↓
                                                                 vault body
```

| Property | Why it matters |
| --- | --- |
| No password hash is stored | Verification happens through the AEAD tag; nothing extra is exposed to offline guessing |
| AAD binds format, algorithm, KDF params and salt | Tampering with any of them makes decryption fail — downgrade attempts are rejected |
| DEK / KEK separation | Changing the master password rewrites only the 32-byte wrap, not the whole vault |
| Fresh random nonce per save | 24-byte random nonces; collision risk is negligible |
| Salt, nonce and DEK all come from the OS CSPRNG | `getrandom` directly, no user-space PRNG in the path |
| Keys in page-aligned memory under `VirtualLock` | Keeps them out of the page file, hibernation image and crash dumps |
| `Zeroize` + custom `Drop` | Entries, keys and plaintext buffers are wiped when they go out of scope |
| Hand-written `Debug` | Formatting an entry prints `<redacted>` instead of the password |

Older formats remain readable: v1 (scrypt N=2^17 + AES-256-GCM) and v2 (Argon2id +
XChaCha20-Poly1305). A vault can be upgraded to v3 from the settings screen; the upgrade
keeps a rollback copy and verifies before committing.

### On-disk behaviour

| Mechanism | Purpose |
| --- | --- |
| Temp file → `fsync` → `rename` | A power loss never leaves a half-written vault |
| Previous version rotated into `.bak.1..5` | Every save leaves at least one recoverable older copy |
| Backup slot is only taken by a structurally valid file | A corrupt file cannot displace a good backup |
| Disk fingerprint compared before saving | Detects external modification instead of overwriting it |
| Single-instance lock (`File::try_lock`) | Two processes holding plaintext and overwriting each other is the fastest way to lose data |
| Key-independent validation before decryption | "The file is corrupt" is never disguised as "wrong password" |

---

## Data storage

| Priority | Location |
| --- | --- |
| 1 | `%KEYNEST_DATA_DIR%` if set (portable / testing) |
| 2 | `%APPDATA%\KeyNest\vault.dat` if it already exists (legacy location) |
| 3 | `%LOCALAPPDATA%\KeyNest\vault.dat` (default) |

`%LOCALAPPDATA%` is preferred over `%APPDATA%` on purpose: roaming profiles can be copied
to other machines in a domain environment, which spreads an encrypted vault to places the
user did not intend.

Also in that directory:

- `vault.dat.bak.1` … `vault.dat.bak.5` — the five most recent backups
- `vault.lock` — single-instance lock file (empty; the lock is held by the OS)
- `vault.dat.corrupt-<timestamp>` — a damaged vault preserved during recovery (never deleted)

---

## Backup and recovery

- **Encrypted backup**: Settings → Data → *Export encrypted backup*. The file is verified by
  reading it back and comparing bytes.
- **Automatic backups**: the previous vault is rotated into `.bak.1` on every save.
- **Recovery**: if the vault is detected as corrupt, the unlock screen offers the available
  backups. Restoring authenticates first, then renames the damaged file aside — it is never
  deleted.

**Two things you must understand:**

1. **Changing the master password does not invalidate old backups.** Existing `.bak.*` files
   are still protected by the *previous* password. If you suspect a leak, change the password
   **and** destroy the old backups.
2. **Backups in cloud storage keep history.** A synced folder retains older versions, and
   those versions remain openable with the password that was in effect at the time.

---

## Browser extension setup

After loading the extension, one more step is required — the browser bridge
has to be registered:

1. Open the extension popup and copy the **extension ID** it shows.
2. KeyNest → Settings → Browser → paste the ID → click "Install".
3. Reload a browser tab.

Step 2 copies the messaging host into `%LOCALAPPDATA%\KeyNestin\` and writes
two registry values under the current user (one for Chrome, one for Edge).
**No administrator rights are needed**, and uninstalling removes only those two
values.

> Why this is necessary: the browser only finds a Native Messaging host through
> the registry, and the manifest must name the **exact** extension ID. An
> extension that isn't published to a store has an ID derived from the hash of
> its install path, so it differs on every machine — the desktop program cannot
> guess it and has to be told.

## Limitations

- Windows x64 only for now.
- **No independent security audit has been performed.**
- No internationalisation: the interface is Simplified Chinese only.
- TOTP secrets must be pasted; there is no QR-code scanning.
- Custom fields are exported to JSON but **not** to CSV (Bitwarden's `fields` column uses a
  private serialisation format).
- No browser autofill.
- Rollback attacks (replacing `vault.dat` with an older copy) cannot be detected.
- Plaintext exports are unencrypted by nature; the program can warn, but cannot protect the
  file afterwards.
- The UI has no end-to-end click tests; behaviour is covered by unit tests and by rendering
  screenshots, not by GUI automation.

---

## Security disclaimer

- This software has **not** been independently audited by a third party.
- It has not been certified under any standard.
- No cryptographic algorithm in this project is original work: it uses RustCrypto crates.
- The security of your vault ultimately depends on the strength of your master password.
  Argon2id raises the cost of offline guessing; it does not eliminate it.
- The author makes no warranty. Keep an independent backup of anything you cannot afford
  to lose.

If you find a security issue, please follow [SECURITY.md](SECURITY.md) and report it
privately.

---

## Building from source

Requires Rust 1.89 or newer (uses `File::try_lock` from the standard library).

```bash
cd rust
cargo build --release -p keynest-egui
# output: rust/target/release/keynest-egui.exe
```

Checks used by CI:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo deny check
```

---

## License

Dual-licensed, choose either:

- [MIT](LICENSE-MIT)
- [Apache-2.0](LICENSE-APACHE)

Bundled fonts from egui are under SIL OFL-1.1 / Ubuntu-font-1.0; redistributing the binary
requires keeping their license notices.
