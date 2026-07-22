# SibyX

**A private, end-to-end encrypted relay for individuals, small teams, and small organizations.**

SibyX is communication infrastructure *you* can control. Messages are end-to-end encrypted; the relay only ever forwards ciphertext and **can never read your content**. No phone number, no account — your keypair *is* your identity.

## Why SibyX
- **Private relay.** A self-contained encrypted relay. Stop routing sensitive internal talk through opaque public platforms.
- **End-to-end encryption by default.** The relay only stores and forwards ciphertext; message content is unreadable to the server.
- **Key = identity.** Keys are generated locally in your browser (ECDSA for signing, ECDH for encryption). No sign-up, no phone number, no password to leak.
- **Clear data boundary.** You decide what stays client-side vs. relay-side. Cryptography, private keys, and private-channel keys never touch a server.
- **Self-hostable.** Run your own relay on a small VPS, or use SibyX-hosted. Same client — your choice.

## Who it's for
- **Individuals** who want private chat without handing over a phone number.
- **Small teams** (a few to a few hundred) needing controllable, encrypted internal comms.
- **Small organizations** wanting a private relay instead of a public-platform dependency.

## Hosting: your relay, your rules
| | SibyX-hosted | Self-hosted |
|---|---|---|
| Setup | Zero — just open the app | Deploy `relay.js` + `server.js` on a VPS |
| Data | On the SibyX relay (still E2EE; relay can't read) | Fully on your infra, clear boundary |
| Best for | Quick start, individuals | Teams/orgs wanting full control |

Either way, the relay is **private** — it reduces your dependence on public platforms and keeps message content end-to-end encrypted.

## Features
- **Channels** — signed (not encrypted) public rooms.
- **Private DMs** — ECDH-derived AES-GCM end-to-end encryption.
- **Friends** — exchange public keys; encryption stays client-side.
- **External storage (Pro)** — large attachments as encrypted objects; server sees only ciphertext pointers.
- **4-tier service** — Demo / Starter / Pro / VIP, selected by a signed license token (`SIBYX1.*`).
- **Invite → Pro** — invite colleagues to earn a free Pro tier (3 invited friends each sending >3 messages → 30 days Pro).

## Architecture
- **Client:** pure static SPA (`app.js`, `index.html`, `styles.css`), minified by `build.cjs`.
- **Relay (optional but recommended):** GunDB peer + `relay.js` for 24/7 relay and license verification. Host it yourself or use SibyX-hosted.
- **Host:** `web3chat-e6or.onrender.com` runs `server.js` (Express static + `/healthz` + `/gun` proxy + API) and the Gun peer.

## Run / deploy
```bash
# source repo (D:/chat4): edit then build
node build.cjs            # -> outputs into the deploy repo
# deploy repo (D:/web3chat): push to GitHub, Render auto-redeploys
git push origin main
```
Host environment requirement: `SIBYX_SECRET` (must match the relay's secret, else issued Pro tokens are rejected).

## License
MIT — see the [LICENSE](./LICENSE) file. Copyright (c) 2026 SibyX & Fan Litao.
